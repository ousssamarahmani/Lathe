import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@lathe/shared-contracts';
import { DockerSandboxRunner, nodeCommandRunner, type CommandRunner } from './docker-sandbox.js';
import { KIRO_EGRESS_HOSTS } from './egress-proxy.js';

/** Real git, real filesystem. Docker is faked: only `collectPatch` is under test. */
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

const gitTest = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
const fwd = (p: string): string => p.replace(/\\/g, '/');

let root: string;
let appDir: string;
let gitDir: string;
let base: string;
let marker: string;
let filterScript: string;
const saved = process.env.GIT_CONFIG_GLOBAL;

function definedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

/** A runner whose env also carries the host environment, as a careless runner would. */
const leakyRunner: CommandRunner = {
  run: (c, a, o) =>
    nodeCommandRunner.run(c, a, {
      ...o,
      env: { ...definedEnv(), ...(o?.env ?? {}) },
    }),
};

function sandbox() {
  return new DockerSandboxRunner({
    runner: {
      run: (c, a, o) =>
        c === 'git'
          ? leakyRunner.run(c, a, o)
          : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    },
    proxyImage: `lathe/egress-proxy@sha256:${'b'.repeat(64)}`,
    dockerEnv: { PATH: '/usr/bin' },
    newId: () => 'abc123',
    resolveHostMounts: () => Promise.resolve({ 'target-app': appDir, 'kiro-session': 'vol' }),
    resolveGitDir: () => Promise.resolve(gitDir),
  }).create(spec, {
    targetApp: 'support-desk',
    baseCommit: base,
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'lathe-f34-'));
  appDir = path.join(root, 'app');
  gitDir = path.join(root, 'trusted.git');
  marker = path.join(root, 'PWNED');
  filterScript = path.join(root, 'filter.cjs');
  await mkdir(appDir);
  await writeFile(
    filterScript,
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdin.pipe(process.stdout);`,
  );
  await writeFile(path.join(appDir, 'a.txt'), 'one\n');
  gitTest(root, ['init', '--bare', '-q', gitDir]);
  const wt = [`--git-dir=${gitDir}`, `--work-tree=${appDir}`];
  gitTest(root, [...wt, 'add', '-A']);
  gitTest(root, [
    ...wt,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '-m',
    'base',
  ]);
  base = gitTest(root, [...wt, 'rev-parse', 'HEAD']).trim();
  await writeFile(path.join(appDir, 'a.txt'), 'two\n');
});

afterEach(async () => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
  await rm(root, { recursive: true, force: true });
});

const filterConfig = (): string =>
  `[filter "x"]\n\tclean = node ${fwd(filterScript)}\n\tsmudge = cat\n`;

describe('collectPatch with an untrusted work tree', () => {
  it('returns a patch for a clean tree using the trusted git dir', async () => {
    const patch = await (await sandbox()).collectPatch();
    expect(patch.files).toEqual(['a.txt']);
    expect(patch.diff).toContain('+two');
  });

  it('rejects a planted .git with a clean filter and never runs the filter', async () => {
    await mkdir(path.join(appDir, '.git'));
    await writeFile(
      path.join(appDir, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n${filterConfig()}`,
    );
    await writeFile(path.join(appDir, '.gitattributes'), '* filter=x\n');
    await expect((await sandbox()).collectPatch()).rejects.toMatchObject({
      code: 'unsafe_git_metadata',
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects a nested .git file (gitlink style)', async () => {
    await mkdir(path.join(appDir, 'sub'));
    await writeFile(path.join(appDir, 'sub', '.git'), 'gitdir: ../../elsewhere\n');
    await expect((await sandbox()).collectPatch()).rejects.toMatchObject({
      code: 'unsafe_git_metadata',
    });
  });

  it('rejects .gitattributes alone', async () => {
    await writeFile(path.join(appDir, '.gitattributes'), '* text=auto\n');
    await expect((await sandbox()).collectPatch()).rejects.toMatchObject({
      code: 'unsafe_git_metadata',
    });
  });

  it('rejects .gitmodules and the NTFS alias GIT~1', async () => {
    await writeFile(path.join(appDir, '.gitmodules'), '');
    await expect((await sandbox()).collectPatch()).rejects.toMatchObject({
      code: 'unsafe_git_metadata',
    });
    await rm(path.join(appDir, '.gitmodules'));
    await mkdir(path.join(appDir, 'GIT~1'));
    await expect((await sandbox()).collectPatch()).rejects.toMatchObject({
      code: 'unsafe_git_metadata',
    });
  });

  it('does not run a filter from the host global config', async () => {
    const attrs = path.join(root, 'global-attributes');
    const globalCfg = path.join(root, 'global.gitconfig');
    await writeFile(attrs, '* filter=x\n');
    await writeFile(globalCfg, `[core]\n\tattributesFile = ${fwd(attrs)}\n${filterConfig()}`);
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    const patch = await (await sandbox()).collectPatch();
    expect(patch.files).toEqual(['a.txt']);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a trusted git dir inside the agent tree', async () => {
    const inside = path.join(appDir, 'gd');
    const s = new DockerSandboxRunner({
      runner: { run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }) },
      proxyImage: `lathe/egress-proxy@sha256:${'b'.repeat(64)}`,
      dockerEnv: {},
      newId: () => 'abc123',
      resolveHostMounts: () => Promise.resolve({ 'target-app': appDir, 'kiro-session': 'vol' }),
      resolveGitDir: () => Promise.resolve(inside),
    });
    const h = await s.create(spec, { targetApp: 'support-desk', baseCommit: base });
    await expect(h.collectPatch()).rejects.toMatchObject({ code: 'invalid_host_path' });
  });
});
