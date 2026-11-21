import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { GateId, GateStatus } from '@lathe/shared-contracts';

const SKIP = new Set(['node_modules', '.git']);

export const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Hash of a directory: sha256 over `<file sha256>  <path>` lines, one per file,
 * sorted by path, with paths relative to `root` using `/`. Skips `node_modules`
 * and `.git`; symbolic links are not followed.
 */
export async function hashTree(root: string): Promise<string> {
  const files = await listFiles(root);
  const rows = await Promise.all(
    files.map(async (f) => ({
      path: relative(root, f).split(sep).join('/'),
      hash: sha256(await readFile(f)),
    })),
  );
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(rows.map((r) => `${r.hash}  ${r.path}\n`).join(''));
}

/** `resultHash` exactly as documented in contract C3 (`gates.ts`). */
export function resultHash(input: {
  readonly commit: string;
  readonly harnessSha256: string;
  readonly policySha256: string;
  readonly gates: readonly { readonly gate: GateId; readonly status: GateStatus }[];
}): string {
  const lines = [
    'lathe-verify/v1',
    input.commit,
    input.harnessSha256,
    input.policySha256,
    ...input.gates.map((g) => `${g.gate}=${g.status}`),
  ];
  return sha256(lines.join('\n') + '\n');
}

/**
 * `harnessSha256`: everything that decides a verdict. The harness sources, the
 * CLI entry, the package manifest (it pins `tsx`) and the shared contracts (the
 * report schema and `GATE_ORDER`). Not included: the lockfile and installed
 * dependencies; the verifier image pins those (P5-03).
 */
export async function harnessHash(packageDir: string): Promise<string> {
  const parts: [string, string][] = [
    ['src', await hashTree(join(packageDir, 'src'))],
    ['bin', await hashTree(join(packageDir, 'bin'))],
    ['package.json', sha256(await readFile(join(packageDir, 'package.json')))],
    ['shared-contracts/src', await hashTree(join(packageDir, '..', 'shared-contracts', 'src'))],
  ];
  return sha256(parts.map(([name, hash]) => `${hash}  ${name}\n`).join(''));
}
