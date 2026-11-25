import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GateContext } from '../gate.js';
import { staticGate, testsGate } from './build-gates.js';
import { INTEGRITY_RULES, checkStaticIntegrity, checkTestIntegrity } from './integrity.js';
import { INTEGRITY_FIXTURES, edit } from './integrity.fixtures.js';
import { redact, runCommand, type CommandResult, type CommandSpec } from './process.js';

const POLICY_FILE = fileURLToPath(new URL('../../policies/static-tests.json', import.meta.url));
const CLEAN = edit(
  'apps/support-desk/src/kb/index.ts',
  ['export const a = 1;'],
  ['export const a = 2;'],
);

describe('integrity fixtures (must catch)', () => {
  it.each(INTEGRITY_FIXTURES.map((f) => [f.name, f] as const))('%s', (_name, f) => {
    const findings = (f.check === 'static' ? checkStaticIntegrity : checkTestIntegrity)(f.diff);
    if (f.expect === 'pass') expect(findings).toEqual([]);
    else expect(findings.map((x) => x.ruleId)).toContain(f.rule);
  });

  it('covers every rule with at least one failing fixture', () => {
    const covered = new Set(
      INTEGRITY_FIXTURES.filter((f) => f.expect === 'fail').map((f) => f.rule),
    );
    for (const rule of Object.values(INTEGRITY_RULES)) expect(covered.has(rule)).toBe(true);
  });

  it('reports the file and line of an added suppression', () => {
    const [first] = checkStaticIntegrity(edit('apps/a/src/x.ts', [], ['// @ts-ignore']));
    expect(first).toMatchObject({ path: 'apps/a/src/x.ts', line: 2 });
  });
});

describe('real command runner', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lathe-proc-'));
    await writeFile(join(dir, 'hang.js'), 'setInterval(() => {}, 1000);\n');
    await writeFile(join(dir, 'fail.js'), 'console.log("token=abc123"); process.exit(3);\n');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('captures the exit code and redacts secrets in output', async () => {
    const r = await runCommand({ cmd: 'node', args: ['fail.js'], cwd: dir, timeoutMs: 20_000 });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('token=[redacted]');
    expect(r.output).not.toContain('abc123');
  });
  it('kills a process that exceeds the timeout', async () => {
    const r = await runCommand({ cmd: 'node', args: ['hang.js'], cwd: dir, timeoutMs: 700 });
    expect(r.timedOut).toBe(true);
  });
  it('does not pass credentials from the environment to the process', async () => {
    process.env.LATHE_TEST_SECRET_TOKEN = 'leak-me';
    await writeFile(
      join(dir, 'env.js'),
      'console.log(String(process.env.LATHE_TEST_SECRET_TOKEN));\n',
    );
    const r = await runCommand({ cmd: 'node', args: ['env.js'], cwd: dir, timeoutMs: 20_000 });
    delete process.env.LATHE_TEST_SECRET_TOKEN;
    expect(r.output.trim()).toBe('undefined');
  });
  it('redacts key=value secrets', () => {
    expect(redact('API_KEY=xyz and password: hunter2')).toBe(
      'API_KEY=[redacted] and password=[redacted]',
    );
  });
});

describe('static and tests gates', () => {
  let root = '';
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lathe-wt-'));
    await mkdir(join(root, 'apps', 'support-desk'), { recursive: true });
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  const ctx = (patch: string | null, app = 'support-desk'): GateContext => ({
    app,
    worktree: root,
    commit: 'a'.repeat(40),
    faultInjection: null,
    patch,
  });

  /** Fake runner. For the test command it writes the JSON report to the path it was given. */
  function fake(opts: {
    exit?: number;
    report?: unknown;
    timedOut?: boolean;
    spawnError?: string;
  }) {
    const calls: CommandSpec[] = [];
    const run = async (spec: CommandSpec): Promise<CommandResult> => {
      calls.push(spec);
      const out = spec.args.find((a) => a.startsWith('--outputFile='));
      if (out !== undefined && opts.report !== undefined)
        await writeFile(out.slice('--outputFile='.length), JSON.stringify(opts.report));
      return {
        exitCode: opts.exit ?? 0,
        timedOut: opts.timedOut ?? false,
        output: 'output text',
        ...(opts.spawnError === undefined ? {} : { spawnError: opts.spawnError }),
      };
    };
    return { calls, run };
  }
  const report = (passed: number, extra: Record<string, number> = {}) => ({
    numTotalTests: passed + (extra.numFailedTests ?? 0) + (extra.numPendingTests ?? 0),
    numPassedTests: passed,
    numFailedTests: 0,
    ...extra,
  });

  describe('static', () => {
    it('passes when typecheck, lint and build all exit 0', async () => {
      const f = fake({});
      const r = await staticGate(POLICY_FILE, f.run).run(ctx(CLEAN));
      expect(r.status).toBe('passed');
      expect(f.calls.map((c) => c.args.join(' '))).toEqual([
        'run typecheck',
        'run lint',
        'run build',
      ]);
      expect(f.calls.every((c) => c.cwd === join(root, 'apps', 'support-desk'))).toBe(true);
    });
    it('fails with one finding per failing command', async () => {
      const f = fake({ exit: 2 });
      const r = await staticGate(POLICY_FILE, f.run).run(ctx(CLEAN));
      expect(r.status).toBe('failed');
      expect(r.findings.map((x) => x.ruleId)).toEqual([
        'static.typecheck',
        'static.lint',
        'static.build',
      ]);
    });
    it('fails on a timeout and errors when the process cannot start', async () => {
      expect(
        (await staticGate(POLICY_FILE, fake({ timedOut: true }).run).run(ctx(CLEAN))).findings[0]
          ?.ruleId,
      ).toBe('process.timeout');
      expect(
        (await staticGate(POLICY_FILE, fake({ spawnError: 'ENOENT' }).run).run(ctx(CLEAN))).status,
      ).toBe('error');
    });
    it('fails on a suppression without running any command', async () => {
      const f = fake({});
      const r = await staticGate(POLICY_FILE, f.run).run(
        ctx(edit('apps/support-desk/src/a.ts', [], ['// @ts-ignore'])),
      );
      expect(r.status).toBe('failed');
      expect(f.calls).toEqual([]);
    });
    it('errors without a patch, for a bad app name, a missing app or a broken policy', async () => {
      const f = fake({});
      const gate = staticGate(POLICY_FILE, f.run);
      expect((await gate.run(ctx(null))).status).toBe('error');
      expect((await gate.run(ctx(CLEAN, '../evil'))).status).toBe('error');
      expect((await gate.run(ctx(CLEAN, 'missing-app'))).status).toBe('error');
      const broken = staticGate(join(root, 'missing.json'), f.run);
      expect((await broken.run(ctx(CLEAN))).status).toBe('error');
      expect(f.calls).toEqual([]);
    });
  });

  describe('tests', () => {
    const gate = (f: ReturnType<typeof fake>) => testsGate(POLICY_FILE, f.run);
    it('passes when tests ran and all passed', async () => {
      const r = await gate(fake({ report: report(3) })).run(ctx(CLEAN));
      expect(r.status).toBe('passed');
    });
    it('fails a run with zero tests, even with exit code 0', async () => {
      const r = await gate(fake({ report: report(0) })).run(ctx(CLEAN));
      expect(r.status).toBe('failed');
      expect(r.findings.map((x) => x.ruleId)).toContain('tests.zero');
    });
    it('fails when no report was written', async () => {
      const r = await gate(fake({})).run(ctx(CLEAN));
      expect(r.findings.map((x) => x.ruleId)).toEqual(['tests.no-report']);
    });
    it('fails failing tests even if the command exits 0', async () => {
      const r = await gate(fake({ report: report(2, { numFailedTests: 1 }) })).run(ctx(CLEAN));
      expect(r.findings.map((x) => x.ruleId)).toContain('tests.failed');
    });
    it('fails skipped and todo tests', async () => {
      const r = await gate(
        fake({ report: report(2, { numPendingTests: 1, numTodoTests: 1 }) }),
      ).run(ctx(CLEAN));
      expect(r.findings.map((x) => x.ruleId)).toContain('tests.skipped');
    });
    it('fails a non-zero exit even when the report looks fine', async () => {
      const r = await gate(fake({ exit: 1, report: report(3) })).run(ctx(CLEAN));
      expect(r.status).toBe('failed');
    });
    it('enforces the per-app test-count floor', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'lathe-policy-'));
      try {
        const file = join(dir, 'p.json');
        const base = JSON.parse(await readFile(POLICY_FILE, 'utf8')) as {
          tests: { minTests: Record<string, number> };
        };
        base.tests.minTests['support-desk'] = 5;
        await writeFile(file, JSON.stringify(base));
        const r = await testsGate(file, fake({ report: report(4) }).run).run(ctx(CLEAN));
        expect(r.findings.map((x) => x.ruleId)).toEqual(['tests.below-floor']);
        const ok5 = await testsGate(file, fake({ report: report(5) }).run).run(ctx(CLEAN));
        expect(ok5.status).toBe('passed');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    it('fails a focused test without running anything', async () => {
      const f = fake({ report: report(3) });
      const r = await gate(f).run(
        ctx(edit('apps/support-desk/src/a.test.ts', [], ["it.only('x', () => {});"])),
      );
      expect(r.status).toBe('failed');
      expect(f.calls).toEqual([]);
    });
    it('fails an it.fails test in the patched tree even when the diff is clean and the report passes', async () => {
      await mkdir(join(root, 'apps', 'support-desk', 'src'), { recursive: true });
      const file = join(root, 'apps', 'support-desk', 'src', 'old.test.ts');
      await writeFile(file, "it.fails('leak', () => { throw new Error('x'); });\n");
      try {
        const f = fake({ report: report(3) });
        const r = await gate(f).run(ctx(CLEAN));
        expect(r.status).toBe('failed');
        expect(r.findings.map((x) => x.ruleId)).toContain('integrity.fails');
        expect(r.findings[0]).toMatchObject({ path: 'apps/support-desk/src/old.test.ts', line: 1 });
        expect(f.calls).toEqual([]);
      } finally {
        await rm(join(root, 'apps', 'support-desk', 'src'), { recursive: true, force: true });
      }
    });
    it('ignores .fails in node_modules and passes a tree without it', async () => {
      const nm = join(root, 'apps', 'support-desk', 'node_modules', 'dep');
      await mkdir(nm, { recursive: true });
      await writeFile(join(nm, 'x.test.js'), "it.fails('x', () => {});\n");
      try {
        const r = await gate(fake({ report: report(3) })).run(ctx(CLEAN));
        expect(r.status).toBe('passed');
      } finally {
        await rm(join(root, 'apps', 'support-desk', 'node_modules'), {
          recursive: true,
          force: true,
        });
      }
    });
    it('fails on a timeout, errors on spawn failure and without a patch', async () => {
      expect((await gate(fake({ timedOut: true })).run(ctx(CLEAN))).findings[0]?.ruleId).toBe(
        'process.timeout',
      );
      expect((await gate(fake({ spawnError: 'x' })).run(ctx(CLEAN))).status).toBe('error');
      expect((await gate(fake({})).run(ctx(null))).status).toBe('error');
    });
  });
});

describe('policy file', () => {
  it('is accepted by both gates (no policy error)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lathe-wt2-'));
    try {
      await mkdir(join(root, 'apps', 'x'), { recursive: true });
      const c: GateContext = {
        app: 'x',
        worktree: root,
        commit: 'a'.repeat(40),
        faultInjection: null,
        patch: CLEAN,
      };
      const noop = (): Promise<CommandResult> =>
        Promise.resolve({ exitCode: 0, timedOut: false, output: '' });
      expect((await staticGate(POLICY_FILE, noop).run(c)).status).toBe('passed');
      expect((await testsGate(POLICY_FILE, noop).run(c)).findings[0]?.ruleId).toBe(
        'tests.no-report',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
