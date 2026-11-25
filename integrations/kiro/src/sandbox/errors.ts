export type SandboxErrorCode =
  | 'invalid_spec'
  | 'invalid_host_path'
  | 'missing_host_mount'
  | 'invalid_name'
  | 'docker_failed'
  | 'patch_failed'
  | 'worktree_failed'
  | 'protected_path_present'
  | 'patch_outside_target'
  | 'patch_unsafe_entry'
  | 'patch_not_reproducible';

/** Typed failure of the sandbox runner. Messages never contain credential values. */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  constructor(code: SandboxErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SandboxError';
    this.code = code;
  }
}
