import { readFile } from 'node:fs/promises';
import { RepoRelativePath, type Finding } from '@lathe/shared-contracts';
import { z } from 'zod';
import type { Gate, GateOutcome } from '../gate.js';
import { parsePatch } from './patch-parser.js';

/** `policies/protected-paths.json`. Entries ending in `/` protect a directory, others one file. */
export const ProtectedPathsPolicy = z.strictObject({
  version: z.literal(1),
  protected: z.array(z.string().min(1).max(200)).min(1),
  rejectSymlinks: z.boolean(),
  rejectSubmodules: z.boolean(),
});
export type ProtectedPathsPolicy = z.infer<typeof ProtectedPathsPolicy>;

export const RULES = {
  protected: 'protected-paths.protected',
  traversal: 'protected-paths.traversal',
  invalid: 'protected-paths.invalid-path',
  symlink: 'protected-paths.symlink',
  submodule: 'protected-paths.submodule',
  unparseable: 'protected-paths.unparseable',
  truncated: 'protected-paths.truncated',
} as const;

const MAX_FINDINGS = 1000;
const MAX_MESSAGE = 2000;
const show = (path: string): string => JSON.stringify(path).slice(0, 300);

/**
 * Folds a path the way case-insensitive file systems and Windows see it
 * (Unicode compatibility form, lowercase, trailing dots and spaces removed per
 * segment), so `.GitHub/` or `.github./` cannot slip past the policy.
 */
export function foldPath(path: string): string {
  return path
    .normalize('NFKC')
    .split('/')
    .map((s) => s.replace(/[. ]+$/, '').toLowerCase())
    .join('/');
}

function pathIssue(path: string): 'traversal' | 'invalid' | null {
  const control = [...path].some((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp < 0x20 || cp === 0x7f;
  });
  if (control || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path))
    return 'invalid';
  const segments = path.split('/');
  if (segments.includes('..')) return 'traversal';
  if (segments.some((s) => s === '' || s === '.')) return 'invalid';
  return null;
}

function protectedBy(path: string, policy: ProtectedPathsPolicy): string | null {
  const folded = foldPath(path);
  for (const entry of policy.protected) {
    const isDir = entry.endsWith('/');
    const e = foldPath(isDir ? entry.slice(0, -1) : entry);
    if (folded === e || (isDir && folded.startsWith(`${e}/`))) return entry;
  }
  return null;
}

/** Findings for a patch: protected paths, traversal, invalid paths, symlinks, submodules, unparseable input. */
export function checkPatch(diff: string, policy: ProtectedPathsPolicy): Finding[] {
  const parsed = parsePatch(diff);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (
    ruleId: string,
    message: string,
    path?: string,
    severity: Finding['severity'] = 'critical',
  ) => {
    const key = `${ruleId}|${path ?? message}`;
    if (seen.has(key)) return;
    seen.add(key);
    const finding: Finding = { ruleId, severity, message: message.slice(0, MAX_MESSAGE) };
    findings.push(
      path !== undefined && RepoRelativePath.safeParse(path).success
        ? { ...finding, path }
        : finding,
    );
  };
  for (const p of parsed.problems)
    add(RULES.unparseable, `patch cannot be parsed safely: ${p}`, undefined, 'high');
  for (const file of parsed.files) {
    for (const path of file.paths) {
      const issue = pathIssue(path);
      if (issue === 'traversal') add(RULES.traversal, `path ${show(path)} contains ".."`);
      else if (issue === 'invalid')
        add(RULES.invalid, `path ${show(path)} is not a clean repository-relative path`);
      else {
        const entry = protectedBy(path, policy);
        if (entry !== null)
          add(
            RULES.protected,
            `patch touches protected path ${show(path)} (policy entry ${entry})`,
            path,
          );
      }
    }
    const target = file.paths.at(-1);
    for (const mode of file.modes) {
      if (mode === '120000' && policy.rejectSymlinks)
        add(RULES.symlink, `patch creates a symbolic link at ${show(target ?? '')}`, target);
      if (mode === '160000' && policy.rejectSubmodules)
        add(RULES.submodule, `patch adds a submodule at ${show(target ?? '')}`, target);
    }
  }
  if (findings.length <= MAX_FINDINGS) return findings;
  return [
    ...findings.slice(0, MAX_FINDINGS - 1),
    {
      ruleId: RULES.truncated,
      severity: 'info',
      message: `${findings.length - MAX_FINDINGS + 1} more findings not shown`,
    },
  ];
}

export async function loadPolicy(file: string): Promise<ProtectedPathsPolicy> {
  return ProtectedPathsPolicy.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

const error = (summary: string): GateOutcome => ({
  status: 'error',
  summary,
  findings: [],
  artifacts: [],
});

/** Gate 1 (P2-02): rejects any agent patch that touches a protected path. */
export function protectedPathsGate(policyFile: string): Gate {
  return {
    id: 'protected-paths',
    async run(ctx) {
      if (ctx.patch === null)
        return error(
          'no patch given (lathe-verify --patch <file>); this gate cannot pass without one',
        );
      let policy: ProtectedPathsPolicy;
      try {
        policy = await loadPolicy(policyFile);
      } catch (e) {
        return error(
          `protected-paths policy unreadable: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const findings = checkPatch(ctx.patch, policy);
      const files = parsePatch(ctx.patch).files.length;
      return findings.length > 0
        ? {
            status: 'failed',
            summary: `${findings.length} finding(s) in a patch of ${files} file(s)`,
            findings,
            artifacts: [],
          }
        : {
            status: 'passed',
            summary: `${files} file(s) checked, no protected path touched`,
            findings: [],
            artifacts: [],
          };
    },
  };
}
