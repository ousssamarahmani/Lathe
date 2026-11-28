import {
  GATE_ORDER,
  type GateResult,
  type KiroAdapter,
  type KiroSession,
  type Patch,
  type SandboxHandle,
  type VerificationReport,
} from '@lathe/shared-contracts';
import { describe, expect, it } from 'vitest';
import { InMemoryApprovals } from '../approvals/index.js';
import type { PlanDraft } from '../domain/plan.js';
import type { SpecDocument } from '../domain/spec.js';
import { InMemoryEvidenceLog, sha256Hex } from '../evidence/index.js';
import { issueEngineCapability } from '../orchestrator/capability.js';
import { MemoryRunStore } from '../orchestrator/memory-run-store.js';
import {
  FaultInjectionError,
  applyFault,
  checkPatchPaths,
  createFaultInjector,
  faultFlagFor,
  planApprovalSubject,
  runBuildStep,
  runVerifyStep,
  type BuildStepDeps,
  type FaultRun,
  type VerifierHandle,
  type VerifyStepDeps,
} from './index.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const BASE = 'a'.repeat(40);
const clock = { now: () => new Date('2026-12-01T00:00:00Z') };
const FILE = 'apps/support-desk/src/kb/list.ts';
const spec: SpecDocument = {
  title: 'Knowledge base',
  targetApp: 'support-desk',
  requirements: [{ id: 'R1', text: 'Agents can list articles' }],
  targetPaths: ['apps/support-desk/src/kb'],
  acceptanceChecks: [{ id: 'A1', requirement: 'R1', text: 'list returns the articles' }],
};
const plan: PlanDraft = {
  tasks: [{ key: 'T1', title: 'List', paths: [FILE], acceptanceChecks: ['A1'], dependsOn: [] }],
};
const demoRun: FaultRun = { demo: true, faultInjection: 'drop-tenant-filter', repairAttempts: 0 };

const KB_DIFF =
  `diff --git a/${FILE} b/${FILE}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${FILE}\n` +
  '@@ -0,0 +1,5 @@\n' +
  '+export const q = db.select().from(articles).where(and(\n' +
  '+  eq(articles.orgId, ctx.orgId),\n' +
  '+  eq(articles.id, id),\n' +
  '+));\n' +
  '+export const y = 1;\n';
function patchOf(diff: string, files: readonly string[] = [FILE]): Patch {
  return { baseCommit: BASE, diff, files, sha256: sha256Hex(diff) } as Patch;
}
const AGENT = patchOf(KB_DIFF);
const PLAIN = patchOf(
  `diff --git a/${FILE} b/${FILE}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${FILE}\n@@ -0,0 +1 @@\n+export const x = 1;\n`,
);

describe('applyFault', () => {
  it('demo + drop-tenant-filter removes the filter and keeps the diff well formed', () => {
    const r = applyFault(demoRun, AGENT);
    if (!r.applied) throw new Error('expected injection');
    expect(r.patch.diff).not.toContain('articles.orgId');
    expect(r.patch.diff).toContain('@@ -0,0 +1,4 @@');
    expect(r.patch.sha256).toBe(sha256Hex(r.patch.diff));
    expect(r.patch.sha256).not.toBe(AGENT.sha256);
    expect(checkPatchPaths(r.patch, spec).ok).toBe(true);
    expect(r.injection.label).toBe('injected by Lathe');
    expect(r.injection.agentPatchSha256).toBe(AGENT.sha256);
    expect(r.injection.injectedPatchSha256).toBe(sha256Hex(r.injection.injectedPatch));
    expect(r.injection.injectedPatch).toContain('-eq(articles.orgId, ctx.orgId),');
  });
  it('is deterministic', () => {
    expect(applyFault(demoRun, AGENT)).toEqual(applyFault(demoRun, AGENT));
  });
  it('shifts later hunks of the same file', () => {
    const f = 'apps/support-desk/src/kb/get.ts';
    const diff =
      `diff --git a/${f} b/${f}\nindex 1111111..2222222 100644\n--- a/${f}\n+++ b/${f}\n` +
      '@@ -1,2 +1,4 @@\n a\n+  eq(t.orgId, ctx.orgId),\n+b\n c\n' +
      '@@ -10,1 +12,2 @@\n d\n+e\n';
    const r = applyFault(demoRun, patchOf(diff, [f]));
    if (!r.applied) throw new Error('expected injection');
    expect(r.patch.diff).toContain('@@ -1,2 +1,3 @@');
    expect(r.patch.diff).toContain('@@ -10,1 +11,2 @@');
    expect(checkPatchPaths(r.patch, spec).ok).toBe(true);
  });
  it('no fault set is identity, also on non-demo runs', () => {
    for (const demo of [true, false]) {
      const r = applyFault({ demo, faultInjection: null, repairAttempts: 0 }, AGENT);
      expect(r).toEqual({ applied: false, patch: AGENT });
    }
  });
  it('a fault on a non-demo run is rejected', () => {
    expect(() => applyFault({ ...demoRun, demo: false }, AGENT)).toThrow(FaultInjectionError);
    expect(() => faultFlagFor({ ...demoRun, demo: false })).toThrow(/demo/);
  });
  it('an unknown fault throws', () => {
    expect(() => applyFault({ ...demoRun, faultInjection: 'rm-rf' }, AGENT)).toThrow(
      expect.objectContaining({ code: 'unknown_fault' }) as Error,
    );
  });
  it('repair attempts are never injected', () => {
    const r = applyFault({ ...demoRun, repairAttempts: 1 }, AGENT);
    expect(r).toEqual({ applied: false, patch: AGENT });
  });
  it('a patch with no removable filter is an error, not a silent skip', () => {
    expect(() => applyFault(demoRun, PLAIN)).toThrow(
      expect.objectContaining({ code: 'fault_not_applicable' }) as Error,
    );
  });
  it('does not touch a filter outside a KB file', () => {
    const f = 'apps/support-desk/src/tickets/list.ts';
    const diff = KB_DIFF.replaceAll(FILE, f);
    expect(() => applyFault(demoRun, patchOf(diff, [f]))).toThrow(FaultInjectionError);
  });
});

function builder(run: FaultRun, patch: Patch) {
  const runs = new MemoryRunStore([{ runId: RUN, state: 'PLANNED', repairAttempts: 0 }]);
  const evidence = new InMemoryEvidenceLog(clock);
  const approvals = new InMemoryApprovals(clock);
  approvals.approve(planApprovalSubject(RUN), 'human', plan);
  const saved: Patch[] = [];
  const adapter: KiroAdapter = {
    start: () =>
      Promise.resolve({
        id: 's0',
        async *events() {
          /* none */
        },
        prompt: () => Promise.resolve({ stopReason: 'end_turn', eventCount: 0 }),
        cancel: () => Promise.resolve(),
        close: () => Promise.resolve(),
      } as unknown as KiroSession),
  };
  const deps: BuildStepDeps = {
    runs,
    evidence,
    adapter,
    approvals,
    capability: issueEngineCapability(),
    baseCommit: BASE as BuildStepDeps['baseCommit'],
    timeoutMs: 1_000,
    sandboxConfig: {
      image: `lathe/sandbox@sha256:${'b'.repeat(64)}`,
      egressAllowlist: [],
      allowCommands: false,
    },
    specs: { get: () => Promise.resolve(spec) },
    plans: { get: () => Promise.resolve(plan) },
    patches: {
      save: (_r, p) => {
        saved.push(p);
        return Promise.resolve();
      },
    },
    sandboxes: {
      create: (sandboxSpec) =>
        Promise.resolve({
          id: 'sb0',
          spec: sandboxSpec,
          collectPatch: () => Promise.resolve(patch),
          destroy: () => Promise.resolve(),
        } satisfies SandboxHandle),
    },
    faultInjector: createFaultInjector({ faults: { get: () => Promise.resolve(run) }, evidence }),
  };
  return { runs, evidence, deps, saved };
}
const stateOf = async (runs: MemoryRunStore) =>
  (await runs.listNonTerminal()).find((r) => r.runId === RUN)?.state;

describe('build step with fault injection', () => {
  it('stores the faulted patch and labels the injection in evidence', async () => {
    const t = builder(demoRun, AGENT);
    const r = await runBuildStep(t.deps, RUN);
    expect(r.outcome).toBe('built');
    expect(t.saved[0]?.diff).not.toContain('articles.orgId');
    const entries = await t.evidence.list(RUN);
    const injected = entries.find((e) => e.kind === 'fault_injected');
    expect(injected?.payload).toMatchObject({
      label: 'injected by Lathe',
      fault: 'drop-tenant-filter',
      agentPatchSha256: AGENT.sha256,
      resultingPatchSha256: t.saved[0]?.sha256,
    });
    expect(JSON.stringify(injected?.payload)).toMatch(/"injectedPatchSha256":"[a-f0-9]{64}"/);
    expect(await t.evidence.verify(RUN)).toMatchObject({ ok: true });
  });
  it('repair attempt (repairAttempts 1) gets no injection', async () => {
    const t = builder({ ...demoRun, repairAttempts: 1 }, AGENT);
    await runBuildStep(t.deps, RUN);
    expect(t.saved[0]).toEqual(AGENT);
    expect((await t.evidence.list(RUN)).some((e) => e.kind === 'fault_injected')).toBe(false);
  });
  it('non-demo run with a fault fails the run and injects nothing', async () => {
    const t = builder({ ...demoRun, demo: false }, AGENT);
    const r = await runBuildStep(t.deps, RUN);
    expect(r).toMatchObject({ outcome: 'failed', reason: 'build_patch_invalid' });
    expect(await stateOf(t.runs)).toBeUndefined(); // FAILED is terminal
    expect(t.saved).toEqual([]);
  });
  it('an injection that cannot apply fails the run', async () => {
    const t = builder(demoRun, PLAIN);
    const r = await runBuildStep(t.deps, RUN);
    expect(r).toMatchObject({ outcome: 'failed', reason: 'build_patch_invalid' });
    expect(t.saved).toEqual([]);
    const entries = await t.evidence.list(RUN);
    expect(entries.some((e) => e.kind === 'fault_error')).toBe(true);
  });
  it('no fault on a demo run changes nothing', async () => {
    const t = builder({ demo: true, faultInjection: null, repairAttempts: 0 }, AGENT);
    await runBuildStep(t.deps, RUN);
    expect(t.saved[0]).toEqual(AGENT);
  });
});

const gate = (g: GateResult['gate'], failed: boolean): GateResult =>
  failed
    ? {
        gate: g,
        status: 'failed',
        durationMs: 1,
        summary: 'cross-tenant read',
        findings: [{ ruleId: 'tenant/read', message: 'org B read org A', severity: 'critical' }],
        artifacts: [],
      }
    : { gate: g, status: 'passed', durationMs: 1, summary: 'ok', findings: [], artifacts: [] };
function report(failed: boolean, fault: boolean): VerificationReport {
  return {
    schemaVersion: 1,
    app: 'support-desk',
    commit: BASE,
    harnessSha256: 'c'.repeat(64),
    policySha256: 'd'.repeat(64),
    resultHash: 'e'.repeat(64),
    startedAt: '2026-12-01T00:00:00.000Z',
    finishedAt: '2026-12-01T00:00:01.000Z',
    overall: failed ? 'failed' : 'passed',
    gates: GATE_ORDER.map((g, i) =>
      !failed || i < 3
        ? gate(g, false)
        : i === 3
          ? gate(g, true)
          : ({
              gate: g,
              status: 'not_run',
              durationMs: 0,
              summary: '',
              findings: [],
              artifacts: [],
            } as GateResult),
    ),
    faultInjection: fault ? { name: 'drop-tenant-filter', label: 'injected by Lathe' } : null,
  } as VerificationReport;
}
function verifier(run: FaultRun, failed: boolean, patch: Patch) {
  const runs = new MemoryRunStore([{ runId: RUN, state: 'VERIFYING', repairAttempts: 0 }]);
  const evidence = new InMemoryEvidenceLog(clock);
  const execs: string[][] = [];
  let text: string | null = null;
  const deps: VerifyStepDeps = {
    runs,
    evidence,
    capability: issueEngineCapability(),
    baseCommit: BASE as VerifyStepDeps['baseCommit'],
    timeoutMs: 1_000,
    sandboxConfig: { image: `lathe/sandbox@sha256:${'b'.repeat(64)}` },
    specs: { get: () => Promise.resolve(spec) },
    patches: { get: () => Promise.resolve(patch) },
    faults: { get: () => Promise.resolve(run) },
    sandboxes: {
      liveAgentSandboxes: () => Promise.resolve([]),
      create: (sandboxSpec) =>
        Promise.resolve({
          id: 'v0',
          spec: sandboxSpec,
          collectPatch: () => Promise.reject(new Error('no')),
          destroy: () => Promise.resolve(),
          startEphemeralPostgres: () => Promise.resolve(),
          exec: (argv: readonly string[]) => {
            execs.push([...argv]);
            text = JSON.stringify(report(failed, run.faultInjection !== null));
            return Promise.resolve({
              exitCode: failed ? 1 : 0,
              stdout: '',
              stderr: '',
              timedOut: false,
            });
          },
          readFile: () => Promise.resolve(text),
        } satisfies VerifierHandle),
    },
  };
  return { runs, evidence, deps, execs };
}

describe('verify step with fault injection', () => {
  it('passes --fault drop-tenant-filter for a demo run with a fault', async () => {
    const injected = applyFault(demoRun, AGENT).patch;
    const t = verifier(demoRun, true, injected);
    await runVerifyStep(t.deps, RUN);
    const argv = t.execs[0] ?? [];
    expect(argv.slice(-2)).toEqual(['--fault', 'drop-tenant-filter']);
    const result = (await t.evidence.list(RUN)).find((e) => e.kind === 'verify_result');
    expect(JSON.stringify(result?.payload)).toContain('injected by Lathe');
  });
  it('omits --fault for demo runs without a fault and for ordinary runs', async () => {
    for (const run of [
      { demo: true, faultInjection: null, repairAttempts: 0 },
      { demo: false, faultInjection: null, repairAttempts: 0 },
    ]) {
      const t = verifier(run, false, PLAIN);
      await runVerifyStep(t.deps, RUN);
      expect(t.execs[0]).not.toContain('--fault');
    }
  });
  it('a fault on a non-demo run errors before any verifier starts', async () => {
    const t = verifier({ ...demoRun, demo: false }, false, PLAIN);
    expect(await runVerifyStep(t.deps, RUN)).toEqual({
      outcome: 'error',
      reason: 'verification_error',
    });
    expect(t.execs).toEqual([]);
  });
  it('a patch that still contains the injected change cannot reach AWAITING_APPROVAL', async () => {
    const injected = applyFault(demoRun, AGENT).patch;
    const t = verifier(demoRun, true, injected);
    const r = await runVerifyStep(t.deps, RUN);
    expect(r).toMatchObject({ outcome: 'failed', next: 'REPAIRING' });
    expect(await t.runs.listNonTerminal().then((rs) => rs[0]?.state)).toBe('REPAIRING');
  });
});
