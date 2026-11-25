import { mkdir, mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxError } from './errors.js';
import { nodeCommandRunner, pickDockerEnv, type CommandRunner } from './docker-sandbox.js';
import { Worktree, createGitRunner, removeDir, type GitRunner } from './worktree.js';

const BASE = 'a'.repeat(40);
const noCommands: CommandRunner = {
  run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
};

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const e: unknown = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(SandboxError);
  expect((e as SandboxError).code).toBe(code);
}

describe('Worktree with an injected git runner', () => {
  let tempRoot: string;
  let calls: string[][];
  let diffRaw: string;
  let diffText: string;
  let materialize: string[];

  const git: GitRunner = async (args, { cwd }) => {
    calls.push([...args]);
    switch (args[0]) {
      case 'checkout':
        for (const d of materialize) await mkdir(path.join(cwd, d), { recursive: true });
        return '';
      case 'diff':
        return args.includes('--raw') ? diffRaw : diffText;
      case 'write-tree':
        return `${'b'.repeat(40)}\n`;
      default:
        return '';
    }
  };
  const make = (): Promise<Worktree> =>
    Worktree.create(
      { repoDir: path.join(tempRoot, 'repo'), git, commands: noCommands, tempRoot },
      { targetApp: 'demo', baseCommit: BASE },
    );

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'lathe-wt-unit-'));
    calls = [];
    diffRaw = '';
    diffText = '';
    materialize = ['apps/demo', 'packages/application-foundation'];
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('creates a sparse worktree at the base commit and exposes only two mounts', async () => {
    const wt = await make();
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual([
      `cat-file -e`,
      'worktree add',
      'sparse-checkout set',
      `checkout --force`,
    ]);
    expect(calls[1]).toContain('--no-checkout');
    expect(calls[1]).toContain(BASE);
    expect(calls[2]).toContain('/apps/demo/');
    expect(calls[2]).toContain('/packages/application-foundation/');
    expect(wt.mounts()).toEqual([
      { source: 'target-app', containerPath: '/workspace/apps/demo', mode: 'rw' },
      {
        source: 'application-foundation',
        containerPath: '/workspace/packages/application-foundation',
        mode: 'ro',
      },
    ]);
    const host = wt.hostMounts();
    expect(Object.keys(host).sort()).toEqual(['application-foundation', 'target-app']);
    expect(host['target-app']).toBe(path.join(wt.dir, 'apps', 'demo'));
    expect(path.relative(path.join(tempRoot, 'repo'), wt.dir).startsWith('..')).toBe(true);
    await wt.destroy();
  });

  it.each(['packages/verification-harness', '.github'])('fails when %s is present', async (p) => {
    materialize.push(p);
    await expectCode(make(), 'protected_path_present');
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true);
  });

  it('fails when the target app does not exist at the base commit', async () => {
    materialize = ['packages/application-foundation'];
    await expectCode(make(), 'missing_host_mount');
  });

  it('rejects an invalid app slug and a temp root inside the repo', async () => {
    await expectCode(
      Worktree.create(
        { repoDir: tempRoot, git, commands: noCommands, tempRoot },
        { targetApp: '../x', baseCommit: BASE },
      ),
      'invalid_spec',
    );
    await expectCode(
      Worktree.create(
        { repoDir: tempRoot, git, commands: noCommands, tempRoot: path.join(tempRoot, 'sub') },
        { targetApp: 'demo', baseCommit: BASE },
      ),
      'invalid_host_path',
    );
    expect(calls).toEqual([]);
  });

  it('builds a patch with sorted files and a matching sha256', async () => {
    diffRaw =
      ':000000 100644 0000 1111 A\0apps/demo/b.ts\0:100644 100644 2222 3333 M\0apps/demo/a.ts\0';
    diffText = 'diff --git a/apps/demo/a.ts b/apps/demo/a.ts\n';
    const wt = await make();
    const { patch, treeHash } = await wt.collectPatch();
    expect(patch.files).toEqual(['apps/demo/a.ts', 'apps/demo/b.ts']);
    expect(patch.baseCommit).toBe(BASE);
    expect(patch.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(treeHash).toBe('b'.repeat(40));
    const diffCall = calls.find((c) => c[0] === 'diff' && c.includes('--binary'));
    expect(diffCall).toEqual(
      expect.arrayContaining(['--no-renames', '--full-index', '--no-color', BASE]),
    );
    await wt.destroy();
  });

  it.each([
    ['another app', 'apps/other/x.ts'],
    ['the foundation', 'packages/application-foundation/x.ts'],
    ['a protected path', 'packages/verification-harness/gate.ts'],
    ['a workflow', '.github/workflows/ci.yml'],
    ['a prefix lookalike', 'apps/demo-evil/x.ts'],
    ['a traversal', 'apps/demo/../../x.ts'],
  ])('rejects a change in %s', async (_n, file) => {
    diffRaw = `:000000 100644 0000 1111 A\0${file}\0`;
    const wt = await make();
    await expectCode(wt.collectPatch(), 'patch_outside_target');
    await wt.destroy();
  });

  it.each(['120000', '160000'])('rejects mode %s entries', async (mode) => {
    diffRaw = `:000000 ${mode} 0000 1111 A\0apps/demo/link\0`;
    const wt = await make();
    await expectCode(wt.collectPatch(), 'patch_unsafe_entry');
    await wt.destroy();
  });

  it('destroy is idempotent and removes the temp dir', async () => {
    const wt = await make();
    await wt.destroy();
    await wt.destroy();
    expect(calls.filter((c) => c[0] === 'worktree' && c[1] === 'remove')).toHaveLength(1);
    expect(existsSync(wt.dir)).toBe(false);
  });
});

describe('removeDir', () => {
  it('falls back to cmd rmdir on Windows when rm fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lathe-rm-'));
    const seen: Array<{ command: string; args: readonly string[] }> = [];
    const commands: CommandRunner = {
      run: async (command, args) => {
        seen.push({ command, args });
        await rm(dir, { recursive: true, force: true });
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const failing = (() => Promise.reject(new Error('ENAMETOOLONG'))) as unknown as typeof rm;
    await removeDir(dir, commands, 'win32', failing);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe('cmd');
    expect(seen[0]?.args.slice(0, 4)).toEqual(['/c', 'rmdir', '/s', '/q']);
    expect(existsSync(dir)).toBe(false);
  });

  it('does not use cmd on other platforms and reports a failure', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lathe-rm-'));
    const failing = (() => Promise.reject(new Error('EBUSY'))) as unknown as typeof rm;
    await expectCode(removeDir(dir, noCommands, 'linux', failing), 'worktree_failed');
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a directory that survives the fallback', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lathe-rm-'));
    const failing = (() => Promise.reject(new Error('x'))) as unknown as typeof rm;
    await expectCode(removeDir(dir, noCommands, 'win32', failing), 'worktree_failed');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('Worktree with real git (integration)', () => {
  let work: string;
  let repo: string;
  let wtRoot: string;
  let git: GitRunner;
  let sha: string;

  const make = (app = 'demo'): Promise<Worktree> =>
    Worktree.create(
      { repoDir: repo, git, commands: nodeCommandRunner, tempRoot: wtRoot },
      { targetApp: app, baseCommit: sha },
    );

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'lathe-wt-int-'));
    repo = path.join(work, 'repo');
    wtRoot = path.join(work, 'wts');
    await mkdir(wtRoot, { recursive: true });
    await mkdir(repo, { recursive: true });
    const env = {
      ...pickDockerEnv(process.env),
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_GLOBAL: path.join(work, 'none'),
      GIT_CONFIG_NOSYSTEM: '1',
    };
    git = createGitRunner(nodeCommandRunner, env);
    const files: Record<string, string> = {
      'apps/demo/src/a.ts': 'export const a = 1;\n',
      'apps/demo/src/crlf.txt': 'one\r\ntwo\r\n',
      'apps/other/x.ts': 'x\n',
      'packages/application-foundation/index.ts': 'export {};\n',
      'packages/verification-harness/gate.ts': 'gate\n',
      '.github/workflows/ci.yml': 'name: ci\n',
    };
    for (const [f, c] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo, f)), { recursive: true });
      await writeFile(path.join(repo, f), c);
    }
    await git(['init', '-q', '-b', 'main'], { cwd: repo });
    await git(['add', '-A'], { cwd: repo });
    await git(['commit', '-q', '-m', 'base'], { cwd: repo });
    sha = (await git(['rev-parse', 'HEAD'], { cwd: repo })).trim();
  }, 60_000);
  afterEach(async () => {
    await removeDir(work, nodeCommandRunner);
  }, 60_000);

  async function edit(wt: Worktree): Promise<void> {
    const app = path.join(wt.dir, 'apps', 'demo');
    await writeFile(path.join(app, 'src', 'a.ts'), 'export const a = 2;\n');
    await writeFile(path.join(app, 'src', 'new.ts'), 'export const n = 1;\n');
    await writeFile(path.join(app, 'src', 'bin.dat'), Buffer.from([0, 1, 2, 255, 254, 0, 7]));
    await writeFile(path.join(app, 'src', 'crlf.txt'), 'one\r\nthree\r\n');
  }

  it('shows only the app and foundation, never the harness or .github', async () => {
    const wt = await make();
    try {
      expect(existsSync(path.join(wt.dir, 'packages', 'verification-harness'))).toBe(false);
      expect(existsSync(path.join(wt.dir, '.github'))).toBe(false);
      expect(existsSync(path.join(wt.dir, 'apps', 'other'))).toBe(false);
      expect(
        await readFile(path.join(wt.hostMounts()['target-app'] ?? '', 'src', 'a.ts'), 'utf8'),
      ).toBe('export const a = 1;\n');
      expect(
        existsSync(path.join(wt.hostMounts()['application-foundation'] ?? '', 'index.ts')),
      ).toBe(true);
    } finally {
      await wt.destroy();
    }
  }, 60_000);

  it('produces a stable canonical patch that applies reproducibly to a clean tree', async () => {
    const wt = await make();
    try {
      await edit(wt);
      const first = await wt.collectPatch();
      const second = await wt.collectPatch();
      expect(second.patch.sha256).toBe(first.patch.sha256);
      expect(first.patch.files).toEqual([
        'apps/demo/src/a.ts',
        'apps/demo/src/bin.dat',
        'apps/demo/src/crlf.txt',
        'apps/demo/src/new.ts',
      ]);
      expect(first.patch.diff).toContain('GIT binary patch');
      expect(first.patch.diff).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
      const proof = await wt.verifyReproducible(first);
      expect(proof.matchesAgentTree).toBe(true);
      expect(proof.treeHash).toBe(first.treeHash);
    } finally {
      await wt.destroy();
    }
  }, 120_000);

  it('gives the same patch hash for the same edits in a different worktree', async () => {
    const a = await make();
    const b = await make();
    try {
      await edit(a);
      await edit(b);
      expect((await a.collectPatch()).patch.sha256).toBe((await b.collectPatch()).patch.sha256);
    } finally {
      await a.destroy();
      await b.destroy();
    }
  }, 120_000);

  it('rejects changes outside the target app and symlinks', async () => {
    const wt = await make();
    try {
      await writeFile(path.join(wt.dir, 'apps', 'demo', 'ok.ts'), 'ok\n');
      await mkdir(path.join(wt.dir, '.github'), { recursive: true });
      await writeFile(path.join(wt.dir, '.github', 'evil.yml'), 'x\n');
      await expectCode(wt.collectPatch(), 'patch_outside_target');
      await rm(path.join(wt.dir, '.github'), { recursive: true, force: true });
      await git(['reset', '-q'], { cwd: wt.dir });
      await writeFile(path.join(wt.dir, 'packages', 'application-foundation', 'index.ts'), 'bad\n');
      await expectCode(wt.collectPatch(), 'patch_outside_target');
      await git(['checkout', '-q', '--', 'packages/application-foundation/index.ts'], {
        cwd: wt.dir,
      });
      await git(['reset', '-q'], { cwd: wt.dir });
      await symlink('ok.ts', path.join(wt.dir, 'apps', 'demo', 'link.ts')).catch(() => undefined);
      if (existsSync(path.join(wt.dir, 'apps', 'demo', 'link.ts')))
        await expectCode(wt.collectPatch(), 'patch_unsafe_entry');
    } finally {
      await wt.destroy();
    }
  }, 120_000);

  it('removes the worktree and its registration on destroy', async () => {
    const wt = await make();
    const dir = wt.dir;
    expect(await git(['worktree', 'list', '--porcelain'], { cwd: repo })).toContain(
      dir.split(path.sep).join('/'),
    );
    await wt.destroy();
    await wt.destroy();
    expect(existsSync(dir)).toBe(false);
    expect(await git(['worktree', 'list', '--porcelain'], { cwd: repo })).not.toContain(
      path.basename(path.dirname(dir)),
    );
  }, 60_000);

  it('fails for a missing app and leaves nothing behind', async () => {
    await expectCode(make('nope'), 'missing_host_mount');
    expect(
      existsSync(wtRoot) ? await import('node:fs').then((m) => m.readdirSync(wtRoot)) : [],
    ).toEqual([]);
  }, 60_000);
});
