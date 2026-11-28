export type RunErrorCode =
  | 'illegal_transition'
  | 'passing_state_forbidden'
  | 'repair_limit_exceeded'
  | 'run_not_found'
  | 'invalid_run_state';

/** Expected, typed failure of the run state machine. Mapped to HTTP only in the API layer. */
export class RunStateError extends Error {
  readonly code: RunErrorCode;
  constructor(code: RunErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunStateError';
    this.code = code;
  }
}
