/** Typed errors thrown by the ACP adapter. Each has a stable `code`. */

export type AdapterErrorCode =
  | 'spawn_failed'
  | 'auth_required'
  | 'protocol_error'
  | 'process_exited'
  | 'timeout'
  | 'invalid_request'
  | 'busy'
  | 'closed';

export class KiroAdapterError extends Error {
  readonly code: AdapterErrorCode;
  constructor(code: AdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KiroAdapterError';
    this.code = code;
  }
}

export type TimeoutPhase = 'handshake' | 'prompt' | 'cancel' | 'session';

export class KiroTimeoutError extends KiroAdapterError {
  readonly phase: TimeoutPhase;
  readonly timeoutMs: number;
  constructor(phase: TimeoutPhase, timeoutMs: number, detail: string) {
    super('timeout', `${phase} timed out after ${timeoutMs} ms: ${detail}`);
    this.name = 'KiroTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}
