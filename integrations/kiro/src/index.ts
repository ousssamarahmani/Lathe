/**
 * @lathe/kiro-integration: ACP adapter for Kiro (task P4-01).
 * Sandbox runner (P4-02) and runtime agent configs (P4-04) are not part of this package yet.
 * The fake ACP server lives in `src/testing/` and is imported by tests only.
 */
export { AcpKiroAdapter, type AcpAdapterOptions, type SessionStats } from './adapter.js';
export { KiroAdapterError, KiroTimeoutError, type AdapterErrorCode } from './errors.js';
export {
  decidePermission,
  type PermissionDecision,
  type PermissionPolicy,
} from './permission-policy.js';
export {
  ALLOWED_ENV_NAMES,
  buildSandboxRunArgs,
  type SandboxRunContext,
} from './sandbox/docker-args.js';
export {
  DockerSandboxRunner,
  createDockerSpawn,
  nodeCommandRunner,
  pickDockerEnv,
  type CommandResult,
  type CommandRunner,
  type DockerSandboxOptions,
} from './sandbox/docker-sandbox.js';
export {
  KIRO_EGRESS_HOSTS,
  buildProxyFilter,
  buildProxyRunArgs,
  buildNetworkCreateArgs,
  isHostAllowed,
} from './sandbox/egress-proxy.js';
export { SandboxError, type SandboxErrorCode } from './sandbox/errors.js';
export {
  hostSpawn,
  type AcpProcess,
  type ExitInfo,
  type SpawnContext,
  type SpawnFn,
} from './process.js';
export {
  FOUNDATION_PATH,
  PROTECTED_PREFIXES,
  Worktree,
  createGitRunner,
  removeDir,
  type GitRunner,
  type PatchResult,
  type ReproducibleResult,
  type WorktreeOptions,
} from './sandbox/worktree.js';
