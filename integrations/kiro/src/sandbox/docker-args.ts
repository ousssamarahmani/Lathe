import { SandboxSpec, type MountSource } from '@lathe/shared-contracts';
import { SandboxError } from './errors.js';
import { PROXY_URL } from './egress-proxy.js';

/** Fixed non-root uid:gid of the `agent` user in the sandbox image. */
export const SANDBOX_USER = '10001:10001';
/** HOME inside the sandbox. A tmpfs for agents; the session volume mounts below it. */
export const SANDBOX_HOME = '/home/agent';

/** Env names that may appear in `docker run -e`. Anything else is a defect. */
export const ALLOWED_ENV_NAMES: readonly string[] = [
  'HOME',
  'LATHE_SANDBOX',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'KIRO_API_KEY',
];

export interface SandboxRunContext {
  /** Container name, `^[a-z0-9][a-z0-9_.-]{2,62}$`. */
  name: string;
  /**
   * Internal network whose only peer with a route out is the egress proxy. Required for an
   * agent with a non-empty allow-list; otherwise the container gets `--network none`.
   */
  network?: string | undefined;
  /**
   * Host side of each mount: an absolute directory for bind mounts, a docker volume
   * name for `kiro-session`. Every source in the spec needs an entry.
   */
  hostMounts: Readonly<Partial<Record<MountSource, string>>>;
}

const NAME = /^[a-z0-9][a-z0-9_.-]{2,62}$/;
const VOLUME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
/** Absolute POSIX or Windows drive path; no characters that could split a `--mount` value. */
const HOST_DIR = /^(\/|[A-Za-z]:[\\/])[^,"'\r\n\0=]*$/;

function hostSourceFor(source: MountSource, value: string | undefined): string {
  if (value === undefined)
    throw new SandboxError('missing_host_mount', `no host path for mount source ${source}`);
  if (source === 'kiro-session') {
    if (!VOLUME.test(value))
      throw new SandboxError('invalid_host_path', 'kiro-session must be a docker volume name');
    return value;
  }
  if (!HOST_DIR.test(value) || /docker\.sock|\.\.([\\/]|$)/i.test(value))
    throw new SandboxError('invalid_host_path', `unsafe host path for ${source}`);
  return value;
}

/**
 * Builds the argument list for `docker run -d` from a C2 sandbox spec. Pure: no I/O,
 * no environment reads. Anything outside the spec's closed vocabulary throws a SandboxError.
 *
 * Secrets: `-e KIRO_API_KEY` is passed by name only, so docker reads the value from the
 * environment of the `docker` process and it never appears in the argument list.
 */
export function buildSandboxRunArgs(specInput: unknown, ctx: SandboxRunContext): string[] {
  const parsed = SandboxSpec.safeParse(specInput);
  if (!parsed.success)
    throw new SandboxError('invalid_spec', `invalid sandbox spec: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  const spec = parsed.data;
  if (!NAME.test(ctx.name)) throw new SandboxError('invalid_name', 'invalid container name');

  const isAgent = spec.purpose === 'agent';
  const needsProxy = isAgent && spec.egressAllowlist.length > 0;
  if (needsProxy) {
    if (ctx.network === undefined || !NAME.test(ctx.network))
      throw new SandboxError('invalid_name', 'an agent with egress needs the internal network');
  }

  const args: string[] = [
    'run',
    '-d',
    '--name',
    ctx.name,
    '--user',
    SANDBOX_USER,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
  ];
  if (isAgent)
    args.push(
      '--tmpfs',
      `${SANDBOX_HOME}:rw,noexec,nosuid,uid=10001,gid=10001,mode=0700,size=256m`,
    );
  args.push(
    '--cpus',
    String(spec.limits.cpus),
    '--memory',
    `${spec.limits.memoryMb}m`,
    '--pids-limit',
    String(spec.limits.pids),
    '--network',
    needsProxy ? (ctx.network as string) : 'none',
  );

  for (const m of spec.mounts) {
    const host = hostSourceFor(m.source, ctx.hostMounts[m.source]);
    const type = m.source === 'kiro-session' ? 'volume' : 'bind';
    const readonly = m.mode === 'ro' ? ',readonly' : '';
    args.push('--mount', `type=${type},source=${host},target=${m.containerPath}${readonly}`);
  }

  const env: string[] = [
    `HOME=${isAgent ? SANDBOX_HOME : '/tmp'}`,
    'LATHE_SANDBOX=1',
    ...(needsProxy
      ? [
          `HTTPS_PROXY=${PROXY_URL}`,
          `HTTP_PROXY=${PROXY_URL}`,
          `https_proxy=${PROXY_URL}`,
          `http_proxy=${PROXY_URL}`,
        ]
      : []),
    ...spec.secretEnv, // by name only
  ];
  for (const e of env) args.push('-e', e);

  // The container idles; Kiro runs through `docker exec`.
  args.push('--entrypoint', 'sleep', spec.image, 'infinity');
  return args;
}
