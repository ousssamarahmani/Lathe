import {
  GATE_ORDER,
  type GateResult,
  type Patch,
  type VerificationReport,
} from '@lathe/shared-contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SpecDocument } from '../domain/spec.js';
import { InMemoryEvidenceLog, sha256Hex } from '../evidence/index.js';
import { issueEngineCapability } from '../orchestrator/capability.js';
import { MemoryRunStore } from '../orchestrator/memory-run-store.js';
import { RunStateError } from '../orchestrator/index.js';
import {
  bindingHash,
  checkPatchPaths,
  runVerifyStep,
  verifierSandboxSpec,
  type VerifierHandle,
  type VerifierSandboxContext,
  type VerifyExecResult,
  type VerifyStepDeps,
} from './index.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const BASE = 'a'.repeat(40);
const HARNESS = 'c'.repeat(64);
const POLICY = 'd'.repeat(64);
const clock = { now: () => new Date('2026-12-01T00:00:00Z') };

const spec: SpecDocument = {
  title: 'Knowledge base',
  targetApp: 'support-desk',
  requirements: [{ id: 'R1', text: 'Agents can create articles' }],
  targetPaths: ['apps/support-desk/src/kb'],
  acceptanceChecks: [{ id: 'A1', requirement: 'R1', text: 'create returns the article' }],
};

function diffFor(f: string): string {
  return `diff --git a/${f} b/${f}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+export const x = 1;\n`;
}
function patchOf(f: string): Patch {
  const diff = diffFor(f);
  return { baseCommit: BASE, diff, files: [f], sha256: sha256Hex(diff) } as Patch;
}
const PATCH = patchOf('apps/support-desk/src/kb/create.ts');

const passedGate = (gate: GateResult['gate']): GateResult => ({
  gate,
  status: 'passed',
  durationMs: 5,
  summary: 'ok',
  findings: [],
  artifacts: [],
});
function report(failAt?: number, over: Partial<VerificationReport> = {}): VerificationReport {
  const gates: GateResult[] = GATE_ORDER.map((g, i) => {
    if (failAt === undefined || i < failAt) return passedGate(g);
    if (i === failAt)
      return {
        gate: g,
        status: 'failed',
        durationMs: 9,
        summary: 'cross-tenant read',
        findings: [
          {
            ruleId: 'tenant/read',
            message: 'org B read org A row, password=hunter2hunter2',
            severity: 'critical',
          },
        ],
        artifacts: [],
      };
    return { gate: g, status: 'not_run', durationMs: 0, summary: '', findings: [], artifacts: [] };
  });
  return {
    schemaVersion: 1,
    app: 'support-desk',
    commit: BASE,
    harnessSha256: HARNESS,
    policySha256: POLICY,
    resultHash: 'e'.repeat(64),
    startedAt: '2026-12-01T00:00:00.000Z',
    finishedAt: '2026-12-01T00:00:01.000Z',
    overall: failAt === undefined ? 'passed' : 'failed',
    gates,
    faultInjection: null,
    ...over,
  } as VerificationReport;
}
type Exec = VerifyExecResult & { reportFile?: string | null };
const out = (r: unknown, exitCode: number): Exec => ({
  exitCode,
  stdout: '',
  stderr: '',
  timedOut: false,
  reportFile: typeof r === 'string' ? r : JSON.stringify(r),
});

function setup(opts: {
  exec: () => Exec | Promise<Exec>;
  alive?: string[];
  attempts?: number;
  patch?: Patch;
  postgresFails?: boolean;
}) {
  const runs = new MemoryRunStore([
    { runId: RUN, state: 'VERIFYING', repairAttempts: opts.attempts ?? 0 },
  ]);
  const evidence = new InMemoryEvidenceLog(clock);
  const contexts: VerifierSandboxContext[] = [];
  const destroyed: string[] = [];
  const execs: string[][] = [];
  const events: string[] = [];
  const reads: string[] = [];
  let reportText: string | null = null;
  const deps: VerifyStepDeps = {
    runs,
    evidence,
    capability: issueEngineCapability(),
    baseCommit: BASE as VerifyStepDeps['baseCommit'],
    timeoutMs: 1_000,
    sandboxConfig: { image: `lathe/sandbox@sha256:${'b'.repeat(64)}` },
    specs: { get: () => Promise.resolve(spec) },
    patches: { get: () => Promise.resolve(opts.patch ?? PATCH) },
    sandboxes: {
      liveAgentSandboxes: () => Promise.resolve(opts.alive ?? []),
      create: (sandboxSpec, ctx) => {
        contexts.push(ctx);
        events.push('create');
        const handle: VerifierHandle = {
          id: 'v0',
          spec: sandboxSpec,
          collectPatch: () => Promise.reject(new Error('not for verifier')),
          destroy: () => {
            destroyed.push('v0');
            return Promise.resolve();
          },
          startEphemeralPostgres: () =>
            opts.postgresFails ? Promise.reject(new Error('pg')) : Promise.resolve(),
          exec: async (argv) => {
            execs.push([...argv]);
            const { reportFile, ...rest } = await opts.exec();
            reportText = reportFile ?? null;
            return rest;
          },
          readFile: (path) => {
            reads.push(path);
            return Promise.resolve(reportText);
          },
        };
        return Promise.resolve(handle);
      },
    },
  };
  return { runs, evidence, deps, contexts, destroyed, execs, reads };
}
const stateOf = async (runs: MemoryRunStore) =>
  (await runs.listNonTerminal()).find((r) => r.runId === RUN)?.state;

describe('runVerifyStep', () => {
  it('pass -> AWAITING_APPROVAL with a binding hash stored as evidence', async () => {
    const t = setup({ exec: () => out(report(), 0) });
    const r = await runVerifyStep(t.deps, RUN);
    const expected = bindingHash({
      commit: BASE,
      patchSha256: PATCH.sha256,
      harnessSha256: HARNESS,
      policySha256: POLICY,
    });
    expect(r).toMatchObject({ outcome: 'passed', bindingHash: expected });
    expect(await stateOf(t.runs)).toBe('AWAITING_APPROVAL');
    expect(t.execs[0]).toEqual([
      'lathe-verify',
      'support-desk',
      '--worktree',
      '/workspace',
      '--commit',
      BASE,
      '--report',
      '/tmp/lathe-verify-report.json',
      '--patch',
      '/tmp/lathe-agent.patch',
    ]);
    expect(t.reads).toEqual(['/tmp/lathe-verify-report.json']);
    expect(t.destroyed).toEqual(['v0']);
    const entries = await t.evidence.list(RUN);
    expect(entries.filter((e) => e.kind === 'verify_gate')).toHaveLength(GATE_ORDER.length);
    expect(JSON.stringify(entries.find((e) => e.kind === 'verify_result')?.payload)).toContain(
      expected,
    );
    expect(await t.evidence.verify(RUN)).toMatchObject({ ok: true });
  });

  it('verifier spec has no egress, no secrets, no Kiro', () => {
    const s = verifierSandboxSpec({ image: `lathe/sandbox@sha256:${'b'.repeat(64)}` });
    expect(s.purpose).toBe('verifier');
    expect(s.egressAllowlist).toEqual([]);
    expect(s.secretEnv).toEqual([]);
    expect(s.mounts.map((m) => m.source)).not.toContain('kiro-session');
  });

  it('fail -> keeps redacted failing gate output and goes to REPAIRING', async () => {
    const t = setup({ exec: () => out(report(3), 1) });
    const r = await runVerifyStep(t.deps, RUN);
    expect(r).toMatchObject({
      outcome: 'failed',
      failedGates: ['tenant-isolation'],
      next: 'REPAIRING',
    });
    expect(await stateOf(t.runs)).toBe('REPAIRING');
    const text = JSON.stringify(await t.evidence.list(RUN));
    expect(text).toContain('cross-tenant read');
    expect(text).not.toContain('hunter2hunter2');
    expect(t.destroyed).toEqual(['v0']);
  });

  it('fail with no attempts left -> FAILED', async () => {
    const t = setup({ exec: () => out(report(3), 1), attempts: 3 });
    const r = await runVerifyStep(t.deps, RUN);
    expect(r).toMatchObject({ outcome: 'failed', next: 'FAILED' });
    expect(await stateOf(t.runs)).toBeUndefined();
  });

  it('exit 0 with a failed report is an error, not a pass', async () => {
    const t = setup({ exec: () => out(report(3), 0) });
    expect(await runVerifyStep(t.deps, RUN)).toEqual({
      outcome: 'error',
      reason: 'verification_error',
    });
    expect(await stateOf(t.runs)).toBeUndefined();
  });

  it('exit 1 with a passed report is an error', async () => {
    const t = setup({ exec: () => out(report(), 1) });
    expect(await runVerifyStep(t.deps, RUN)).toMatchObject({ outcome: 'error' });
  });

  it('exit 0 with a garbage report file is an error', async () => {
    const t = setup({ exec: () => out('ALL GATES PASSED', 0) });
    expect(await runVerifyStep(t.deps, RUN)).toMatchObject({ outcome: 'error' });
    expect(await stateOf(t.runs)).toBeUndefined();
  });
  it('missing report file is an error', async () => {
    const t = setup({
      exec: () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, reportFile: null }),
    });
    expect(await runVerifyStep(t.deps, RUN)).toMatchObject({ outcome: 'error' });
    expect(await stateOf(t.runs)).toBeUndefined();
  });
  it('a valid report on stdout only (no report file) is an error', async () => {
    const t = setup({
      exec: () => ({
        exitCode: 0,
        stdout: JSON.stringify(report()),
        stderr: '',
        timedOut: false,
        reportFile: null,
      }),
    });
    expect(await runVerifyStep(t.deps, RUN)).toMatchObject({ outcome: 'error' });
    expect(await stateOf(t.runs)).toBeUndefined();
  });

  it('exit 2, unknown exit code, wrong commit or wrong app are errors', async () => {
    for (const r of [
      out(report(), 7),
      out(report(undefined, { commit: 'f'.repeat(40) } as never), 0),
      out(report(undefined, { app: 'team-operations' } as never), 0),
      out(report(), 2),
    ]) {
      const t = setup({ exec: () => r });
      expect(await runVerifyStep(t.deps, RUN)).toMatchObject({ outcome: 'error' });
      expect(await stateOf(t.runs)).toBeUndefined();
    }
  });

  it('timeout -> error and the verifier is destroyed', async () => {
    const t = setup({
      exec: () => ({ exitCode: null, stdout: '', stderr: 'killed', timedOut: true }),
    });
    expect(await runVerifyStep(t.deps, RUN)).toMatchObject({ outcome: 'error' });
    expect(t.destroyed).toEqual(['v0']);
    expect(await stateOf(t.runs)).toBeUndefined();
  });

  it('postgres or exec crash -> error and the verifier is destroyed', async () => {
    const a = setup({ exec: () => out(report(), 0), postgresFails: true });
    expect(await runVerifyStep(a.deps, RUN)).toMatchObject({ outcome: 'error' });
    expect(a.destroyed).toEqual(['v0']);
    const b = setup({
      exec: () => {
        throw new Error('docker exec failed');
      },
    });
    expect(await runVerifyStep(b.deps, RUN)).toMatchObject({ outcome: 'error' });
    expect(b.destroyed).toEqual(['v0']);
  });

  it('refuses while an agent sandbox is alive; no verifier is created', async () => {
    const t = setup({ exec: () => out(report(), 0), alive: ['agent-1'] });
    expect(await runVerifyStep(t.deps, RUN)).toEqual({
      outcome: 'refused',
      reason: 'agent_sandbox_alive',
    });
    expect(t.contexts).toHaveLength(0);
    expect(await stateOf(t.runs)).toBe('VERIFYING');
  });

  it('refuses when the agent sandbox check itself fails', async () => {
    const t = setup({ exec: () => out(report(), 0) });
    const deps: VerifyStepDeps = {
      ...t.deps,
      sandboxes: {
        ...t.deps.sandboxes,
        liveAgentSandboxes: () => Promise.reject(new Error('docker down')),
      },
    };
    expect(await runVerifyStep(deps, RUN)).toMatchObject({
      outcome: 'refused',
      reason: 'agent_sandbox_check_failed',
    });
    expect(t.contexts).toHaveLength(0);
  });

  it('needs a VERIFYING run', async () => {
    const t = setup({ exec: () => out(report(), 0) });
    await runVerifyStep(t.deps, RUN);
    await expect(runVerifyStep(t.deps, RUN)).rejects.toBeInstanceOf(RunStateError);
  });

  it('harnessRef is the base commit; the patch is passed as data', async () => {
    const t = setup({ exec: () => out(report(), 0) });
    await runVerifyStep(t.deps, RUN);
    expect(t.contexts[0]).toMatchObject({
      harnessRef: BASE,
      baseCommit: BASE,
      targetApp: 'support-desk',
    });
    expect(t.contexts[0]?.patch.sha256).toBe(PATCH.sha256);
  });

  it('a patch touching harness paths is rejected by P5-02 check and, if it got here, errors', async () => {
    const f = 'packages/verification-harness/src/gates.ts';
    const bad = patchOf(f);
    expect(checkPatchPaths(bad, spec).ok).toBe(false);
    const t = setup({ exec: () => out(report(), 0), patch: bad });
    expect(await runVerifyStep(t.deps, RUN)).toMatchObject({ outcome: 'error' });
    expect(t.contexts).toHaveLength(0);
    expect(t.contexts.some((c) => c.harnessRef !== BASE)).toBe(false);
  });

  it('a tampered stored patch (hash mismatch) errors without creating a verifier', async () => {
    const t = setup({
      exec: () => out(report(), 0),
      patch: { ...PATCH, sha256: '0'.repeat(64) } as Patch,
    });
    expect(await runVerifyStep(t.deps, RUN)).toMatchObject({ outcome: 'error' });
    expect(t.contexts).toHaveLength(0);
  });

  it('ignores pass claims in agent-side evidence: only lathe-verify output counts', async () => {
    const t = setup({ exec: () => out(report(3), 1) });
    await t.evidence.append(RUN, 'agent_claim', { verified: true, overall: 'passed' });
    const r = await runVerifyStep(t.deps, RUN);
    expect(r.outcome).toBe('failed');
    expect(await stateOf(t.runs)).toBe('REPAIRING');
  });
});

describe('bindingHash', () => {
  const sha = fc.stringMatching(/^[a-f0-9]{64}$/);
  const commit = fc.stringMatching(/^[a-f0-9]{40}$/);
  const input = fc.record({
    commit,
    patchSha256: sha,
    harnessSha256: sha,
    policySha256: sha,
  });
  it('is deterministic and changes when any component changes', () => {
    fc.assert(
      fc.property(
        input,
        input,
        fc.constantFrom('commit', 'patchSha256', 'harnessSha256', 'policySha256'),
        (a, b, key) => {
          expect(bindingHash(a)).toBe(bindingHash({ ...a }));
          const k = key as keyof typeof a;
          fc.pre(a[k] !== b[k]);
          expect(bindingHash({ ...a, [k]: b[k] })).not.toBe(bindingHash(a));
        },
      ),
    );
  });
});
