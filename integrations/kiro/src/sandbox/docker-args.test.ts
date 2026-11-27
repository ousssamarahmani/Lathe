import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SandboxSpec, type MountSource } from '@lathe/shared-contracts';
import { ALLOWED_ENV_NAMES, buildSandboxRunArgs, type SandboxRunContext } from './docker-args.js';
import { KIRO_EGRESS_HOSTS } from './egress-proxy.js';
import { SandboxError } from './errors.js';

const IMAGE = `lathe/sandbox@sha256:${'a'.repeat(64)}`;
const hardening = {
  user: 'non-root',
  capDrop: 'ALL',
  noNewPrivileges: true,
  readOnlyRootFs: true,
  privileged: false,
  dockerSocket: false,
} as const;

const agentSpec = {
  purpose: 'agent',
  image: IMAGE,
  mounts: [
    { source: 'target-app', containerPath: '/workspace/app', mode: 'rw' },
    { source: 'application-foundation', containerPath: '/workspace/foundation', mode: 'ro' },
    { source: 'kiro-session', containerPath: '/home/agent/.kiro', mode: 'rw' },
  ],
  secretEnv: [],
  egressAllowlist: [...KIRO_EGRESS_HOSTS],
  limits: { cpus: 2, memoryMb: 2048, pids: 256 },
  hardening,
};

const ctx: SandboxRunContext = {
  name: 'lathe-sbx-abc123',
  network: 'lathe-net-abc123',
  hostMounts: {
    'target-app': '/srv/wt/app',
    'application-foundation': '/srv/wt/foundation',
    'kiro-session': 'lathe-kiro-session',
    'kiro-runtime-config': '/srv/cfg',
  },
};

function pairs(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ''] : []));
}

describe('buildSandboxRunArgs', () => {
  it('contains every hardening flag for an agent', () => {
    const a = buildSandboxRunArgs(agentSpec, ctx);
    expect(pairs(a, '--user')).toEqual(['10001:10001']);
    expect(pairs(a, '--cap-drop')).toEqual(['ALL']);
    expect(pairs(a, '--security-opt')).toEqual(['no-new-privileges']);
    expect(a).toContain('--read-only');
    expect(pairs(a, '--tmpfs')).toContain('/tmp:rw,noexec,nosuid,size=64m');
    expect(pairs(a, '--cpus')).toEqual(['2']);
    expect(pairs(a, '--memory')).toEqual(['2048m']);
    expect(pairs(a, '--pids-limit')).toEqual(['256']);
    expect(pairs(a, '--network')).toEqual(['lathe-net-abc123']);
    expect(a.slice(-4)).toEqual(['--entrypoint', 'sleep', IMAGE, 'infinity']);
  });

  it('mounts per spec, session as a volume, read-only where specified', () => {
    const mounts = pairs(buildSandboxRunArgs(agentSpec, ctx), '--mount');
    expect(mounts).toEqual([
      'type=bind,source=/srv/wt/app,target=/workspace/app',
      'type=bind,source=/srv/wt/foundation,target=/workspace/foundation,readonly',
      'type=volume,source=lathe-kiro-session,target=/home/agent/.kiro',
    ]);
  });

  it('passes the credential by name only and points the proxy env at the proxy', () => {
    const a = buildSandboxRunArgs({ ...agentSpec, secretEnv: ['KIRO_API_KEY'] }, ctx);
    const env = pairs(a, '-e');
    expect(env).toContain('KIRO_API_KEY');
    expect(env.filter((e) => e.startsWith('HTTPS_PROXY='))).toEqual([
      'HTTPS_PROXY=http://egress-proxy:8888',
    ]);
  });

  it('gives a verifier no network, no session, no credential', () => {
    const verifier = {
      ...agentSpec,
      purpose: 'verifier',
      mounts: [{ source: 'target-app', containerPath: '/workspace/app', mode: 'rw' }],
      egressAllowlist: [],
    };
    const a = buildSandboxRunArgs(verifier, { ...ctx, network: undefined });
    expect(pairs(a, '--network')).toEqual(['none']);
    expect(a.join(' ')).not.toContain('kiro');
    expect(pairs(a, '-e').some((e) => e.includes('PROXY') || e === 'KIRO_API_KEY')).toBe(false);
  });

  it('uses network none for an agent with an empty allow-list', () => {
    const a = buildSandboxRunArgs(
      { ...agentSpec, egressAllowlist: [] },
      { ...ctx, network: undefined },
    );
    expect(pairs(a, '--network')).toEqual(['none']);
  });

  it.each([
    ['verifier with kiro-session', { ...agentSpec, purpose: 'verifier', egressAllowlist: [] }],
    [
      'verifier with a secret',
      {
        ...agentSpec,
        purpose: 'verifier',
        mounts: [agentSpec.mounts[0]],
        egressAllowlist: [],
        secretEnv: ['KIRO_API_KEY'],
      },
    ],
    ['privileged', { ...agentSpec, hardening: { ...hardening, privileged: true } }],
    ['docker socket', { ...agentSpec, hardening: { ...hardening, dockerSocket: true } }],
    [
      'session outside the fixed path',
      {
        ...agentSpec,
        mounts: [
          agentSpec.mounts[0],
          { source: 'kiro-session', containerPath: '/workspace/app/.kiro', mode: 'rw' },
        ],
      },
    ],
    [
      'unknown mount source',
      {
        ...agentSpec,
        mounts: [
          agentSpec.mounts[0],
          { source: 'host-root', containerPath: '/workspace/x', mode: 'rw' },
        ],
      },
    ],
    ['unpinned image', { ...agentSpec, image: 'lathe/sandbox:latest' }],
    ['unknown extra field (env)', { ...agentSpec, env: { GITHUB_TOKEN: 'x' } }],
    ['other secret', { ...agentSpec, secretEnv: ['GITHUB_TOKEN'] }],
  ])('rejects %s with a typed error', (_name, spec) => {
    try {
      buildSandboxRunArgs(spec, ctx);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxError);
      expect((e as SandboxError).code).toBe('invalid_spec');
    }
  });

  it.each([
    ['comma injection', '/srv/a,source=/'],
    ['docker socket', '/var/run/docker.sock'],
    ['parent segment', '/srv/../etc'],
    ['relative', 'srv/app'],
    ['quote', '/srv/"x'],
  ])('rejects an unsafe host path: %s', (_n, path) => {
    expect(() =>
      buildSandboxRunArgs(agentSpec, {
        ...ctx,
        hostMounts: { ...ctx.hostMounts, 'target-app': path },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_host_path' }));
  });

  it('rejects a missing host mount and a bad name', () => {
    expect(() => buildSandboxRunArgs(agentSpec, { ...ctx, hostMounts: {} })).toThrow(
      expect.objectContaining({ code: 'missing_host_mount' }),
    );
    expect(() => buildSandboxRunArgs(agentSpec, { ...ctx, name: 'x; rm -rf /' })).toThrow(
      expect.objectContaining({ code: 'invalid_name' }),
    );
  });

  describe('property: any accepted spec', () => {
    const mountArb = (source: MountSource, path: string, mode: 'ro' | 'rw') =>
      ({ source, containerPath: path, mode }) as const;
    const specArb = fc
      .record({
        purpose: fc.constantFrom('agent', 'verifier'),
        withFoundation: fc.boolean(),
        withSession: fc.boolean(),
        withConfig: fc.boolean(),
        secret: fc.boolean(),
        hosts: fc.subarray([...KIRO_EGRESS_HOSTS, 'example.com', 'registry.npmjs.org']),
        cpus: fc.double({ min: 0.25, max: 8, noNaN: true }),
        memoryMb: fc.integer({ min: 256, max: 16_384 }),
        pids: fc.integer({ min: 64, max: 4096 }),
        digest: fc.stringMatching(/^[a-f0-9]{64}$/),
        appMode: fc.constantFrom('ro', 'rw'),
      })
      .map((r) => ({
        purpose: r.purpose,
        image: `lathe/sandbox@sha256:${r.digest}`,
        mounts: [
          mountArb('target-app', '/workspace/app', r.appMode),
          ...(r.withFoundation
            ? [mountArb('application-foundation', '/workspace/foundation', 'ro')]
            : []),
          ...(r.withConfig ? [mountArb('kiro-runtime-config', '/workspace/cfg', 'ro')] : []),
          ...(r.withSession ? [mountArb('kiro-session', '/home/agent/.kiro', 'rw')] : []),
        ],
        secretEnv: r.secret ? ['KIRO_API_KEY'] : [],
        egressAllowlist: r.hosts,
        limits: { cpus: r.cpus, memoryMb: r.memoryMb, pids: r.pids },
        hardening,
      }));

    it('never has privileged, docker.sock, extra env, or a verifier with a session', () => {
      let accepted = 0;
      fc.assert(
        fc.property(specArb, (spec) => {
          if (!SandboxSpec.safeParse(spec).success) {
            expect(() => buildSandboxRunArgs(spec, ctx)).toThrow(SandboxError);
            return;
          }
          accepted++;
          const a = buildSandboxRunArgs(spec, ctx);
          const joined = a.join('\n');
          expect(a).not.toContain('--privileged');
          expect(a).not.toContain('--env-file');
          expect(a).not.toContain('-v');
          expect(a).not.toContain('--volume');
          expect(a).not.toContain('--network=host');
          expect(pairs(a, '--network')[0]).not.toBe('host');
          expect(joined).not.toMatch(/docker\.sock|--device|--pid(?!s-limit)|--ipc|--cap-add/);
          for (const e of pairs(a, '-e')) expect(ALLOWED_ENV_NAMES).toContain(e.split('=')[0]);
          expect(a).toContain('--read-only');
          expect(pairs(a, '--cap-drop')).toEqual(['ALL']);
          expect(pairs(a, '--user')).toEqual(['10001:10001']);
          const sessionMounts = pairs(a, '--mount').filter((m) => m.includes('/home/agent/.kiro'));
          if (spec.purpose === 'verifier') {
            expect(sessionMounts).toEqual([]);
            expect(pairs(a, '-e')).not.toContain('KIRO_API_KEY');
            expect(pairs(a, '--network')).toEqual(['none']);
          }
          // every mount target comes from the spec, in order
          expect(pairs(a, '--mount').map((m) => /target=([^,]+)/.exec(m)?.[1])).toEqual(
            spec.mounts.map((m) => m.containerPath),
          );
        }),
        { numRuns: 300 },
      );
      expect(accepted).toBeGreaterThan(0);
    });
  });
});
