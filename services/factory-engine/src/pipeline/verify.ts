import {
  Patch,
  SandboxSpec,
  VERIFY_EXIT_CODES,
  VerificationReport,
  VerifyRequest,
  type OverallStatus,
  type SandboxCreateInput,
  type SandboxHandle,
} from '@lathe/shared-contracts';
import { checkPatchPaths, CONTAINER_APP_PATH, CONTAINER_FOUNDATION_PATH } from './build.js';
import type { BuildSandboxConfig } from './build.js';
import { FaultInjectionError, faultFlagFor, type RunFaultSource } from './fault.js';
import type { SpecSource } from './plan.js';
import {
  canonicalJson,
  redactString,
  redactValue,
  sha256Hex,
  type EvidenceLog,
} from '../evidence/index.js';
import type { EngineCapability } from '../orchestrator/capability.js';
import {
  MAX_REPAIR_ATTEMPTS,
  RunStateError,
  transitionRun,
  type RunStore,
} from '../orchestrator/index.js';

/** Reads the patch stored by the build step (P5-02, `PatchStore.save`). */
export interface PatchSource {
  get(runId: string): Promise<Patch>;
}

export interface VerifyExecResult {
  /** Null when the process did not exit normally (killed, timed out). */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** A verifier sandbox. Commands run inside the container, never in the Engine process. */
export interface VerifierHandle extends SandboxHandle {
  /** Starts the ephemeral Postgres for this verifier. The provider wires its URL into the container. */
  startEphemeralPostgres(): Promise<void>;
  exec(argv: readonly string[], options: { readonly timeoutMs: number }): Promise<VerifyExecResult>;
  /** Reads a file inside the verifier container. Resolves null when it does not exist. */
  readFile(path: string): Promise<string | null>;
}

export interface VerifierSandboxContext extends SandboxCreateInput {
  readonly runId: string;
  /**
   * Where the harness is taken from. Always the trusted base commit, never the
   * patched tree. The provider must check the harness out of this ref.
   */
  readonly harnessRef: SandboxCreateInput['baseCommit'];
  /** Applied by the provider to a clean tree at `baseCommit`. */
  readonly patch: Patch;
  /** Path inside the container where the provider writes `patch.diff`. */
  readonly patchFile: string;
}

export interface VerifierSandboxProvider {
  /** Ids of agent sandboxes of this run that still exist. Must be empty before verification. */
  liveAgentSandboxes(runId: string): Promise<readonly string[]>;
  create(spec: SandboxSpec, context: VerifierSandboxContext): Promise<VerifierHandle>;
}

export interface VerifyStepDeps {
  readonly runs: RunStore;
  readonly evidence: EvidenceLog;
  readonly specs: SpecSource;
  readonly patches: PatchSource;
  readonly sandboxes: VerifierSandboxProvider;
  readonly capability: EngineCapability;
  readonly baseCommit: SandboxCreateInput['baseCommit'];
  readonly sandboxConfig: Pick<BuildSandboxConfig, 'image'>;
  /** Whole `lathe-verify` run. */
  readonly timeoutMs: number;
  /** Demo and fault setting of runs (P5-05). Absent means no run is a demo run. */
  readonly faults?: RunFaultSource;
}

export type VerifyErrorReason = 'verification_error';
export type VerifyRefusalReason = 'agent_sandbox_alive' | 'agent_sandbox_check_failed';
export type VerifyStepResult =
  | { readonly outcome: 'passed'; readonly bindingHash: string; readonly resultHash: string }
  | {
      readonly outcome: 'failed';
      readonly bindingHash: string;
      readonly failedGates: readonly string[];
      readonly next: 'REPAIRING' | 'FAILED';
    }
  | { readonly outcome: 'error'; readonly reason: VerifyErrorReason }
  | { readonly outcome: 'refused'; readonly reason: VerifyRefusalReason };

export const VERIFY_PATCH_FILE = '/tmp/lathe-agent.patch';
/** Clean tree (base commit plus agent patch) inside the verifier. */
export const VERIFY_WORKTREE = '/workspace';
/** Where lathe-verify --report writes the C3 JSON report, inside the verifier tmp. */
export const VERIFY_REPORT_FILE = '/tmp/lathe-verify-report.json';
const MAX_FINDINGS_IN_EVIDENCE = 50;
const MAX_STDERR_IN_EVIDENCE = 2_000;

/** C2 spec for a verifier: target app, foundation ro, no Kiro, no credentials, no egress. */
export function verifierSandboxSpec(config: Pick<BuildSandboxConfig, 'image'>): SandboxSpec {
  return SandboxSpec.parse({
    purpose: 'verifier',
    image: config.image,
    mounts: [
      { source: 'target-app', containerPath: CONTAINER_APP_PATH, mode: 'rw' },
      { source: 'application-foundation', containerPath: CONTAINER_FOUNDATION_PATH, mode: 'ro' },
    ],
    secretEnv: [],
    egressAllowlist: [],
    limits: { cpus: 2, memoryMb: 4096, pids: 1024 },
    hardening: {
      user: 'non-root',
      capDrop: 'ALL',
      noNewPrivileges: true,
      readOnlyRootFs: true,
      privileged: false,
      dockerSocket: false,
    },
  });
}

/**
 * Binds a verification to exactly what was verified: the base commit, the agent
 * patch, the harness and the policy. Any change to one of them changes the hash.
 */
export function bindingHash(input: {
  readonly commit: string;
  readonly patchSha256: string;
  readonly harnessSha256: string;
  readonly policySha256: string;
}): string {
  return sha256Hex(
    canonicalJson({
      commit: input.commit,
      patchSha256: input.patchSha256,
      harnessSha256: input.harnessSha256,
      policySha256: input.policySha256,
    }),
  );
}

type Judged =
  | { readonly ok: true; readonly report: VerificationReport; readonly status: OverallStatus }
  | { readonly ok: false; readonly detail: string };

const STATUS_BY_EXIT: Readonly<Record<number, OverallStatus>> = {
  [VERIFY_EXIT_CODES.passed]: 'passed',
  [VERIFY_EXIT_CODES.failed]: 'failed',
  [VERIFY_EXIT_CODES.error]: 'error',
};

/** lathe-verify <app> --worktree <dir> --commit <sha> --report <file> --patch <file> [--fault <name>] (C3). */
export function verifyArgv(request: VerifyRequest, patchFile: string): string[] {
  return [
    'lathe-verify',
    request.app,
    '--worktree',
    request.worktree,
    '--commit',
    request.commit,
    '--report',
    VERIFY_REPORT_FILE,
    '--patch',
    patchFile,
    ...(request.faultInjection ? ['--fault', request.faultInjection.name] : []),
  ];
}

/** Only a well-formed report whose status agrees with the exit code and inputs counts. */
function judge(
  result: VerifyExecResult,
  reportText: string | null,
  expected: { app: string; commit: string },
): Judged {
  if (result.timedOut) return { ok: false, detail: 'lathe-verify timed out' };
  if (result.exitCode === null) return { ok: false, detail: 'lathe-verify did not exit normally' };
  const byExit = STATUS_BY_EXIT[result.exitCode];
  if (byExit === undefined)
    return { ok: false, detail: `unexpected exit code ${String(result.exitCode)}` };
  if (reportText === null) return { ok: false, detail: 'report file is missing' };
  let json: unknown;
  try {
    json = JSON.parse(reportText);
  } catch {
    return { ok: false, detail: 'report file is not JSON' };
  }
  const parsed = VerificationReport.safeParse(json);
  if (!parsed.success) return { ok: false, detail: 'report failed schema validation' };
  const report = parsed.data;
  if (report.overall !== byExit)
    return { ok: false, detail: 'exit code and report status disagree' };
  if (report.app !== expected.app || report.commit !== expected.commit)
    return { ok: false, detail: 'report is for a different app or commit' };
  return { ok: true, report, status: byExit };
}

/**
 * Verify step (task P5-03). Run must be VERIFYING with the patch stored by the
 * build step. No agent sandbox of the run may exist. A fresh verifier gets a
 * clean tree at the base commit, the harness from that same commit, the patch
 * and an ephemeral Postgres, and runs `lathe-verify` as a process. Only that
 * process's report (checked against its exit code) decides the outcome. Anything
 * else (timeout, crash, bad output, mismatch) is an error, never a pass.
 * Pass -> AWAITING_APPROVAL. Fail -> REPAIRING while attempts remain, else FAILED.
 * Error -> FAILED (`verification_error`).
 */
export async function runVerifyStep(
  deps: VerifyStepDeps,
  runId: string,
): Promise<VerifyStepResult> {
  const current = (await deps.runs.listNonTerminal()).find((r) => r.runId === runId);
  if (!current) throw new RunStateError('run_not_found', 'Run not found');
  if (current.state !== 'VERIFYING')
    throw new RunStateError(
      'invalid_run_state',
      `Verify step needs VERIFYING, run is ${current.state}`,
    );

  // Fail closed: the agent sandbox must be gone, and we must be able to tell.
  let alive: readonly string[];
  try {
    alive = await deps.sandboxes.liveAgentSandboxes(runId);
  } catch {
    await deps.evidence.append(runId, 'verify_refused', { reason: 'agent_sandbox_check_failed' });
    return { outcome: 'refused', reason: 'agent_sandbox_check_failed' };
  }
  if (alive.length > 0) {
    await deps.evidence.append(runId, 'verify_refused', {
      reason: 'agent_sandbox_alive',
      count: alive.length,
    });
    return { outcome: 'refused', reason: 'agent_sandbox_alive' };
  }

  const error = async (detail: string): Promise<VerifyStepResult> => {
    await deps.evidence.append(runId, 'verify_error', {
      reason: 'verification_error',
      detail: redactString(detail).slice(0, 500),
    });
    await transitionRun(deps.runs, runId, 'FAILED', {
      capability: deps.capability,
      reason: 'verification_error',
    });
    return { outcome: 'error', reason: 'verification_error' };
  };

  const spec = await deps.specs.get(runId);
  const patch = Patch.safeParse(await deps.patches.get(runId));
  if (!patch.success) return error('stored patch failed schema validation');
  if (sha256Hex(patch.data.diff) !== patch.data.sha256 || patch.data.baseCommit !== deps.baseCommit)
    return error('stored patch does not match its hash or the base commit');
  // Defense in depth: P5-02 already rejects these. A patch reaching here with one is an error.
  if (!checkPatchPaths(patch.data, spec).ok) return error('stored patch touches forbidden paths');

  let faultInjection: VerifyRequest['faultInjection'] = null;
  if (deps.faults) {
    try {
      faultInjection = faultFlagFor(await deps.faults.get(runId));
    } catch (cause) {
      if (!(cause instanceof FaultInjectionError)) throw cause;
      return error(`fault configuration rejected: ${cause.code}`);
    }
  }
  // Shape tied to C3: VerifyRequest is the input, the flags mirror it.
  const request = VerifyRequest.parse({
    app: spec.targetApp,
    worktree: VERIFY_WORKTREE,
    commit: deps.baseCommit,
    faultInjection,
  });
  let sandbox: VerifierHandle | undefined;
  let result: VerifyExecResult;
  let reportText: string | null;
  try {
    sandbox = await deps.sandboxes.create(verifierSandboxSpec(deps.sandboxConfig), {
      targetApp: spec.targetApp,
      baseCommit: deps.baseCommit,
      harnessRef: deps.baseCommit,
      runId,
      patch: patch.data,
      patchFile: VERIFY_PATCH_FILE,
    });
    await sandbox.startEphemeralPostgres();
    result = await sandbox.exec(verifyArgv(request, VERIFY_PATCH_FILE), {
      timeoutMs: deps.timeoutMs,
    });
    // Only read the report if the process exited normally; judge() rejects the rest.
    reportText =
      result.timedOut || result.exitCode === null
        ? null
        : await sandbox.readFile(VERIFY_REPORT_FILE);
  } catch (cause) {
    return error(`verifier failed: ${cause instanceof Error ? cause.name : 'unknown error'}`);
  } finally {
    if (sandbox) await sandbox.destroy().catch(() => undefined);
  }

  const judged = judge(result, reportText, { app: spec.targetApp, commit: deps.baseCommit });
  if (!judged.ok) {
    if (result.stderr)
      await deps.evidence.append(runId, 'verify_stderr', {
        stderr: redactString(result.stderr).slice(0, MAX_STDERR_IN_EVIDENCE),
      });
    return error(judged.detail);
  }

  const { report } = judged;
  const binding = bindingHash({
    commit: report.commit,
    patchSha256: patch.data.sha256,
    harnessSha256: report.harnessSha256,
    policySha256: report.policySha256,
  });
  for (const gate of report.gates)
    await deps.evidence.append(
      runId,
      'verify_gate',
      redactValue({
        gate: gate.gate,
        status: gate.status,
        durationMs: gate.durationMs,
        summary: gate.summary,
        findings: gate.findings.slice(0, MAX_FINDINGS_IN_EVIDENCE),
        findingCount: gate.findings.length,
        artifacts: gate.artifacts,
      }),
    );
  await deps.evidence.append(runId, 'verify_result', {
    overall: report.overall,
    bindingHash: binding,
    resultHash: report.resultHash,
    commit: report.commit,
    patchSha256: patch.data.sha256,
    harnessSha256: report.harnessSha256,
    policySha256: report.policySha256,
    faultInjection: report.faultInjection,
  });

  if (judged.status === 'passed') {
    await transitionRun(deps.runs, runId, 'AWAITING_APPROVAL', {
      capability: deps.capability,
      reason: 'verification_passed',
    });
    return { outcome: 'passed', bindingHash: binding, resultHash: report.resultHash };
  }

  // status 'failed' (an 'error' status was handled as exit 2 -> error report)
  if (judged.status === 'error') return error('lathe-verify reported an error');
  const next = current.repairAttempts < MAX_REPAIR_ATTEMPTS ? 'REPAIRING' : 'FAILED';
  await transitionRun(deps.runs, runId, next, {
    capability: deps.capability,
    reason: 'verification_failed',
  });
  return {
    outcome: 'failed',
    bindingHash: binding,
    failedGates: report.gates.filter((g) => g.status === 'failed').map((g) => g.gate),
    next,
  };
}
