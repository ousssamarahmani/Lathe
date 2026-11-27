import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  Patch,
  SandboxSpec,
  type MountSource,
  type SandboxCreateInput,
  type SandboxHandle,
  type SandboxRunner,
  type SecretEnvName,
} from '@lathe/shared-contracts';
import { hostSpawn, type SpawnFn } from '../process.js';
import { buildSandboxRunArgs } from './docker-args.js';
import { KIRO_EGRESS_HOSTS, buildNetworkCreateArgs, buildProxyRunArgs } from './egress-proxy.js';
import type { CommandResult, CommandRunner } from './command.js';
import { SandboxError } from './errors.js';
import { assertNoGitMetadata, createSafeGitContext, runSafeGit } from './git-safe.js';

export type { CommandResult, CommandRunner } from './command.js';

export const nodeCommandRunner: CommandRunner = {
  run: (command, args, options) =>
    new Promise((resolve) => {
      execFile(
        command,
        [...args],
        {
          env: { ...(options?.env ?? {}) },
          cwd: options?.cwd,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
          resolve({ code, stdout, stderr: error && code === null ? error.message : stderr });
        },
      );
    }),
};

export interface DockerSandboxOptions {
  runner: CommandRunner;
  /** Proxy image pinned by digest (see sandbox-image/egress-proxy.Dockerfile). */
  proxyImage: string;
  /** Environment for the `docker` client only (PATH, DOCKER_HOST, ...). Never passed into containers. */
  dockerEnv: Readonly<Record<string, string>>;
  /** Credential values, handed to the docker client so `-e NAME` can forward them by name. */
  secrets?: Readonly<Partial<Record<SecretEnvName, string>>> | undefined;
  /** Host side of each mount for this sandbox (worktree directory, session volume name). */
  resolveHostMounts(
    spec: SandboxSpec,
    input: SandboxCreateInput,
  ): Promise<Readonly<Partial<Record<MountSource, string>>>>;
  /**
   * Trusted git directory holding aseCommit, outside every agent-writable mount. Its root tree
   * must correspond to the target-app host directory. Git never discovers a repository from
   * the agent's tree; see git-safe.ts.
   */
  resolveGitDir(input: SandboxCreateInput): Promise<string>;
  /** Repository root on the host. A bind-mount source may not be it or contain it. */
  repoRoot?: string | undefined;
  /** Unique, lowercase `[a-z0-9]` suffix for container and network names. */
  newId: () => string;
}

export const SANDBOX_NAME_PREFIX = 'lathe-sbx-';
const ID = /^[a-z0-9]{6,32}$/;

/** Host environment variables the docker client needs, copied by name. Nothing else. */
export function pickDockerEnv(
  host: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const names = [
    'PATH',
    'Path',
    'SystemRoot',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'HOME',
    'USERPROFILE',
  ];
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = host[n];
    if (v !== undefined) out[n] = v;
  }
  return out;
}

const PROTECTED_CHILDREN = [['packages', 'verification-harness'], ['.github']];

/** Refuses bind sources that are a filesystem root, the repo root, or expose protected paths. */
export function assertSafeBindSource(dir: string, repoRoot?: string): void {
  const resolved = path.resolve(dir);
  const isRoot = path.parse(resolved).root === resolved;
  const same = (a: string, b: string): boolean =>
    path.relative(a, b) === '' || path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (isRoot || (repoRoot !== undefined && same(resolved, repoRoot)))
    throw new SandboxError('invalid_host_path', 'a bind source may not be a root or the repo root');
  for (const parts of PROTECTED_CHILDREN)
    if (existsSync(path.join(resolved, ...parts)))
      throw new SandboxError(
        'invalid_host_path',
        `a bind source may not contain ${parts.join('/')}`,
      );
}
function isMissing(result: CommandResult): boolean {
  return /no such (container|network|object)/i.test(result.stderr);
}

class DockerSandbox implements SandboxHandle {
  private destroyed: Promise<void> | undefined;
  constructor(
    readonly id: string,
    readonly spec: SandboxSpec,
    private readonly input: SandboxCreateInput,
    private readonly appDir: string,
    private readonly gitDir: string,
    private readonly extra: { proxy?: string | undefined; network?: string | undefined },
    private readonly docker: (args: readonly string[]) => Promise<CommandResult>,
    private readonly runner: CommandRunner,
  ) {}

  async collectPatch(): Promise<Patch> {
    // Fail closed before any git process starts: the agent tree may not carry git config.
    await assertNoGitMetadata(this.appDir);
    const ctx = await createSafeGitContext(this.gitDir, this.appDir);
    try {
      const git = (args: string[]): Promise<string> => runSafeGit(this.runner, ctx, args);
      const base = this.input.baseCommit;
      await git(['add', '-A']);
      const diff = await git([
        'diff',
        '--cached',
        '--binary',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        base,
      ]);
      const names = await git(['diff', '--cached', '--name-only', '-z', '--no-renames', base]);
      const files = names.split('\0').filter((f) => f.length > 0);
      const parsed = Patch.safeParse({
        baseCommit: base,
        diff,
        files,
        sha256: createHash('sha256').update(diff, 'utf8').digest('hex'),
      });
      if (!parsed.success)
        throw new SandboxError('patch_failed', `patch rejected: ${parsed.error.message}`, {
          cause: parsed.error,
        });
      return parsed.data;
    } finally {
      await ctx.dispose();
    }
  }
  destroy(): Promise<void> {
    this.destroyed ??= this.doDestroy();
    return this.destroyed;
  }

  private async doDestroy(): Promise<void> {
    const failures: string[] = [];
    const step = async (args: string[]): Promise<void> => {
      const r = await this.docker(args);
      if (r.code !== 0 && !isMissing(r))
        failures.push(`${args.slice(0, 2).join(' ')}: ${r.stderr.trim()}`);
    };
    // Order: agent container, proxy, network. `-v` removes anonymous volumes.
    await step(['rm', '-f', '-v', this.id]);
    if (this.extra.proxy) await step(['rm', '-f', '-v', this.extra.proxy]);
    if (this.extra.network) await step(['network', 'rm', this.extra.network]);
    if (failures.length > 0)
      throw new SandboxError('docker_failed', `sandbox cleanup incomplete: ${failures.join('; ')}`);
  }
}

/** Docker implementation of the C2 `SandboxRunner`. */
export class DockerSandboxRunner implements SandboxRunner {
  constructor(private readonly options: DockerSandboxOptions) {}

  async create(specInput: SandboxSpec, input: SandboxCreateInput): Promise<SandboxHandle> {
    const parsed = SandboxSpec.safeParse(specInput);
    if (!parsed.success)
      throw new SandboxError('invalid_spec', `invalid sandbox spec: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    const spec = parsed.data;
    const id = this.options.newId();
    if (!ID.test(id)) throw new SandboxError('invalid_name', 'newId must return [a-z0-9]{6,32}');
    const name = `${SANDBOX_NAME_PREFIX}${id}`;
    const hostMounts = await this.options.resolveHostMounts(spec, input);
    const appDir = hostMounts['target-app'];
    if (appDir === undefined)
      throw new SandboxError('missing_host_mount', 'no host path for the target app');

    for (const m of spec.mounts)
      if (m.source !== 'kiro-session' && hostMounts[m.source] !== undefined)
        assertSafeBindSource(hostMounts[m.source] as string, this.options.repoRoot);
    const gitDir = await this.options.resolveGitDir(input);
    const needsProxy = spec.purpose === 'agent' && spec.egressAllowlist.length > 0;
    if (needsProxy) {
      // KIRO_EGRESS_HOSTS includes the telemetry host (telemetry.us-east-1.kiro.dev); it stays
      // allowed because Kiro expects it, and is called out in the P4-02 report.
      const extra = spec.egressAllowlist.filter((h) => !KIRO_EGRESS_HOSTS.includes(h));
      if (extra.length > 0)
        throw new SandboxError(
          'invalid_spec',
          `egress hosts outside the Kiro list: ${extra.join(', ')}`,
        );
    }
    const network = needsProxy ? `lathe-net-${id}` : undefined;
    const proxy = needsProxy ? `lathe-proxy-${id}` : undefined;

    const secretEnv: Record<string, string> = {};
    for (const n of spec.secretEnv) {
      const v = this.options.secrets?.[n];
      if (v === undefined)
        throw new SandboxError('invalid_spec', `credential ${n} is required but not provided`);
      secretEnv[n] = v;
    }

    // Build every argument list before the first docker call, so a bad spec starts nothing.
    const runArgs = buildSandboxRunArgs(spec, { name, network, hostMounts });
    const netArgs = network ? buildNetworkCreateArgs(network) : undefined;
    const proxyArgs =
      network && proxy
        ? buildProxyRunArgs({
            name: proxy,
            network,
            image: this.options.proxyImage,
            allowlist: spec.egressAllowlist,
          })
        : undefined;

    const docker = (args: readonly string[], withSecrets = false): Promise<CommandResult> =>
      this.options.runner.run('docker', args, {
        env: withSecrets ? { ...this.options.dockerEnv, ...secretEnv } : this.options.dockerEnv,
      });

    const sandbox = new DockerSandbox(
      name,
      spec,
      input,
      appDir,
      gitDir,
      { proxy, network },
      (a) => docker(a),
      this.options.runner,
    );
    try {
      const steps: Array<[string[], boolean]> = [];
      if (netArgs && proxyArgs && proxy) {
        steps.push(
          [netArgs, false],
          [proxyArgs, false],
          [['network', 'connect', 'bridge', proxy], false],
        );
      }
      steps.push([runArgs, true]);
      for (const [args, secret] of steps) {
        const r = await docker(args, secret);
        if (r.code !== 0)
          throw new SandboxError(
            'docker_failed',
            `docker ${args[0] ?? ''} failed: ${r.stderr.trim()}`,
          );
      }
    } catch (err) {
      await sandbox.destroy().catch(() => undefined); // best effort; the original error wins
      throw err;
    }
    return sandbox;
  }
}

/**
 * Sandboxed `SpawnFn` for the ACP adapter: runs the command inside the sandbox with
 * `docker exec -i`. The container already holds its environment, so the adapter's
 * `env` is not forwarded into it, and the docker client gets only `dockerEnv`.
 */
export function createDockerSpawn(
  dockerEnv: Readonly<Record<string, string>>,
  inner: SpawnFn = hostSpawn,
): SpawnFn {
  return ({ command, args, sandbox, request }) => {
    if (!sandbox.id.startsWith(SANDBOX_NAME_PREFIX) || !/^[a-z0-9-]+$/.test(sandbox.id))
      throw new SandboxError('invalid_name', 'sandbox id is not a Lathe container name');
    return inner({
      command: 'docker',
      args: ['exec', '-i', '--workdir', request.cwd, sandbox.id, command, ...args],
      env: dockerEnv,
      sandbox,
      request,
    });
  };
}
