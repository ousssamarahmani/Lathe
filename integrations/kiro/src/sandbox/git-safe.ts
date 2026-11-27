import { lstat, mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SandboxError } from './errors.js';
import type { CommandResult, CommandRunner } from './command.js';

/**
 * Safe git execution on the host over a directory an untrusted agent can write.
 *
 * Threat: git discovers a repository from the working directory, so an agent that plants
 * `.git/config` (or a global/system config, or `.gitattributes`) can make `git add` run
 * `filter.<x>.clean` commands on the host. `-c core.hooksPath`, `core.fsmonitor` and
 * `core.pager` do not stop filters. Defence, all of it applied by `runSafeGit`:
 *   1. an explicit `--git-dir` outside the agent-writable tree plus `--work-tree`, so no
 *      repository is ever discovered from the agent's directory;
 *   2. system, global and attributes config replaced by an empty file, discovery capped
 *      by `GIT_CEILING_DIRECTORIES`, and a minimal environment;
 *   3. `assertNoGitMetadata`, which fails closed on any `.git`, `.gitattributes` or
 *      `.gitmodules` entry in the agent tree (rejected, not excluded).
 */

/** Names an agent may not leave in the work tree (compared after NTFS-style normalisation). */
const FORBIDDEN = new Set(['.git', '.gitattributes', '.gitmodules']);

function normalizeName(name: string): string {
  // NTFS ignores trailing dots and spaces; `git~1` is the 8.3 alias of `.git`.
  const n = name.toLowerCase().replace(/[. ]+$/, '');
  return /^git~\d+$/.test(n) ? '.git' : n;
}

/** Fails with `unsafe_git_metadata` when the tree contains git config-bearing entries. */
export async function assertNoGitMetadata(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (cause) {
      throw new SandboxError('patch_failed', `cannot read sandbox work tree: ${dir}`, { cause });
    }
    for (const name of entries) {
      if (FORBIDDEN.has(normalizeName(name)))
        throw new SandboxError(
          'unsafe_git_metadata',
          `the agent tree contains a forbidden git entry: ${path.relative(root, path.join(dir, name)) || name}`,
        );
      const full = path.join(dir, name);
      const st = await lstat(full); // lstat: never follow symlinks out of the tree
      if (st.isDirectory()) pending.push(full);
    }
  }
}

export interface SafeGitContext {
  /** Trusted git directory, outside the agent-writable tree. */
  gitDir: string;
  /** Agent-writable work tree. */
  workTree: string;
  /** Scratch directory holding the empty config file, empty hooks dir and private index. */
  scratch: string;
  env: Readonly<Record<string, string>>;
  dispose(): Promise<void>;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Creates the scratch files and the environment used by every git call. */
export async function createSafeGitContext(
  gitDir: string,
  workTree: string,
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SafeGitContext> {
  if (!path.isAbsolute(gitDir) || !path.isAbsolute(workTree))
    throw new SandboxError('invalid_host_path', 'git dir and work tree must be absolute paths');
  if (isInside(workTree, gitDir) || isInside(gitDir, workTree))
    throw new SandboxError(
      'invalid_host_path',
      'the trusted git dir must be outside the agent work tree (and not contain it)',
    );
  const scratch = await mkdtemp(path.join(tmpdir(), 'lathe-git-'));
  const emptyConfig = path.join(scratch, 'empty.gitconfig');
  const hooks = path.join(scratch, 'hooks');
  await writeFile(emptyConfig, '');
  await mkdir(hooks);
  const env: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: scratch,
    GIT_INDEX_FILE: path.join(scratch, 'index'),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
  // Only what the git executable needs to start. Never credentials.
  for (const n of ['PATH', 'Path', 'SystemRoot']) {
    const v = hostEnv[n];
    if (v !== undefined) env[n] = v;
  }
  return {
    gitDir,
    workTree,
    scratch,
    env,
    dispose: () => rm(scratch, { recursive: true, force: true }),
  };
}

/** Arguments placed before the git subcommand. */
export function safeGitPrefix(ctx: SafeGitContext): string[] {
  return [
    `--git-dir=${ctx.gitDir}`,
    `--work-tree=${ctx.workTree}`,
    '-c',
    `core.attributesFile=${path.join(ctx.scratch, 'empty.gitconfig')}`,
    '-c',
    `core.hooksPath=${path.join(ctx.scratch, 'hooks')}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.pager=cat',
    '-c',
    'diff.external=',
    '-c',
    'protocol.allow=never',
  ];
}

/** The one place that runs git on the host. Throws `patch_failed` on a non-zero exit. */
export async function runSafeGit(
  runner: CommandRunner,
  ctx: SafeGitContext,
  args: readonly string[],
): Promise<string> {
  const r: CommandResult = await runner.run('git', [...safeGitPrefix(ctx), ...args], {
    env: ctx.env,
    cwd: ctx.scratch, // never the agent directory
  });
  if (r.code !== 0)
    throw new SandboxError('patch_failed', `git ${args[0] ?? ''} failed: ${r.stderr.trim()}`);
  return r.stdout;
}
