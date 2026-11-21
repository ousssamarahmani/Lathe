import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessHash } from './hash.js';

const roots: string[] = [];
async function layout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lathe-hh-'));
  roots.push(root);
  const pkg = join(root, 'verification-harness');
  for (const [p, c] of [
    ['verification-harness/src/a.ts', 'a'],
    ['verification-harness/bin/lathe-verify.mjs', 'b'],
    ['verification-harness/package.json', '{}'],
    ['shared-contracts/src/gates.ts', 'g'],
  ] as const) {
    await mkdir(join(root, p, '..'), { recursive: true });
    await writeFile(join(root, p), c);
  }
  return pkg;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('harnessHash', () => {
  it.each([
    ['bin/lathe-verify.mjs', 'bin'],
    ['package.json', 'manifest'],
    ['../shared-contracts/src/gates.ts', 'contracts'],
  ])('changes when %s changes (%s)', async (file) => {
    const pkg = await layout();
    const before = await harnessHash(pkg);
    await writeFile(join(pkg, file), 'changed');
    expect(await harnessHash(pkg)).not.toBe(before);
  });
});
