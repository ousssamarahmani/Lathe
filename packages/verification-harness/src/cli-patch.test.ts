import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VerificationReport } from '@lathe/shared-contracts';
import { main } from './cli.js';
import { FIXTURES } from './gates/protected-paths.fixtures.js';
import { COMMIT, fakeClock } from './test-helpers.js';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lathe-patch-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const quiet = () => ({ stderr: () => undefined, now: fakeClock() });
const base = (report: string) => [
  'support-desk',
  '--worktree',
  '/workspace/app',
  '--commit',
  COMMIT,
  '--report',
  report,
];
const diffOf = (name: string): string => FIXTURES.find((f) => f.name === name)?.diff ?? '';

async function verify(diff: string | null, label: string) {
  const report = join(dir, `${label}.json`);
  const argv = base(report);
  if (diff !== null) {
    const patch = join(dir, `${label}.diff`);
    await writeFile(patch, diff);
    argv.push('--patch', patch);
  }
  const code = await main(argv, quiet());
  return { code, report: VerificationReport.parse(JSON.parse(await readFile(report, 'utf8'))) };
}

describe('lathe-verify --patch', () => {
  it('passes protected-paths on a clean patch, and still cannot pass overall while later gates are missing', async () => {
    const { code, report } = await verify(diffOf('allow-modify'), 'clean');
    expect(report.gates[0]?.status).toBe('passed');
    expect(report.gates[1]?.status).toBe('error');
    expect(code).toBe(2);
  });
  it('fails with exit 1 on a patch that touches .github', async () => {
    const { code, report } = await verify(diffOf('reject-workflow'), 'protected');
    expect(code).toBe(1);
    expect(report.gates[0]?.findings.map((f) => f.ruleId)).toContain('protected-paths.protected');
  });
  it('reports error when no patch is given', async () => {
    expect((await verify(null, 'none')).report.gates[0]?.status).toBe('error');
  });
  it('exits 2 when the patch file cannot be read', async () => {
    expect(
      await main([...base(join(dir, 'x.json')), '--patch', join(dir, 'missing.diff')], quiet()),
    ).toBe(2);
  });
});
