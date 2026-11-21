import type { Artifact, FaultInjectionRecord, Finding, GateId } from '@lathe/shared-contracts';

/** What every gate receives. The worktree is a clean tree with the agent patch applied. */
export interface GateContext {
  readonly app: string;
  readonly worktree: string;
  readonly commit: string;
  readonly faultInjection: FaultInjectionRecord | null;
}

/** A gate's own verdict. `not_run` is set by the runner, never by a gate. */
export interface GateOutcome {
  readonly status: 'passed' | 'failed' | 'error';
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly artifacts: readonly Artifact[];
}

export interface Gate {
  readonly id: GateId;
  run(ctx: GateContext): Promise<GateOutcome>;
}

/** Placeholder for a gate whose task has not landed. It reports `error`, so it can never pass. */
export function notImplementedGate(id: GateId, task: string): Gate {
  return {
    id,
    run: () =>
      Promise.resolve({
        status: 'error',
        summary: `${id} gate is not implemented yet (task ${task}); it can never pass`,
        findings: [],
        artifacts: [],
      }),
  };
}
