import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Mount, Patch, SandboxCreateInput, type MountSource } from '@lathe/shared-contracts';
import type { CommandRunner } from './docker-sandbox.js';
import { SandboxError } from './errors.js';

/**
 * Worktree at a base commit, sandbox mounts built from it, and the canonical patch (task P4-03).
 *
 * The harness is NOT imported (dependency rules). The protected prefixes below mirror the
 * P2-02 gate; the Engine and CI re-check them independently on the patch.
 */
export const FOUNDATION_PATH = 'packages/application-foundation';
/** Never present in a sandbox worktree. Mirrors the protected-path gate (P2-02). */
export const PROTECTED_PREFIXES = ['packages/verification-harness', '.github'] as const;

/** Runs `git <args>` in `cwd` and returns stdout. Rejects with `SandboxError` on a non-zero exit. */
export type GitRunner = (args: readonly string[], options: { cwd: string }) => Promise<string>;

/** Config that makes git output independent of the user's and the repo's settings. */
const GIT_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'core.longpaths=true',
  '-c',
  'core.quotepath=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
];

/** Builds a `GitRunner` on a `CommandRunner`. `env` is passed to git as is (PATH etc.). */
export function createGitRunner(
  runner: CommandRunner,
  env: Readonly<Record<string, string>>,
): GitRunner {
  return async (args, { cwd }) => {
    const r = await runner.run('git', [...GIT_CONFIG, ...args], { env, cwd });
    if (r.code !== 0)
      throw new SandboxError(
        'worktree_failed',
        `git ${args[0] ?? ''} failed (exit ${String(r.code)}): ${r.stderr.trim()}`,
      );
    return r.stdout;
  };
}

export interface WorktreeOptions {
  /** The repository to create the worktree from. */
  repoDir: string;
  git: GitRunner;
  /** Used only for the Windows directory-removal fallback. */
  commands: CommandRunner;
  /** Parent of the temp dir. Defaults to the OS temp dir. Must be outside `repoDir`. */
  tempRoot?: string;
  platform?: NodeJS.Platform;
}

export interface PatchResult {
  patch: Patch;
  /** Git tree hash of the agent worktree after staging. Used by the reproducibility proof. */
  treeHash: string;
}

export interface ReproducibleResult {
  treeHash: string;
  /** The tree hash of the agent worktree the patch came from. */
  matchesAgentTree: boolean;
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Removes a directory tree. On Windows falls back to `cmd /c rmdir /s /q` (long paths). */
export async function removeDir(
  dir: string,
  commands: CommandRunner,
  platform: NodeJS.Platform = process.platform,
  rmImpl: typeof rm = rm,
): Promise<void> {
  try {
    await rmImpl(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (cause) {
    if (platform !== 'win32')
      throw new SandboxError('worktree_failed', `cannot remove ${dir}`, { cause });
  }
  if (!existsSync(dir)) return;
  if (platform !== 'win32')
    throw new SandboxError('worktree_failed', `cannot remove ${dir}: still present`);
  // `\\?\` lifts the MAX_PATH limit for rmdir.
  await commands.run('cmd', ['/c', 'rmdir', '/s', '/q', `\\\\?\\${path.resolve(dir)}`], {
    env: {},
  });
  if (existsSync(dir))
    throw new SandboxError('worktree_failed', `cannot remove ${dir}: still present after rmdir`);
}

/** Git worktree checked out at the base commit with only the paths a sandbox may see. */
export class Worktree {
  private destroyed: Promise<void> | undefined;

  private constructor(
    private readonly options: WorktreeOptions,
    private readonly input: SandboxCreateInput,
    private readonly tempDir: string,
    /** Root of the checked-out worktree. Outside the repository. */
    readonly dir: string,
  ) {}

  static async create(options: WorktreeOptions, inputRaw: SandboxCreateInput): Promise<Worktree> {
    const parsed = SandboxCreateInput.safeParse(inputRaw);
    if (!parsed.success)
      throw new SandboxError('invalid_spec', `invalid worktree input: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    const input = parsed.data;
    const root = options.tempRoot ?? tmpdir();
    if (inside(options.repoDir, root))
      throw new SandboxError(
        'invalid_host_path',
        'the worktree temp root must be outside the repo',
      );
    const tempDir = await mkdtemp(path.join(root, 'lathe-wt-'));
    const dir = path.join(tempDir, 'w');
    const wt = new Worktree(options, input, tempDir, dir);
    try {
      const { git, repoDir } = options;
      await git(['cat-file', '-e', `${input.baseCommit}^{commit}`], { cwd: repoDir });
      await git(['worktree', 'add', '--detach', '--no-checkout', dir, input.baseCommit], {
        cwd: repoDir,
      });
      // Only the two allowed trees are materialised, so the harness and `.github/` do not exist.
      await git(
        ['sparse-checkout', 'set', '--no-cone', `/${wt.appPath}/`, `/${FOUNDATION_PATH}/`],
        { cwd: dir },
      );
      await git(['checkout', '--force', input.baseCommit], { cwd: dir });
      wt.assertSandboxView();
      return wt;
    } catch (cause) {
      await wt.destroy().catch(() => undefined);
      throw cause;
    }
  }

  /** `apps/<app>`, relative to the repo root. */
  get appPath(): string {
    return `apps/${this.input.targetApp}`;
  }

  /** Throws unless the app and foundation exist and no protected path does. */
  private assertSandboxView(): void {
    for (const p of PROTECTED_PREFIXES)
      if (existsSync(path.join(this.dir, p)))
        throw new SandboxError('protected_path_present', `${p} is present in the worktree`);
    for (const p of [this.appPath, FOUNDATION_PATH])
      if (!existsSync(path.join(this.dir, p)))
        throw new SandboxError(
          'missing_host_mount',
          `${p} does not exist at ${this.input.baseCommit}`,
        );
  }

  /** Host directory for each mount source. Compatible with `DockerSandboxOptions.resolveHostMounts`. */
  hostMounts(): Readonly<Partial<Record<MountSource, string>>> {
    this.assertSandboxView();
    return {
      'target-app': path.join(this.dir, this.appPath),
      'application-foundation': path.join(this.dir, FOUNDATION_PATH),
    };
  }

  /** Contract mounts: the target app read-write, the foundation read-only. Nothing else. */
  mounts(): Mount[] {
    return [
      Mount.parse({
        source: 'target-app',
        containerPath: `/workspace/${this.appPath}`,
        mode: 'rw',
      }),
      Mount.parse({
        source: 'application-foundation',
        containerPath: `/workspace/${FOUNDATION_PATH}`,
        mode: 'ro',
      }),
    ];
  }

  /**
   * Canonical patch of the worktree against the base commit: `git diff --binary`, paths sorted
   * by git, no renames, LF, no timestamps. Any change outside the target app is an error.
   */
  async collectPatch(): Promise<PatchResult> {
    const { git } = this.options;
    const cwd = this.dir;
    const base = this.input.baseCommit;
    // --sparse stages files the agent created outside the sparse cone, so they are rejected below.
    await git(['add', '--sparse', '-A', '--', '.'], { cwd });
    const raw = await git(
      ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-ext-diff', base],
      {
        cwd,
      },
    );
    const files: string[] = [];
    const t = raw.split('\0');
    for (let i = 0; i + 1 < t.length; i += 2) {
      const meta = t[i] ?? '';
      const file = t[i + 1] ?? '';
      const m = /^:(\d{6}) (\d{6}) /.exec(meta);
      if (!m) throw new SandboxError('patch_failed', 'unexpected git diff --raw output');
      for (const mode of [m[1], m[2]])
        if (mode === '120000' || mode === '160000')
          throw new SandboxError(
            'patch_unsafe_entry',
            `symlinks and submodules are not allowed: ${file}`,
          );
      files.push(file);
    }
    const prefix = `${this.appPath}/`;
    const outside = files.filter((f) => !f.startsWith(prefix) || f.split('/').includes('..'));
    if (outside.length > 0)
      throw new SandboxError(
        'patch_outside_target',
        `changes outside ${this.appPath}: ${outside.slice(0, 5).join(', ')}`,
      );
    files.sort();
    const diff = await git(
      [
        'diff',
        '--cached',
        '--binary',
        '--full-index',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        base,
      ],
      { cwd },
    );
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
    const treeHash = (await git(['write-tree'], { cwd })).trim();
    return { patch: parsed.data, treeHash };
  }

  /**
   * Applies the patch to two fresh clean trees at the base commit (`git apply --check`, then
   * apply) and requires the same resulting tree hash both times, and the agent's tree hash.
   */
  async verifyReproducible(result: PatchResult): Promise<ReproducibleResult> {
    const { patch } = result;
    if (createHash('sha256').update(patch.diff, 'utf8').digest('hex') !== patch.sha256)
      throw new SandboxError('patch_not_reproducible', 'patch sha256 does not match its diff');
    const hashes: string[] = [];
    for (let run = 0; run < 2; run++) {
      const clean = await Worktree.create(this.options, this.input);
      try {
        const file = path.join(clean.tempDir, 'change.patch');
        await writeFile(file, patch.diff, 'utf8');
        const { git } = this.options;
        const applyArgs = ['apply', '--binary', '--whitespace=nowarn'];
        await git([...applyArgs, '--check', file], { cwd: clean.dir }).catch((cause: unknown) => {
          throw new SandboxError('patch_not_reproducible', 'git apply --check failed', { cause });
        });
        await git([...applyArgs, file], { cwd: clean.dir });
        await git(['add', '--sparse', '-A', '--', '.'], { cwd: clean.dir });
        hashes.push((await git(['write-tree'], { cwd: clean.dir })).trim());
      } finally {
        await clean.destroy();
      }
    }
    const [first, second] = hashes;
    if (first === undefined || first !== second)
      throw new SandboxError('patch_not_reproducible', 'two applies gave different tree hashes');
    return { treeHash: first, matchesAgentTree: first === result.treeHash };
  }

  /** Removes the worktree and its temp dir. Safe to call more than once. */
  destroy(): Promise<void> {
    this.destroyed ??= this.doDestroy();
    return this.destroyed;
  }

  private async doDestroy(): Promise<void> {
    const { git, repoDir, commands, platform } = this.options;
    let gitError: unknown;
    try {
      await git(['worktree', 'remove', '--force', this.dir], { cwd: repoDir });
    } catch (e) {
      gitError = e;
    }
    await removeDir(this.tempDir, commands, platform);
    // The directory is gone; drop any leftover registration.
    await git(['worktree', 'prune'], { cwd: repoDir }).catch(() => undefined);
    if (gitError !== undefined && existsSync(this.dir))
      throw new SandboxError('worktree_failed', 'worktree removal failed', { cause: gitError });
  }
}
