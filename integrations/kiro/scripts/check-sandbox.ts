/**
 * Live sandbox checks (task P4-02). Runs only when Docker is reachable; otherwise prints
 * "not run" and exits 0, so it never reports a pass it did not earn.
 *
 *   LATHE_SANDBOX_IMAGE=lathe/sandbox@sha256:<64 hex> \
 *   LATHE_PROXY_IMAGE=lathe/egress-proxy@sha256:<64 hex> pnpm --filter @lathe/kiro-integration check-sandbox
 *
 * Build both images from `sandbox-image/` first and pin them by digest. No Kiro login or
 * API key is used: the session volume is an empty temporary volume.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DockerSandboxRunner,
  KIRO_EGRESS_HOSTS,
  nodeCommandRunner,
  pickDockerEnv,
  type CommandResult,
} from '../src/index.js';

const dockerEnv = pickDockerEnv(process.env);
const docker = (args: string[]): Promise<CommandResult> =>
  nodeCommandRunner.run('docker', args, { env: dockerEnv });

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const results: Check[] = [];
const record = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main(): Promise<number> {
  const info = await docker(['version', '--format', '{{.Server.Version}}']);
  if (info.code !== 0) {
    console.log('NOT RUN: Docker is not available (docker version failed).');
    return 0;
  }
  const image = process.env['LATHE_SANDBOX_IMAGE'];
  const proxyImage = process.env['LATHE_PROXY_IMAGE'];
  if (!image || !proxyImage) {
    console.log('NOT RUN: set LATHE_SANDBOX_IMAGE and LATHE_PROXY_IMAGE (digest-pinned).');
    return 0;
  }

  // Canary secrets in the host env. None may reach the container.
  process.env['LATHE_CANARY_SECRET'] = 'canary-' + randomBytes(6).toString('hex');
  process.env['GITHUB_TOKEN'] = 'canary-github';
  process.env['ENGINE_DATABASE_URL'] = 'canary-db';

  const id = randomBytes(4).toString('hex');
  const appDir = mkdtempSync(join(tmpdir(), 'lathe-check-'));
  const volume = `lathe-check-session-${id}`;
  const runner = new DockerSandboxRunner({
    runner: nodeCommandRunner,
    proxyImage,
    dockerEnv,
    newId: () => id,
    resolveHostMounts: () => Promise.resolve({ 'target-app': appDir, 'kiro-session': volume }),
    // collectPatch is not exercised here, so a path outside the app dir is enough.
    resolveGitDir: () => Promise.resolve(join(tmpdir(), 'lathe-check-trusted.git')),
  });
  const handle = await runner.create(
    {
      purpose: 'agent',
      image,
      mounts: [
        { source: 'target-app', containerPath: '/workspace/app', mode: 'rw' },
        { source: 'kiro-session', containerPath: '/home/agent/.kiro', mode: 'rw' },
      ],
      secretEnv: [],
      egressAllowlist: [...KIRO_EGRESS_HOSTS],
      limits: { cpus: 1, memoryMb: 512, pids: 128 },
      hardening: {
        user: 'non-root',
        capDrop: 'ALL',
        noNewPrivileges: true,
        readOnlyRootFs: true,
        privileged: false,
        dockerSocket: false,
      },
    },
    { targetApp: 'check-app', baseCommit: '0'.repeat(40) },
  );

  try {
    const sh = (script: string): Promise<CommandResult> =>
      docker(['exec', handle.id, 'sh', '-c', script]);

    const env = await sh('env');
    const leaked = ['LATHE_CANARY_SECRET', 'canary-', 'GITHUB_TOKEN', 'ENGINE_DATABASE_URL'].filter(
      (n) => env.stdout.includes(n),
    );
    record('no host env inside', env.code === 0 && leaked.length === 0, leaked.join(','));

    const uid = await sh('id -u');
    record('not root', uid.stdout.trim() === '10001', `uid=${uid.stdout.trim()}`);

    const rootWrite = await sh('touch /usr/lathe-write-test');
    record('root filesystem is read-only', rootWrite.code !== 0);
    const tmpWrite = await sh('touch /tmp/ok && ! (cp /bin/true /tmp/x && /tmp/x)');
    record('/tmp writable and noexec', tmpWrite.code === 0, tmpWrite.stderr.trim());

    const sock = await sh('test ! -e /var/run/docker.sock && test ! -e /run/docker.sock');
    record('no docker socket', sock.code === 0);

    const harness = await sh(
      'test ! -e /workspace/packages/verification-harness && test ! -e /workspace/.github',
    );
    record('verification harness and .github invisible', harness.code === 0);

    const blocked = await sh('curl -sS -m 10 -o /dev/null -w "%{http_code}" https://example.com');
    record(
      'blocked host unreachable via proxy',
      blocked.code !== 0 || blocked.stdout.trim() === '000' || blocked.stdout.trim() === '403',
      `code=${blocked.code} http=${blocked.stdout.trim()}`,
    );

    const direct = await sh('curl -sS --noproxy "*" -m 6 -o /dev/null https://1.1.1.1');
    record('direct internet (no proxy) unreachable', direct.code !== 0);

    const allowed = await sh(
      `curl -sS -m 15 -o /dev/null -w "%{http_code}" https://${KIRO_EGRESS_HOSTS[5]}`,
    );
    record(
      'allowed host reachable via proxy',
      allowed.code === 0 &&
        /^[1-5]\d\d$/.test(allowed.stdout.trim()) &&
        allowed.stdout.trim() !== '403',
      `http=${allowed.stdout.trim()} ${allowed.stderr.trim()}`,
    );
  } finally {
    await handle.destroy();
    await docker(['volume', 'rm', '-f', volume]);
    rmSync(appDir, { recursive: true, force: true });
    const left = await docker(['ps', '-a', '--filter', `name=${id}`, '--format', '{{.Names}}']);
    record('container, proxy and network destroyed', left.stdout.trim() === '', left.stdout.trim());
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error('check-sandbox crashed:', err instanceof Error ? err.message : err);
    process.exitCode = 2;
  },
);
