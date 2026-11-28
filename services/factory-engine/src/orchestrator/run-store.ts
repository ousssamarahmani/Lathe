import type { EngineCapability } from './capability.js';
import { RunStateError } from './errors.js';
import {
  nextActionFor,
  nextSnapshot,
  type NextAction,
  type RunSnapshot,
  type RunState,
} from './state-machine.js';

export interface RunEventDraft {
  readonly type: 'state_changed';
  readonly payload: {
    readonly from: RunState;
    readonly to: RunState;
    readonly repairAttempts: number;
    readonly reason?: string;
  };
}

export const MAX_REASON_LENGTH = 200;
/**
 * What `decide` returns. The caller proposes the next snapshot and an optional
 * reason. The event is never supplied by the caller: the store builds it from
 * (current, next) with `buildTransitionEvent`, so it always equals the transition.
 */
export interface TransitionDecision {
  readonly next: RunSnapshot;
  readonly reason?: string;
}

/**
 * Persistence port. `transition` must load the run (locking it), call `decide`,
 * and write the new snapshot plus the event atomically. If `decide` throws,
 * nothing is written. Org scoping is inside the implementation.
 */
export interface RunStore {
  /**
   * Implementations must call `assertValidDecision` on the locked row before
   * writing. `capability` absent means the caller holds no Engine capability.
   */
  transition(
    runId: string,
    decide: (current: RunSnapshot) => TransitionDecision,
    capability?: EngineCapability,
  ): Promise<RunSnapshot>;
  listNonTerminal(): Promise<readonly RunSnapshot[]>;
}

/**
 * Re-validates a decision against the locked current row: `next` must equal
 * `nextSnapshot(current, next.state, capability)`. Throws a typed RunStateError.
 */
export function assertValidDecision(
  current: RunSnapshot,
  next: RunSnapshot,
  capability?: EngineCapability,
): void {
  const expected = nextSnapshot(current, next.state, capability);
  if (
    next.runId !== expected.runId ||
    next.state !== expected.state ||
    next.repairAttempts !== expected.repairAttempts
  ) {
    throw new RunStateError(
      'illegal_transition',
      `Transition ${current.state} -> ${next.state} does not match the state machine`,
    );
  }
}

/**
 * Builds the run_events row for a validated transition. Only `reason` comes from
 * the caller: it must be a string of at most MAX_REASON_LENGTH characters.
 */
export function buildTransitionEvent(
  current: RunSnapshot,
  next: RunSnapshot,
  reason: unknown,
): RunEventDraft {
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH)) {
    throw new RunStateError('illegal_transition', 'Transition reason is invalid');
  }
  return {
    type: 'state_changed',
    payload: {
      from: current.state,
      to: next.state,
      repairAttempts: next.repairAttempts,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

export interface TransitionOptions {
  readonly capability?: EngineCapability;
  /** Short operator-facing note, stored in the event. Never put secrets here. */
  readonly reason?: string;
}

export async function transitionRun(
  store: RunStore,
  runId: string,
  to: RunState,
  options: TransitionOptions = {},
): Promise<RunSnapshot> {
  const reason = options.reason?.slice(0, MAX_REASON_LENGTH);
  return store.transition(
    runId,
    (current) => {
      const next = nextSnapshot(current, to, options.capability);
      return { next, ...(reason === undefined ? {} : { reason }) };
    },
    options.capability,
  );
}

export interface ResumeItem {
  readonly runId: string;
  readonly state: RunState;
  readonly repairAttempts: number;
  readonly action: NextAction;
}

/** After a restart: every non-terminal run with the action the Engine must take next. */
export async function resumeRuns(store: RunStore): Promise<readonly ResumeItem[]> {
  const runs = await store.listNonTerminal();
  const items: ResumeItem[] = [];
  for (const run of runs) {
    if (run.state === 'DELIVERED' || run.state === 'FAILED' || run.state === 'CANCELLED') continue;
    items.push({ ...run, action: nextActionFor(run.state) });
  }
  return items;
}

export { RunStateError };
