/**
 * C2 Kiro adapter and sandbox interfaces.
 *
 * Status: FROZEN, v1.2, 2026-11-21. Changes need a handoff request to `architect`.
 * v1.2 (spike P0-04, ADR 0003): `kiro-session` mount for a login session, an optional
 *   `permissionPolicy` on sessions, and `permission_request` events.
 *   PR #15 review fix: the `kiro-session` mount path is fixed to `KIRO_SESSION_PATH`
 *   (`/home/agent/.kiro`), outside `/workspace`, and may not overlap any other mount, so
 *   the token cannot sit inside the target app or reach the patch.
 * Owner: architect.
 * Implemented by: `integrations/kiro` (ACP adapter, fake ACP server, Docker sandbox runner).
 * Consumed by: `services/factory-engine` (pipeline), wired in only in `src/main.ts`.
 *
 * The adapter is independent of how Kiro authenticates. That choice is made by
 * spike P0-04 and recorded in ADR 0003. If the chosen path needs a credential
 * other than `KIRO_API_KEY`, `SecretEnvName` changes through a handoff.
 *
 * Security rules encoded here (`.kiro/steering/security.md`):
 *   - runtime sessions never receive MCP servers (`mcpServers` must be empty);
 *   - sandbox hardening flags are literals, so a spec cannot relax them;
 *   - the only mount sources are the target app (rw), the application foundation
 *     (ro) and Kiro's runtime config; the harness and `.github/` cannot be mounted;
 *   - only the Kiro credential can enter an agent sandbox, and none enters a verifier;
 *   - everything an agent emits is untrusted data, never a verification result.
 */
import { z } from 'zod';
import { GitSha, IsoDateTime, RepoRelativePath, RunId, SessionId, Sha256, Slug } from './common.js';

export const AgentProfile = z.enum(['planner', 'builder', 'repair']);
export type AgentProfile = z.infer<typeof AgentProfile>;

/** Runtime sessions get no MCP servers. Only an empty array validates. */
export const NoMcpServers = z.array(z.never()).length(0);

/** Absolute path inside the container, under `/workspace`. */
export const ContainerPath = z
  .string()
  .regex(/^\/workspace(\/[A-Za-z0-9._@-]+)*$/, 'expected a path under /workspace')
  .refine((p) => !p.split('/').includes('..'), '".." segments are not allowed');

export const SessionRequest = z.strictObject({
  runId: RunId,
  agentProfile: AgentProfile,
  /** Working directory inside the sandbox. */
  cwd: ContainerPath,
  /** Prompt text. The Engine builds it from the spec, plan task and failure evidence. */
  prompt: z.string().min(1).max(200_000),
  /** Hard limit for the whole session. The adapter cancels and reports `timeout` when it is reached. */
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  mcpServers: NoMcpServers,
  /**
   * How the adapter answers Kiro's `session/request_permission` (spike finding 1).
   * Absent means every request is rejected (deny by default).
   */
  permissionPolicy: z
    .strictObject({
      /** Tool calls may write only under these paths. */
      allowWritesUnder: z.array(ContainerPath).min(1).max(4),
      /** Whether shell commands may run at all. */
      allowCommands: z.boolean(),
    })
    .optional(),
});
export type SessionRequest = z.infer<typeof SessionRequest>;

/** Why a turn ended. ACP stop reasons plus `timeout` and `error` added by the adapter. */
export const StopReason = z.enum([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
  'timeout',
  'error',
]);
export type StopReason = z.infer<typeof StopReason>;

export const ToolCallStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

const eventBase = {
  sessionId: SessionId,
  /** Monotonic per session, starting at 0. */
  seq: z.number().int().min(0),
  at: IsoDateTime,
};

/**
 * Events streamed from a session. The adapter maps ACP `session/update`
 * notifications onto these. All text and tool payloads are untrusted.
 */
export const KiroEvent = z.discriminatedUnion('type', [
  z.strictObject({
    ...eventBase,
    type: z.literal('agent_message_chunk'),
    text: z.string().max(100_000),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('tool_call'),
    toolCallId: z.string().min(1).max(200),
    title: z.string().max(500),
    status: ToolCallStatus,
    input: z.unknown(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('tool_call_update'),
    toolCallId: z.string().min(1).max(200),
    status: ToolCallStatus,
    output: z.unknown().optional(),
  }),
  z.strictObject({ ...eventBase, type: z.literal('turn_end'), stopReason: StopReason }),
  /** A permission request from Kiro and the adapter's answer under the session's policy. */
  z.strictObject({
    ...eventBase,
    type: z.literal('permission_request'),
    toolCallId: z.string().min(1).max(200),
    title: z.string().max(500),
    decision: z.enum(['allowed', 'rejected']),
    /** Why, in policy terms, for example `write outside /workspace/app`. */
    reason: z.string().max(500),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('adapter_error'),
    code: z.enum(['spawn_failed', 'auth_required', 'protocol_error', 'process_exited', 'timeout']),
    message: z.string().max(2_000),
  }),
]);
export type KiroEvent = z.infer<typeof KiroEvent>;

export const TurnResult = z.strictObject({
  stopReason: StopReason,
  eventCount: z.number().int().min(0),
});
export type TurnResult = z.infer<typeof TurnResult>;

/** A started Kiro session inside a sandbox. */
export interface KiroSession {
  readonly id: SessionId;
  /** All events of the session in `seq` order. Ends after the session is closed. */
  events(): AsyncIterable<KiroEvent>;
  /** Sends one prompt and resolves when the turn ends. */
  prompt(text: string): Promise<TurnResult>;
  /** Cancels the running turn (ACP `session/cancel`). Safe to call more than once. */
  cancel(reason: string): Promise<void>;
  /** Ends the session and its process. Safe to call more than once. */
  close(): Promise<void>;
}

/** Starts Kiro sessions. Implementations must not leave child processes behind. */
export interface KiroAdapter {
  start(request: SessionRequest, sandbox: SandboxHandle): Promise<KiroSession>;
}

/** The only credential that may enter an agent sandbox. */
export const SecretEnvName = z.enum(['KIRO_API_KEY']);
export type SecretEnvName = z.infer<typeof SecretEnvName>;

/**
 * `kiro-session`: the Kiro login session volume (mode B, ADR 0003). It holds a
 * credential: agent sandboxes only, never a verifier. Kiro refreshes the token,
 * so it may be read-write.
 */
export const MountSource = z.enum([
  'target-app',
  'application-foundation',
  'kiro-runtime-config',
  'kiro-session',
]);
export type MountSource = z.infer<typeof MountSource>;

/**
 * The only container path the `kiro-session` mount may use. It is outside
 * `/workspace`, so the token can never sit inside the target app or any other
 * mount, and so never reach the patch.
 */
export const KIRO_SESSION_PATH = '/home/agent/.kiro';

/** Absolute container path with no `..` segment. */
const AbsoluteContainerPath = z
  .string()
  .regex(/^(\/[A-Za-z0-9._@-]+)+$/, 'expected an absolute path')
  .refine((p) => !p.split('/').includes('..'), '".." segments are not allowed');

export const Mount = z
  .strictObject({
    source: MountSource,
    containerPath: AbsoluteContainerPath,
    mode: z.enum(['ro', 'rw']),
  })
  .refine(
    (m) => m.source === 'target-app' || m.source === 'kiro-session' || m.mode === 'ro',
    'only the target app and the Kiro session may be mounted read-write',
  )
  .refine(
    (m) =>
      m.source === 'kiro-session'
        ? m.containerPath === KIRO_SESSION_PATH
        : ContainerPath.safeParse(m.containerPath).success,
    `the kiro-session mount must be ${KIRO_SESSION_PATH}; every other mount must be under /workspace`,
  );
export type Mount = z.infer<typeof Mount>;

/** True when one path equals, contains or is nested inside the other. */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/** Hostname for the egress allow-list, for example `api.example.com`. No wildcards. */
export const EgressHost = z
  .string()
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'expected a lowercase hostname',
  );

/** Hardening flags. Every value is a literal, so none can be relaxed. */
export const SandboxHardening = z.strictObject({
  user: z.literal('non-root'),
  capDrop: z.literal('ALL'),
  noNewPrivileges: z.literal(true),
  readOnlyRootFs: z.literal(true),
  privileged: z.literal(false),
  dockerSocket: z.literal(false),
});
export type SandboxHardening = z.infer<typeof SandboxHardening>;

export const SandboxSpec = z
  .strictObject({
    purpose: z.enum(['agent', 'verifier']),
    /** Image pinned by digest, for example `lathe/sandbox@sha256:<64 hex>`. */
    image: z
      .string()
      .regex(
        /^[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/,
        'image must be pinned by sha256 digest',
      ),
    mounts: z.array(Mount).min(1).max(5),
    secretEnv: z.array(SecretEnvName).max(1),
    egressAllowlist: z.array(EgressHost).max(20),
    limits: z.strictObject({
      cpus: z.number().min(0.25).max(8),
      memoryMb: z.number().int().min(256).max(16_384),
      pids: z.number().int().min(64).max(4_096),
    }),
    hardening: SandboxHardening,
  })
  .superRefine((s, ctx) => {
    const sources = s.mounts.map((m) => m.source);
    if (sources.filter((x, i) => sources.indexOf(x) !== i).length > 0)
      ctx.addIssue({
        code: 'custom',
        path: ['mounts'],
        message: 'each mount source may appear once',
      });
    const session = s.mounts.find((m) => m.source === 'kiro-session');
    if (
      session &&
      s.mounts.some((m) => m !== session && pathsOverlap(m.containerPath, session.containerPath))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['mounts'],
        message: 'the kiro-session mount must not overlap any other mount',
      });
    if (!sources.includes('target-app'))
      ctx.addIssue({ code: 'custom', path: ['mounts'], message: 'the target app must be mounted' });
    if (s.purpose === 'verifier') {
      if (s.secretEnv.length > 0)
        ctx.addIssue({
          code: 'custom',
          path: ['secretEnv'],
          message: 'a verifier receives no credentials',
        });
      if (s.egressAllowlist.length > 0)
        ctx.addIssue({
          code: 'custom',
          path: ['egressAllowlist'],
          message: 'a verifier has no egress',
        });
      if (sources.includes('kiro-runtime-config') || sources.includes('kiro-session'))
        ctx.addIssue({
          code: 'custom',
          path: ['mounts'],
          message: 'a verifier does not run Kiro and holds no Kiro credential',
        });
    }
  });
export type SandboxSpec = z.infer<typeof SandboxSpec>;

export const SandboxCreateInput = z.strictObject({
  targetApp: Slug,
  baseCommit: GitSha,
});
export type SandboxCreateInput = z.infer<typeof SandboxCreateInput>;

/** Canonical patch produced from the sandbox worktree against `baseCommit`. */
export const Patch = z.strictObject({
  baseCommit: GitSha,
  /** Unified diff text. */
  diff: z.string().max(5_000_000),
  files: z.array(RepoRelativePath),
  sha256: Sha256,
});
export type Patch = z.infer<typeof Patch>;

export interface SandboxHandle {
  readonly id: string;
  readonly spec: SandboxSpec;
  /** Returns the agent's changes as a patch. Does not apply anything to the host repository. */
  collectPatch(): Promise<Patch>;
  /** Stops and removes the container and its volumes. Safe to call more than once. */
  destroy(): Promise<void>;
}

export interface SandboxRunner {
  create(spec: SandboxSpec, input: SandboxCreateInput): Promise<SandboxHandle>;
}
