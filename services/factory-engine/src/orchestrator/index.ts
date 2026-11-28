// Deliberately does not export capability.ts: only Engine-internal code imports it.
export { RunStateError, type RunErrorCode } from './errors.js';
export {
  MAX_REPAIR_ATTEMPTS,
  PASSING_STATES,
  RUN_STATES,
  TERMINAL_STATES,
  allowedTransitions,
  isPassingState,
  isTerminal,
  nextActionFor,
  nextSnapshot,
  type NextAction,
  type NonPassingState,
  type PassingState,
  type RunSnapshot,
  type RunState,
} from './state-machine.js';
export {
  resumeRuns,
  transitionRun,
  type ResumeItem,
  type RunEventDraft,
  type RunStore,
  type TransitionDecision,
  type TransitionOptions,
} from './run-store.js';
export { PgRunStore } from './pg-run-store.js';
