import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VerificationReport } from '@lathe/shared-contracts';
import { main } from './cli.js';
import { COMMIT, fakeClock, gatesWith, outcome } from './test-helpers.js';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lathe-cli-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const quiet = { stderr: () => undefined, now: fakeClock() };
const args = (report: string, extra: string[] = []) => [
  'support-desk',
  '--worktree',
  '/workspace/app',
  '--commit',
  COMMIT,
  '--report',
  report,
  ...extra,
];
const readReport = async (path: string) =>
  VerificationReport.parse(JSON.parse(await readFile(path, 'utf8')));
const exists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('lathe-verify', () => {
  it('never passes with the default gates while they are not implemented', async () => {
    const path = join(dir, 'default.json');
    expect(await main(args(path), quiet)).toBe(2);
    const r = await readReport(path);
    expect(r.overall).toBe('error');
    expect(r.gates.map((g) => g.status)).toEqual([
      'error',
      'not_run',
      'not_run',
      'not_run',
      'not_run',
      'not_run',
      'not_run',
    ]);
    expect(r.harnessSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('exits 0 when every gate passes and 1 when one fails', async () => {
    expect(await main(args(join(dir, 'pass.json')), { ...quiet, gates: gatesWith() })).toBe(0);
    const failing = gatesWith({ tests: () => Promise.resolve(outcome('failed')) });
    expect(await main(args(join(dir, 'fail.json')), { ...quiet, gates: failing })).toBe(1);
    expect((await readReport(join(dir, 'fail.json'))).overall).toBe('failed');
  });

  it('labels an injected fault', async () => {
    const path = join(dir, 'fault.json');
    await main(args(path, ['--fault', 'drop-tenant-filter']), { ...quiet, gates: gatesWith() });
    expect((await readReport(path)).faultInjection).toEqual({
      name: 'drop-tenant-filter',
      label: 'injected by Lathe',
    });
  });

  it.each([
    ['missing commit', ['support-desk', '--worktree', '/workspace/app', '--report', 'R']],
    [
      'short commit',
      ['support-desk', '--worktree', '/workspace/app', '--commit', '132716f', '--report', 'R'],
    ],
    ['unknown flag', [...args('R'), '--skip-gates', 'all']],
    ['unknown fault', [...args('R'), '--fault', 'disable-rls']],
    ['two apps', ['a', ...args('R')]],
    [
      'relative worktree',
      ['support-desk', '--worktree', 'app', '--commit', COMMIT, '--report', 'R'],
    ],
  ])('rejects %s with exit 2 and writes no report', async (_name, argv) => {
    const path = join(dir, `bad-${_name.replaceAll(' ', '-')}.json`);
    const fixed = argv.map((a) => (a === 'R' ? path : a));
    expect(await main(fixed, quiet)).toBe(2);
    expect(await exists(path)).toBe(false);
  });
});
