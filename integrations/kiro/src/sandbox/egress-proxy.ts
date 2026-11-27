import { EgressHost } from '@lathe/shared-contracts';
import { SandboxError } from './errors.js';

/**
 * Hosts Kiro needs, from kiro.dev "Firewalls, proxies and data perimeters"
 * (docs/spikes/kiro-acp.md, finding 4). Device-flow login hosts are not included:
 * agent sandboxes reuse an existing session and never log in.
 */
export const KIRO_EGRESS_HOSTS: readonly string[] = [
  'runtime.us-east-1.kiro.dev',
  'q.us-east-1.amazonaws.com',
  'prod.us-east-1.auth.desktop.kiro.dev',
  'management.us-east-1.kiro.dev',
  'telemetry.us-east-1.kiro.dev',
  'app.kiro.dev',
];

export const PROXY_PORT = 8888;
/** Token in the generated config that the proxy entrypoint replaces with its internal IP. */
export const LISTEN_PLACEHOLDER = '@LISTEN_IP@';
/** Network alias of the proxy container on the sandbox's internal network. */
export const PROXY_ALIAS = 'egress-proxy';
export const PROXY_URL = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
const PROXY_UID = '10002:10002';

/** Validates every host (lowercase FQDN, no wildcards) and removes duplicates. */
export function normalizeAllowlist(hosts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const host of hosts) {
    const parsed = EgressHost.safeParse(host);
    if (!parsed.success)
      throw new SandboxError('invalid_spec', `egress host is not a plain hostname: ${host}`);
    out.add(parsed.data);
  }
  return [...out].sort();
}

/** tinyproxy filter file: one anchored, escaped regex per allowed host. */
export function buildProxyFilter(hosts: readonly string[]): string {
  return (
    normalizeAllowlist(hosts)
      .map((h) => `^${h.replace(/[.]/g, '\\.')}$`)
      .join('\n') + '\n'
  );
}

/**
 * tinyproxy config: deny by default (only filtered hosts pass), CONNECT to 443
 * only, no upstream proxy, no stats page, no access from outside the internal network.
 */
export function buildProxyConfig(): string {
  return [
    `Port ${PROXY_PORT}`,
    // The image entrypoint replaces the token with the proxy's address on the internal network
    // (its alias), so the proxy never listens on the default bridge.
    `Listen ${LISTEN_PLACEHOLDER}`,
    'Timeout 60',
    'MaxClients 20',
    'LogLevel Warning',
    'PidFile "/tmp/tinyproxy.pid"',
    'Filter "/tmp/tinyproxy.filter"',
    'FilterType bre',
    'FilterExtended On',
    'FilterURLs Off',
    'FilterDefaultDeny Yes',
    'ConnectPort 443',
    'DisableViaHeader Yes',
    '',
  ].join('\n');
}

const NAME = /^[a-z0-9][a-z0-9_.-]{2,62}$/;

function checkName(name: string): void {
  if (!NAME.test(name)) throw new SandboxError('invalid_name', `invalid docker name: ${name}`);
}

/** `docker network create` for the per-sandbox internal network (no route out). */
export function buildNetworkCreateArgs(network: string): string[] {
  checkName(network);
  return ['network', 'create', '--internal', '--driver', 'bridge', network];
}

export interface ProxyRunInput {
  name: string;
  network: string;
  /** Proxy image pinned by digest. */
  image: string;
  allowlist: readonly string[];
}

const IMAGE = /^[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;

/**
 * `docker run` for the proxy. It starts on the internal network only; the runner then
 * attaches it to the default bridge (`docker network connect bridge <name>`) so it is the
 * only container with a route out. Hardened like the agent container.
 */
export function buildProxyRunArgs(input: ProxyRunInput): string[] {
  checkName(input.name);
  checkName(input.network);
  if (!IMAGE.test(input.image))
    throw new SandboxError('invalid_spec', 'proxy image must be pinned by sha256 digest');
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
  return [
    'run',
    '-d',
    '--name',
    input.name,
    '--network',
    input.network,
    '--network-alias',
    PROXY_ALIAS,
    '--user',
    PROXY_UID,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=8m',
    '--pids-limit',
    '64',
    '--memory',
    '128m',
    '--cpus',
    '0.5',
    '-e',
    `TINYPROXY_CONF_B64=${b64(buildProxyConfig())}`,
    '-e',
    `TINYPROXY_FILTER_B64=${b64(buildProxyFilter(input.allowlist))}`,
    input.image,
  ];
}

export const PROXY_ENV_NAMES = ['TINYPROXY_CONF_B64', 'TINYPROXY_FILTER_B64'] as const;

/** True when `host` would pass the filter built from `allowlist` (used by tests). */
export function isHostAllowed(allowlist: readonly string[], host: string): boolean {
  return buildProxyFilter(allowlist)
    .split('\n')
    .filter(Boolean)
    .some((re) => new RegExp(re).test(host));
}
