import { isEngineCapability, type EngineCapability } from './capability.js';
import { RunStateError } from './errors.js';

export const RUN_STATES = [
  'DEFINED',
  'PLANNED',
  'BUILDING',
  'VERIFYING',
  'REPAIRING',
  'AWAITING_APPROVAL',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** States that mean "verification passed". Only Engine code may enter them. */
export const PASSING_STATES = ['AWAITING_APPROVAL', 'DELIVERED'] as const;
export type PassingState = (typeof PASSING_STATES)[number];
export type NonPassingState = Exclude<RunState, PassingState>;

export const TERMINAL_STATES = ['DELIVERED', 'FAILED', 'CANCELLED'] as const;
export const MAX_REPAIR_ATTEMPTS = 3;

const ALLOWED: Readonly<Record<RunState, readonly RunState[]>> = {
  DEFINED: ['PLANNED', 'FAILED', 'CANCELLED'],
  PLANNED: ['BUILDING', 'FAILED', 'CANCELLED'],
  BUILDING: ['VERIFYING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['REPAIRING', 'AWAITING_APPROVAL', 'FAILED', 'CANCELLED'],
  REPAIRING: ['BUILDING', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['DELIVERED', 'FAILED', 'CANCELLED'],
  DELIVERED: [],
  FAILED: [],
  CANCELLED: [],
};

export interface RunSnapshot {
  readonly runId: string;
  readonly state: RunState;
  readonly repairAttempts: number;
}

export function isTerminal(state: RunState): boolean {
  return (TERMINAL_STATES as readonly RunState[]).includes(state);
}

export function isPassingState(state: RunState): state is PassingState {
  return (PASSING_STATES as readonly RunState[]).includes(state);
}

export function allowedTransitions(from: RunState): readonly RunState[] {
  return ALLOWED[from];
}

/**
 * Pure transition. Throws RunStateError for an illegal edge, for a passing
 * state without the Engine capability, and when a fourth repair is requested.
 * VERIFYING -> REPAIRING consumes one repair attempt.
 */
export function nextSnapshot(
  current: RunSnapshot,
  to: RunState,
  capability?: EngineCapability,
): RunSnapshot {
  if (!ALLOWED[current.state].includes(to)) {
    throw new RunStateError('illegal_transition', `Cannot move run from ${current.state} to ${to}`);
  }
  if (isPassingState(to) && !isEngineCapability(capability)) {
    throw new RunStateError('passing_state_forbidden', `Only Engine code may set ${to}`);
  }
  if (to === 'REPAIRING') {
    if (current.repairAttempts >= MAX_REPAIR_ATTEMPTS) {
      throw new RunStateError(
        'repair_limit_exceeded',
        `Run already used ${MAX_REPAIR_ATTEMPTS} repair attempts`,
      );
    }
    return { ...current, state: to, repairAttempts: current.repairAttempts + 1 };
  }
  return { ...current, state: to };
}

export type NextAction =
  | 'plan'
  | 'start_build'
  | 'restart_build'
  | 'run_verification'
  | 'run_repair'
  | 'await_human_approval';

/** What the Engine must do next for a non-terminal run. Sandboxes do not survive a restart. */
export function nextActionFor(
  state: Exclude<RunState, 'DELIVERED' | 'FAILED' | 'CANCELLED'>,
): NextAction {
  switch (state) {
    case 'DEFINED':
      return 'plan';
    case 'PLANNED':
      return 'start_build';
    case 'BUILDING':
      return 'restart_build';
    case 'VERIFYING':
      return 'run_verification';
    case 'REPAIRING':
      return 'run_repair';
    case 'AWAITING_APPROVAL':
      return 'await_human_approval';
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}
