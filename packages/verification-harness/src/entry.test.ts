import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './cli.js';
import { run } from './entry.js';
import { COMMIT, fakeClock, gatesWith } from './test-helpers.js';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lathe-entry-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('lathe-verify entry', () => {
  // Reported by B in the review of PR #5: --report pointing at a directory crashed with exit 1.
  const argv = () => [
    'support-desk',
    '--worktree',
    '/workspace/app',
    '--commit',
    COMMIT,
    '--report',
    dir,
  ];

  it('main throws when the report cannot be written', async () => {
    await expect(
      main(argv(), { stderr: () => undefined, now: fakeClock(), gates: gatesWith() }),
    ).rejects.toThrow();
  });

  it('run turns that crash into exit 2 (error), not 1 (failed)', async () => {
    const lines: string[] = [];
    const code = await run(argv(), {
      stderr: (l) => lines.push(l),
      now: fakeClock(),
      gates: gatesWith(),
    });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('internal error');
  });
});
