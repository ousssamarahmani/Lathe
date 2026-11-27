import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@lathe/shared-contracts';
import type { SpawnContext } from '../process.js';
import {
  DockerSandboxRunner,
  assertSafeBindSource,
  createDockerSpawn,
  pickDockerEnv,
  type CommandResult,
  type CommandRunner,
} from './docker-sandbox.js';
import { KIRO_EGRESS_HOSTS } from './egress-proxy.js';

const spec: SandboxSpec = {
  purpose: 'agent',
  image: `lathe/sandbox@sha256:${'a'.repeat(64)}`,
  mounts: [
    { source: 'target-app', containerPath: '/workspace/app', mode: 'rw' },
    { source: 'kiro-session', containerPath: '/home/agent/.kiro', mode: 'rw' },
  ],
  secretEnv: [],
  egressAllowlist: [...KIRO_EGRESS_HOSTS],
  limits: { cpus: 1, memoryMb: 1024, pids: 128 },
  hardening: {
    user: 'non-root',
    capDrop: 'ALL',
    noNewPrivileges: true,
    readOnlyRootFs: true,
    privileged: false,
    dockerSocket: false,
  },
};
const scratchRoot = mkdtempSync(path.join(tmpdir(), 'lathe-dsb-'));
const appDir = path.join(scratchRoot, 'app');
mkdirSync(appDir);
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));
const input = { targetApp: 'support-desk', baseCommit: 'c'.repeat(40) };
const ok: CommandResult = { code: 0, stdout: '', stderr: '' };

function fakeRunner(respond: (cmd: string, args: readonly string[]) => CommandResult = () => ok) {
  const calls: Array<{
    cmd: string;
    args: readonly string[];
    env?: Readonly<Record<string, string>> | undefined;
  }> = [];
  const runner: CommandRunner = {
    run: (cmd, args, options) => {
      calls.push({ cmd, args, env: options?.env });
      return Promise.resolve(respond(cmd, args));
    },
  };
  return { runner, calls };
}

function make(runner: CommandRunner, secrets?: { KIRO_API_KEY: string }) {
  return new DockerSandboxRunner({
    runner,
    proxyImage: `lathe/egress-proxy@sha256:${'b'.repeat(64)}`,
    dockerEnv: { PATH: '/usr/bin' },
    secrets,
    newId: () => 'abc123',
    resolveHostMounts: () =>
      Promise.resolve({ 'target-app': appDir, 'kiro-session': 'lathe-session' }),
    resolveGitDir: () => Promise.resolve(path.join(path.dirname(appDir), 'trusted.git')),
  });
}

describe('DockerSandboxRunner', () => {
  it('creates network, proxy, bridge link, then the container; destroy removes all', async () => {
    const { runner, calls } = fakeRunner();
    const sandbox = await make(runner).create(spec, input);
    expect(sandbox.id).toBe('lathe-sbx-abc123');
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'network create',
      'run -d',
      'network connect',
      'run -d',
    ]);
    await sandbox.destroy();
    await sandbox.destroy(); // idempotent
    const rm = calls.slice(4).map((c) => c.args.join(' '));
    expect(rm).toEqual([
      'rm -f -v lathe-sbx-abc123',
      'rm -f -v lathe-proxy-abc123',
      'network rm lathe-net-abc123',
    ]);
  });

  it('gives the credential to the docker client env of the run call only', async () => {
    const { runner, calls } = fakeRunner();
    await make(runner, { KIRO_API_KEY: 'sekret-value' }).create(
      { ...spec, secretEnv: ['KIRO_API_KEY'] },
      input,
    );
    expect(calls.some((c) => c.args.join(' ').includes('sekret-value'))).toBe(false);
    const withSecret = calls.filter((c) => c.env?.KIRO_API_KEY !== undefined);
    expect(withSecret).toHaveLength(1);
    expect(withSecret[0]?.args[0]).toBe('run');
    expect(withSecret[0]?.args).toContain('KIRO_API_KEY');
  });

  it('fails when a required credential is not provided, before starting anything', async () => {
    const { runner, calls } = fakeRunner();
    await expect(
      make(runner).create({ ...spec, secretEnv: ['KIRO_API_KEY'] }, input),
    ).rejects.toMatchObject({
      code: 'invalid_spec',
    });
    expect(calls).toHaveLength(0);
  });

  it('removes everything when the container fails to start', async () => {
    const { runner, calls } = fakeRunner((_c, args) =>
      args[0] === 'run' && args.includes('--entrypoint')
        ? { code: 125, stdout: '', stderr: 'boom' }
        : ok,
    );
    await expect(make(runner).create(spec, input)).rejects.toMatchObject({ code: 'docker_failed' });
    expect(calls.slice(-3).map((c) => c.args.join(' '))).toEqual([
      'rm -f -v lathe-sbx-abc123',
      'rm -f -v lathe-proxy-abc123',
      'network rm lathe-net-abc123',
    ]);
  });

  it('ignores "no such" errors on destroy but reports other failures', async () => {
    const missing = fakeRunner((_c, a) =>
      a[0] === 'rm' ? { code: 1, stdout: '', stderr: 'Error: No such container' } : ok,
    );
    const s1 = await make(missing.runner).create(spec, input);
    await expect(s1.destroy()).resolves.toBeUndefined();
    const broken = fakeRunner((_c, a) =>
      a[0] === 'rm' ? { code: 1, stdout: '', stderr: 'daemon error' } : ok,
    );
    const s2 = await make(broken.runner).create(spec, input);
    await expect(s2.destroy()).rejects.toMatchObject({ code: 'docker_failed' });
  });

  it('refuses egress hosts outside the Kiro list before starting anything', async () => {
    const { runner, calls } = fakeRunner();
    await expect(
      make(runner).create(
        { ...spec, egressAllowlist: [...KIRO_EGRESS_HOSTS, 'evil.example.com'] },
        input,
      ),
    ).rejects.toMatchObject({ code: 'invalid_spec' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a host dir that is the repo root or exposes protected paths', async () => {
    const root = path.join(scratchRoot, 'repo');
    mkdirSync(path.join(root, 'packages', 'verification-harness'), { recursive: true });
    expect(() => assertSafeBindSource(root)).toThrow(/verification-harness/);
    mkdirSync(path.join(scratchRoot, 'gh', '.github'), { recursive: true });
    expect(() => assertSafeBindSource(path.join(scratchRoot, 'gh'))).toThrow(/\.github/);
    expect(() => assertSafeBindSource(scratchRoot, scratchRoot)).toThrow(/repo root/);
    expect(() => assertSafeBindSource(path.parse(scratchRoot).root)).toThrow(/root/);
    expect(() => assertSafeBindSource(appDir, scratchRoot)).not.toThrow();
  });

  it('collectPatch stages the app dir and builds a hashed patch', async () => {
    const { runner, calls } = fakeRunner((cmd, args) => {
      if (cmd !== 'git') return ok;
      if (args.includes('--name-only'))
        return { code: 0, stdout: 'src/a.ts\0src/b.ts\0', stderr: '' };
      if (args.includes('--binary'))
        return { code: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts\n', stderr: '' };
      return ok;
    });
    const sandbox = await make(runner).create(spec, input);
    const patch = await sandbox.collectPatch();
    expect(patch.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(patch.sha256).toMatch(/^[a-f0-9]{64}$/);
    const git = calls.filter((c) => c.cmd === 'git');
    expect(git[0]?.args).toEqual(expect.arrayContaining(['core.fsmonitor=false', 'add', '-A']));
    expect(git.every((c) => c.args[0]?.startsWith('--git-dir=') === true)).toBe(true);
    expect(git.every((c) => c.args[1] === `--work-tree=${appDir}`)).toBe(true);
    expect(
      git.every((c) => c.env?.GIT_CONFIG_NOSYSTEM === '1' && c.env.GIT_ATTR_NOSYSTEM === '1'),
    ).toBe(true);
    expect(
      git.every((c) => c.env?.GITHUB_TOKEN === undefined && c.env?.KIRO_API_KEY === undefined),
    ).toBe(true);
  });
});

describe('createDockerSpawn', () => {
  it('runs the command through docker exec with only the docker client env', () => {
    let seen: SpawnContext | undefined;
    const spawn = createDockerSpawn({ PATH: '/usr/bin' }, (c) => {
      seen = c;
      throw new Error('stop');
    });
    const sandbox = { id: 'lathe-sbx-abc123' } as SpawnContext['sandbox'];
    const request = { cwd: '/workspace/app' } as SpawnContext['request'];
    expect(() =>
      spawn({ command: 'kiro-cli', args: ['acp'], env: { KIRO_API_KEY: 'x' }, sandbox, request }),
    ).toThrow('stop');
    expect(seen?.command).toBe('docker');
    expect(seen?.args).toEqual([
      'exec',
      '-i',
      '--workdir',
      '/workspace/app',
      'lathe-sbx-abc123',
      'kiro-cli',
      'acp',
    ]);
    expect(seen?.env).toEqual({ PATH: '/usr/bin' });
  });

  it('refuses a sandbox id that is not a Lathe container', () => {
    const spawn = createDockerSpawn({}, () => {
      throw new Error('should not spawn');
    });
    const sandbox = { id: 'other; rm' } as SpawnContext['sandbox'];
    expect(() =>
      spawn({
        command: 'kiro-cli',
        args: [],
        env: {},
        sandbox,
        request: {} as SpawnContext['request'],
      }),
    ).toThrow(/not a Lathe container/);
  });
});

describe('pickDockerEnv', () => {
  it('copies only docker-client variables', () => {
    expect(
      pickDockerEnv({ PATH: '/p', GITHUB_TOKEN: 't', DATABASE_URL: 'd', KIRO_API_KEY: 'k' }),
    ).toEqual({ PATH: '/p' });
  });
});
