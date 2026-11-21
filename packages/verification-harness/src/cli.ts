import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FAULT_LABEL,
  FaultName,
  VERIFY_EXIT_CODES,
  VerifyRequest,
  type GateId,
} from '@lathe/shared-contracts';
import type { Gate } from './gate.js';
import { harnessHash, hashTree } from './hash.js';
import { defaultGates } from './registry.js';
import { runVerification } from './runner.js';

export const USAGE =
  'usage: lathe-verify <app> --worktree <dir> --commit <sha> --report <file> [--patch <file>] [--fault drop-tenant-filter]';
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const KNOWN_FLAGS = new Set(['--worktree', '--commit', '--report', '--patch', '--fault']);
/** Same limit as `Patch.diff` in contract C2. */
const MAX_PATCH_BYTES = 5_000_000;

export interface CliDeps {
  readonly gates?: Readonly<Record<GateId, Gate>>;
  readonly now?: () => Date;
  readonly stderr?: (line: string) => void;
  readonly harnessDir?: string;
  readonly policyDir?: string;
}

interface CliArgs {
  readonly app: string;
  readonly worktree: string;
  readonly commit: string;
  readonly report: string;
  readonly patch: string | null;
  readonly fault: string | null;
}

/** Parses argv. Returns an error message instead of throwing. */
export function parseArgs(argv: readonly string[]): CliArgs | string {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (!KNOWN_FLAGS.has(arg)) return `unknown flag ${arg}`;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return `missing value for ${arg}`;
    if (flags.has(arg)) return `duplicate flag ${arg}`;
    flags.set(arg, value);
    i++;
  }
  const [app, ...extra] = positional;
  if (app === undefined || extra.length > 0) return 'expected exactly one <app>';
  const worktree = flags.get('--worktree');
  const commit = flags.get('--commit');
  const report = flags.get('--report');
  if (!worktree || !commit || !report) return 'missing --worktree, --commit or --report';
  return {
    app,
    worktree,
    commit,
    report,
    patch: flags.get('--patch') ?? null,
    fault: flags.get('--fault') ?? null,
  };
}

/** `lathe-verify` entry point. Returns the process exit code from `VERIFY_EXIT_CODES`. */
export async function main(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    stderr(`${args}\n${USAGE}`);
    return VERIFY_EXIT_CODES.error;
  }
  const fault = args.fault === null ? null : FaultName.safeParse(args.fault);
  if (fault !== null && !fault.success) {
    stderr(`unknown fault ${args.fault ?? ''}`);
    return VERIFY_EXIT_CODES.error;
  }
  const request = VerifyRequest.safeParse({
    app: args.app,
    worktree: args.worktree,
    commit: args.commit,
    faultInjection: fault === null ? null : { name: fault.data, label: FAULT_LABEL },
  });
  if (!request.success) {
    stderr(
      `invalid arguments: ${request.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
    return VERIFY_EXIT_CODES.error;
  }
  let patch: string | null = null;
  if (args.patch !== null) {
    try {
      const bytes = await readFile(resolve(args.patch));
      if (bytes.byteLength > MAX_PATCH_BYTES) {
        stderr(`patch is larger than ${MAX_PATCH_BYTES} bytes`);
        return VERIFY_EXIT_CODES.error;
      }
      patch = bytes.toString('utf8');
    } catch (error) {
      stderr(`cannot read patch: ${error instanceof Error ? error.message : String(error)}`);
      return VERIFY_EXIT_CODES.error;
    }
  }
  const policyDir = deps.policyDir ?? resolve(PACKAGE_DIR, 'policies');
  const report = await runVerification({
    ...request.data,
    patch,
    gates: deps.gates ?? defaultGates(policyDir),
    harnessSha256: deps.harnessDir
      ? await hashTree(deps.harnessDir)
      : await harnessHash(PACKAGE_DIR),
    policySha256: await hashTree(policyDir),
    now: deps.now ?? (() => new Date()),
  });
  const reportPath = resolve(args.report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  stderr(
    `lathe-verify: ${report.overall} (${report.gates.map((g) => `${g.gate}=${g.status}`).join(', ')})`,
  );
  return VERIFY_EXIT_CODES[report.overall];
}
