import {
  GATE_ORDER,
  VerificationReport,
  type FaultInjectionRecord,
  type GateId,
  type GateResult,
  type OverallStatus,
} from '@lathe/shared-contracts';
import type { Gate, GateContext, GateOutcome } from './gate.js';
import { resultHash } from './hash.js';

export interface RunInput {
  readonly app: string;
  readonly worktree: string;
  readonly commit: string;
  readonly faultInjection: FaultInjectionRecord | null;
  /** Agent patch as `git diff` text. Absent or null means no patch was given. */
  readonly patch?: string | null;
  readonly gates: Readonly<Record<GateId, Gate>>;
  readonly harnessSha256: string;
  readonly policySha256: string;
  /** Injected clock, so tests are deterministic. */
  readonly now: () => Date;
}

const MAX_SUMMARY = 500;
const clip = (s: string): string =>
  s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 1)}…` : s;
const errorOutcome = (summary: string): GateOutcome => ({
  status: 'error',
  summary: clip(summary),
  findings: [],
  artifacts: [],
});

/** Runs one gate. A gate that throws, misreports its id, or fails without findings yields `error`, never a pass. */
async function runOne(id: GateId, gate: Gate, ctx: GateContext): Promise<GateOutcome> {
  if (gate.id !== id) return errorOutcome(`gate registered as ${id} reports id ${gate.id}`);
  try {
    const outcome = await gate.run(ctx);
    if (outcome.status === 'failed' && outcome.findings.length === 0)
      return errorOutcome(`${id} reported a failure without findings`);
    return outcome;
  } catch (error) {
    return errorOutcome(
      `${id} gate threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Runs the gates in `GATE_ORDER`, fail-fast: after the first gate that does not
 * pass, the rest are `not_run`. The report is validated against contract C3
 * before it is returned, so the runner cannot emit a report that claims more
 * than its gates showed.
 */
export async function runVerification(input: RunInput): Promise<VerificationReport> {
  const ctx: GateContext = {
    app: input.app,
    worktree: input.worktree,
    commit: input.commit,
    faultInjection: input.faultInjection,
    patch: input.patch ?? null,
  };
  const startedAt = input.now();
  const gates: GateResult[] = [];
  let stopped = false;
  for (const id of GATE_ORDER) {
    if (stopped) {
      gates.push({
        gate: id,
        status: 'not_run',
        durationMs: 0,
        summary: 'not run: an earlier gate did not pass',
        findings: [],
        artifacts: [],
      });
      continue;
    }
    const t0 = input.now().getTime();
    const outcome = await runOne(id, input.gates[id], ctx);
    gates.push({
      gate: id,
      status: outcome.status,
      durationMs: Math.max(0, input.now().getTime() - t0),
      summary: clip(outcome.summary),
      findings: [...outcome.findings],
      artifacts: [...outcome.artifacts],
    });
    if (outcome.status !== 'passed') stopped = true;
  }
  const overall: OverallStatus = gates.some((g) => g.status === 'error')
    ? 'error'
    : gates.some((g) => g.status === 'failed')
      ? 'failed'
      : 'passed';
  return VerificationReport.parse({
    schemaVersion: 1,
    app: input.app,
    commit: input.commit,
    harnessSha256: input.harnessSha256,
    policySha256: input.policySha256,
    resultHash: resultHash({
      commit: input.commit,
      harnessSha256: input.harnessSha256,
      policySha256: input.policySha256,
      gates,
    }),
    startedAt: startedAt.toISOString(),
    finishedAt: input.now().toISOString(),
    overall,
    gates,
    faultInjection: input.faultInjection,
  });
}
