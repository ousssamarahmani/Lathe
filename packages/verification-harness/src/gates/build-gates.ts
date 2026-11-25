import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Slug, type Finding } from '@lathe/shared-contracts';
import { z } from 'zod';
import type { Gate, GateContext, GateOutcome } from '../gate.js';
import { checkFailsInSources, checkStaticIntegrity, checkTestIntegrity } from './integrity.js';
import { runCommand, tail, type CommandRunner } from './process.js';

/** `policies/static-tests.json`. Commands are constants; they never come from the agent. */
export const StaticTestsPolicy = z.strictObject({
  version: z.literal(1),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  static: z
    .array(
      z.strictObject({
        name: z.enum(['typecheck', 'lint', 'build']),
        args: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  tests: z.strictObject({
    /** Arguments for `pnpm`. `{report}` is replaced with the path of the JSON report file. */
    args: z.array(z.string().min(1)).min(1),
    /** Test-count floor for apps without an entry in `minTests`. At least 1. */
    defaultMinTests: z.number().int().min(1),
    minTests: z.record(z.string(), z.number().int().min(1)),
  }),
});
export type StaticTestsPolicy = z.infer<typeof StaticTestsPolicy>;

export const BUILD_RULES = {
  timeout: 'process.timeout',
  noReport: 'tests.no-report',
  zero: 'tests.zero',
  belowFloor: 'tests.below-floor',
  failed: 'tests.failed',
  notRun: 'tests.skipped',
} as const;

/** Subset of the vitest/jest JSON reporter output that the gate relies on. */
const TestReport = z.object({
  numTotalTests: z.number().int().min(0),
  numPassedTests: z.number().int().min(0),
  numFailedTests: z.number().int().min(0),
  numPendingTests: z.number().int().min(0).default(0),
  numTodoTests: z.number().int().min(0).default(0),
});

const OUTPUT_IN_FINDING = 1_200;
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const TEST_SOURCE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/.+\.[cm]?[jt]sx?$/;
const MAX_TEST_SOURCE_BYTES = 2_000_000;

/** Reads the test sources of the patched app (paths relative to the worktree, / separated). */
async function readTestSources(
  worktree: string,
  dir: string,
): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile()) {
        const rel = relative(worktree, full).split(sep).join('/');
        if (TEST_SOURCE.test(rel) && (await stat(full)).size <= MAX_TEST_SOURCE_BYTES)
          out.push({ path: rel, text: await readFile(full, 'utf8') });
      }
    }
  };
  await walk(dir);
  return out;
}
const result = (
  status: GateOutcome['status'],
  summary: string,
  findings: Finding[],
): GateOutcome => ({
  status,
  summary: summary.slice(0, 500),
  findings,
  artifacts: [],
});

async function loadPolicy(file: string): Promise<StaticTestsPolicy> {
  return StaticTestsPolicy.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

/** Resolves `apps/<app>` inside the worktree, or explains why it cannot. */
async function appDir(ctx: GateContext): Promise<{ dir: string } | { error: string }> {
  if (!Slug.safeParse(ctx.app).success)
    return { error: `invalid app name ${JSON.stringify(ctx.app)}` };
  const dir = join(ctx.worktree, 'apps', ctx.app);
  const info = await stat(dir).catch(() => null);
  return info?.isDirectory() === true
    ? { dir }
    : { error: `app directory apps/${ctx.app} not found in the worktree` };
}

const withPatch = (ctx: GateContext, id: string): GateOutcome | null =>
  ctx.patch === null
    ? result(
        'error',
        `no patch given (lathe-verify --patch <file>); the ${id} gate cannot pass without one`,
        [],
      )
    : null;

const failure = (rule: string, message: string): Finding => ({
  ruleId: rule,
  severity: 'high',
  message: message.slice(0, 2_000),
});

/** Gate 2 (P2-03): lint-silencing check, then the app's typecheck, lint and build as processes. */
export function staticGate(policyFile: string, run: CommandRunner = runCommand): Gate {
  return {
    id: 'static',
    async run(ctx) {
      const noPatch = withPatch(ctx, 'static');
      if (noPatch !== null) return noPatch;
      let policy: StaticTestsPolicy;
      try {
        policy = await loadPolicy(policyFile);
      } catch (e) {
        return result(
          'error',
          `static-tests policy unreadable: ${e instanceof Error ? e.message : String(e)}`,
          [],
        );
      }
      const integrity = checkStaticIntegrity(ctx.patch ?? '');
      if (integrity.length > 0)
        return result(
          'failed',
          `${integrity.length} integrity finding(s); commands not run`,
          integrity,
        );
      const app = await appDir(ctx);
      if ('error' in app) return result('error', app.error, []);

      const findings: Finding[] = [];
      for (const step of policy.static) {
        const r = await run({
          cmd: 'pnpm',
          args: step.args,
          cwd: app.dir,
          timeoutMs: policy.timeoutMs,
        });
        if (r.spawnError !== undefined)
          return result('error', `${step.name} could not start: ${r.spawnError}`.slice(0, 500), []);
        if (r.timedOut)
          findings.push(
            failure(BUILD_RULES.timeout, `${step.name} timed out after ${policy.timeoutMs} ms`),
          );
        else if (r.exitCode !== 0)
          findings.push(
            failure(
              `static.${step.name}`,
              `${step.name} exited with code ${String(r.exitCode)}:\n${tail(r.output, OUTPUT_IN_FINDING)}`,
            ),
          );
      }
      return findings.length > 0
        ? result(
            'failed',
            `${findings.length} of ${policy.static.length} command(s) failed`,
            findings,
          )
        : result('passed', `${policy.static.map((s) => s.name).join(', ')} passed`, []);
    },
  };
}

/** Gate 3 (P2-03): focus, skip and config-weakening check, then the app's tests with a count floor. */
export function testsGate(policyFile: string, run: CommandRunner = runCommand): Gate {
  return {
    id: 'tests',
    async run(ctx) {
      const noPatch = withPatch(ctx, 'tests');
      if (noPatch !== null) return noPatch;
      let policy: StaticTestsPolicy;
      try {
        policy = await loadPolicy(policyFile);
      } catch (e) {
        return result(
          'error',
          `static-tests policy unreadable: ${e instanceof Error ? e.message : String(e)}`,
          [],
        );
      }
      const integrity = checkTestIntegrity(ctx.patch ?? '');
      if (integrity.length > 0)
        return result(
          'failed',
          `${integrity.length} integrity finding(s); tests not run`,
          integrity,
        );
      const app = await appDir(ctx);
      if ('error' in app) return result('error', app.error, []);
      // The report cannot show .fails (vitest JSON has no such field), so scan the patched tree.
      const inverted = checkFailsInSources(await readTestSources(ctx.worktree, app.dir));
      if (inverted.length > 0)
        return result(
          'failed',
          `${inverted.length} inverted (.fails) test(s); tests not run`,
          inverted,
        );

      const reportDir = await mkdtemp(join(tmpdir(), 'lathe-tests-'));
      try {
        const reportFile = join(reportDir, 'report.json');
        const r = await run({
          cmd: 'pnpm',
          args: policy.tests.args.map((a) => a.replaceAll('{report}', reportFile)),
          cwd: app.dir,
          timeoutMs: policy.timeoutMs,
        });
        if (r.spawnError !== undefined)
          return result('error', `tests could not start: ${r.spawnError}`.slice(0, 500), []);
        if (r.timedOut)
          return result('failed', 'tests timed out', [
            failure(BUILD_RULES.timeout, `tests timed out after ${policy.timeoutMs} ms`),
          ]);

        let counts: z.infer<typeof TestReport> | null = null;
        try {
          const parsed = TestReport.safeParse(
            JSON.parse(await readFile(reportFile, 'utf8')) as unknown,
          );
          counts = parsed.success ? parsed.data : null;
        } catch {
          counts = null;
        }
        const findings: Finding[] = [];
        if (counts === null)
          findings.push(
            failure(
              BUILD_RULES.noReport,
              `no readable test report (exit code ${String(r.exitCode)}):\n${tail(r.output, OUTPUT_IN_FINDING)}`,
            ),
          );
        else {
          const ran = counts.numPassedTests + counts.numFailedTests;
          const floor = policy.tests.minTests[ctx.app] ?? policy.tests.defaultMinTests;
          if (ran === 0)
            findings.push(failure(BUILD_RULES.zero, 'the test run executed zero tests'));
          else if (ran < floor)
            findings.push(
              failure(BUILD_RULES.belowFloor, `${ran} tests ran, below the floor of ${floor}`),
            );
          if (counts.numFailedTests > 0)
            findings.push(
              failure(
                BUILD_RULES.failed,
                `${counts.numFailedTests} test(s) failed:\n${tail(r.output, OUTPUT_IN_FINDING)}`,
              ),
            );
          const notRun = counts.numPendingTests + counts.numTodoTests;
          if (notRun > 0)
            findings.push(failure(BUILD_RULES.notRun, `${notRun} test(s) skipped or marked todo`));
        }
        if (r.exitCode !== 0 && findings.length === 0)
          findings.push(
            failure(
              BUILD_RULES.failed,
              `test command exited with code ${String(r.exitCode)}:\n${tail(r.output, OUTPUT_IN_FINDING)}`,
            ),
          );
        return findings.length > 0
          ? result('failed', `${findings.length} finding(s) in the test run`, findings)
          : result('passed', `${counts?.numPassedTests ?? 0} tests passed`, []);
      } finally {
        await rm(reportDir, { recursive: true, force: true });
      }
    },
  };
}
