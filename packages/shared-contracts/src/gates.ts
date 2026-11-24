/**
 * C3 Verification gates: gate results and the `lathe-verify` input and output.
 *
 * Status: FROZEN, v1, 2026-11-17. Changes need a handoff request to `architect`.
 * Owner: architect.
 * Produced by: `packages/verification-harness` (`lathe-verify` CLI, task P2-01).
 * Consumed by: `services/factory-engine` (pipeline verify step, evidence),
 *   `apps/workspace` (through the Engine API), CI (task P8-02).
 *
 * The Engine runs `lathe-verify` as a separate process and parses its JSON report
 * with `VerificationReport`. It never imports harness code.
 *
 * CLI shape (implemented in P2-01):
 *   lathe-verify <app> --worktree <dir> --commit <sha> --report <file> --patch <file> [--fault <name>]
 * `--patch` is the agent's canonical patch (C2 `Patch.diff`, plain `git diff`); without it the
 * protected-paths gate reports `error`, so a run without a patch can never pass (v1.2).
 * Exit codes are in `VERIFY_EXIT_CODES`.
 *
 * `resultHash` is the sha256 of this UTF-8 preimage, each part on its own line,
 * ending with a newline:
 *   lathe-verify/v1
 *   <commit>
 *   <harnessSha256>
 *   <policySha256>
 *   <gate id>=<status>   (one line per gate, in GATE_ORDER)
 * The same inputs and outcomes therefore always give the same hash.
 *
 * Rules encoded in `VerificationReport`, so a report cannot claim a pass it did
 * not earn:
 *   - gates appear exactly once each, in `GATE_ORDER`;
 *   - gates run fail-fast: after the first non-passing gate, all later gates are `not_run`;
 *   - `overall` follows from the gates (`error` beats `failed` beats `passed`);
 *   - a failed gate carries at least one finding;
 *   - an injected demo fault is always labeled `injected by Lathe`.
 */
import { z } from 'zod';
import {
  FAULT_LABEL,
  FaultName,
  GitSha,
  IsoDateTime,
  RepoRelativePath,
  Sha256,
  Slug,
} from './common.js';

/** Gates in execution order (`.kiro/steering/testing.md`). */
export const GateId = z.enum([
  'protected-paths',
  'static',
  'tests',
  'tenant-isolation',
  'rbac',
  'properties',
  'security',
]);
export type GateId = z.infer<typeof GateId>;

/** Execution order. Equal to the declaration order of `GateId`. */
export const GATE_ORDER: readonly GateId[] = GateId.options;

export const GateStatus = z.enum(['passed', 'failed', 'error', 'not_run']);
export type GateStatus = z.infer<typeof GateStatus>;

export const Severity = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof Severity>;

/** One problem found by a gate. Findings never contain secret values. */
export const Finding = z.strictObject({
  ruleId: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,99}$/),
  message: z.string().min(1).max(2_000),
  severity: Severity,
  path: RepoRelativePath.optional(),
  line: z.number().int().min(1).optional(),
});
export type Finding = z.infer<typeof Finding>;

export const Artifact = z.strictObject({
  name: z.string().min(1).max(200),
  /** Path inside the report directory. */
  path: RepoRelativePath,
  sha256: Sha256,
});
export type Artifact = z.infer<typeof Artifact>;

export const GateResult = z
  .strictObject({
    gate: GateId,
    status: GateStatus,
    durationMs: z.number().int().min(0),
    summary: z.string().max(500),
    findings: z.array(Finding).max(1_000),
    artifacts: z.array(Artifact).max(100),
  })
  .superRefine((g, ctx) => {
    if (g.status === 'failed' && g.findings.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['findings'],
        message: 'a failed gate must report at least one finding',
      });
    if (g.status === 'not_run' && (g.findings.length > 0 || g.durationMs > 0))
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'a gate that did not run has no findings and no duration',
      });
  });
export type GateResult = z.infer<typeof GateResult>;

export const OverallStatus = z.enum(['passed', 'failed', 'error']);
export type OverallStatus = z.infer<typeof OverallStatus>;

/** Label attached to a report when the Engine injected a demo fault (task P5-05). */
export const FaultInjectionRecord = z.strictObject({
  name: FaultName,
  label: z.literal(FAULT_LABEL),
});
export type FaultInjectionRecord = z.infer<typeof FaultInjectionRecord>;

/** Input the Engine passes to `lathe-verify`, mirrored by the CLI flags. */
export const VerifyRequest = z.strictObject({
  app: Slug,
  /** Absolute path of the clean worktree with the patch applied, inside the verifier container. */
  worktree: z.string().regex(/^\/[^\0]*$/, 'expected an absolute path'),
  commit: GitSha,
  faultInjection: FaultInjectionRecord.nullable(),
});
export type VerifyRequest = z.infer<typeof VerifyRequest>;

export const VERIFY_EXIT_CODES = { passed: 0, failed: 1, error: 2 } as const satisfies Record<
  OverallStatus,
  number
>;

export const VerificationReport = z
  .strictObject({
    schemaVersion: z.literal(1),
    app: Slug,
    commit: GitSha,
    harnessSha256: Sha256,
    policySha256: Sha256,
    resultHash: Sha256,
    startedAt: IsoDateTime,
    finishedAt: IsoDateTime,
    overall: OverallStatus,
    gates: z.array(GateResult),
    faultInjection: FaultInjectionRecord.nullable(),
  })
  .superRefine((r, ctx) => {
    const ids = r.gates.map((g) => g.gate);
    if (ids.length !== GATE_ORDER.length || ids.some((id, i) => id !== GATE_ORDER[i])) {
      ctx.addIssue({
        code: 'custom',
        path: ['gates'],
        message: `gates must be exactly ${GATE_ORDER.join(', ')} in that order`,
      });
      return;
    }
    const firstStop = r.gates.findIndex((g) => g.status !== 'passed');
    r.gates.forEach((g, i) => {
      const mustNotRun = firstStop !== -1 && i > firstStop;
      if (mustNotRun && g.status !== 'not_run')
        ctx.addIssue({
          code: 'custom',
          path: ['gates', i, 'status'],
          message: 'gates after the first non-passing gate must be not_run',
        });
      if (!mustNotRun && g.status === 'not_run')
        ctx.addIssue({
          code: 'custom',
          path: ['gates', i, 'status'],
          message: 'not_run is only allowed after a failed or errored gate',
        });
    });
    const expected: OverallStatus = r.gates.some((g) => g.status === 'error')
      ? 'error'
      : r.gates.some((g) => g.status === 'failed')
        ? 'failed'
        : 'passed';
    if (r.overall !== expected)
      ctx.addIssue({
        code: 'custom',
        path: ['overall'],
        message: `overall must be ${expected} for these gate results`,
      });
    if (Date.parse(r.finishedAt) < Date.parse(r.startedAt))
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'finishedAt is before startedAt',
      });
  });
export type VerificationReport = z.infer<typeof VerificationReport>;
