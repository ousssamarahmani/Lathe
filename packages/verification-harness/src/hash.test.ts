import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashTree, resultHash } from './hash.js';

const dirs: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lathe-hash-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('hashTree', () => {
  it('is stable for equal trees and changes with content or names', async () => {
    const a = await tree({ 'a.ts': 'x', 'sub/b.ts': 'y' });
    const b = await tree({ 'sub/b.ts': 'y', 'a.ts': 'x' });
    expect(await hashTree(a)).toBe(await hashTree(b));
    const changed = await tree({ 'a.ts': 'x!', 'sub/b.ts': 'y' });
    expect(await hashTree(changed)).not.toBe(await hashTree(a));
    await rename(join(b, 'a.ts'), join(b, 'c.ts'));
    expect(await hashTree(b)).not.toBe(await hashTree(a));
  });

  it('ignores node_modules', async () => {
    const a = await tree({ 'a.ts': 'x' });
    const b = await tree({ 'a.ts': 'x', 'node_modules/dep/index.js': 'z' });
    expect(await hashTree(b)).toBe(await hashTree(a));
  });
});

describe('resultHash', () => {
  it('hashes the preimage documented in contract C3', () => {
    const commit = '1'.repeat(40);
    const h = 'f'.repeat(64);
    const preimage = `lathe-verify/v1\n${commit}\n${h}\n${h}\nprotected-paths=passed\nstatic=failed\n`;
    const expected = createHash('sha256').update(preimage).digest('hex');
    expect(
      resultHash({
        commit,
        harnessSha256: h,
        policySha256: h,
        gates: [
          { gate: 'protected-paths', status: 'passed' },
          { gate: 'static', status: 'failed' },
        ],
      }),
    ).toBe(expected);
  });
});
