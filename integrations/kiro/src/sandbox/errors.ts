export type SandboxErrorCode =
  | 'invalid_spec'
  | 'invalid_host_path'
  | 'missing_host_mount'
  | 'invalid_name'
  | 'docker_failed'
  | 'patch_failed'
  | 'unsafe_git_metadata';

/** Typed failure of the sandbox runner. Messages never contain credential values. */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  constructor(code: SandboxErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SandboxError';
    this.code = code;
  }
}
