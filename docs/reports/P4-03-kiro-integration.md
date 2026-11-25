# P4-03 Worktree and canonical patch (kiro-integration)

## 1. Objective completed

P4-03: completed. Stacked on P4-02 (PR #34). A git worktree at a base commit, the sandbox mount list built from it, and a canonical patch with a SHA-256 and a reproducibility proof.

## 2. Files created or modified

- `integrations/kiro/src/sandbox/worktree.ts` (new): `Worktree`, `createGitRunner`, `removeDir`, `FOUNDATION_PATH`, `PROTECTED_PREFIXES`.
- `integrations/kiro/src/sandbox/worktree.test.ts` (new): 24 tests (18 unit with an injected git runner, 6 with real git).
- `integrations/kiro/src/sandbox/errors.ts`: new codes `worktree_failed`, `protected_path_present`, `patch_outside_target`, `patch_unsafe_entry`, `patch_not_reproducible`.
- `integrations/kiro/src/index.ts`: exports.
- `docs/reports/P4-03-kiro-integration.md` (this file).

## 3. Technical decisions

- Sparse checkout (`worktree add --no-checkout`, `sparse-checkout set --no-cone`, `checkout`) so `packages/verification-harness/` and `.github/` physically do not exist in the worktree. Rejected: full checkout and relying on mounts alone, because the absence could not be asserted on disk.
- Mounts are only `apps/<app>` (rw, `/workspace/apps/<app>`) and `packages/application-foundation` (ro). Both are validated through the C2 `Mount` schema. `hostMounts()` matches `DockerSandboxOptions.resolveHostMounts`.
- `git add --sparse -A` before diffing, so a file the agent creates outside the sparse cone is staged and rejected with `patch_outside_target`. Without `--sparse`, git fails with a generic error.
- Outside-target check uses `git diff --raw -z`: every path must start with `apps/<app>/`. Symlink (120000) and submodule (160000) entries are rejected (`patch_unsafe_entry`). Rejected: filtering the diff by pathspec, which would silently drop the violation.
- Canonical form: `--binary --full-index --no-renames --no-ext-diff --no-textconv --no-color`, with `core.autocrlf=false`, `diff.noprefix=false`, `diff.mnemonicPrefix=false`. Git orders paths and emits no timestamps.
- Reproducibility proof: two fresh worktrees at the base, `git apply --check` then apply, `git write-tree`. The two hashes must match each other and the agent worktree's tree hash.
- The harness protected-path list is mirrored as a constant. The harness is not imported (dependency rules); `parsePatch` in `patch-parser.ts` was not needed. The Engine and CI re-check the patch independently.
- `destroy()` runs `git worktree remove --force`, then removes the temp dir with `fs.rm`, falling back on Windows to `cmd /c rmdir /s /q \\?\<dir>`, then `git worktree prune`.

## 4. Tests executed

- `pnpm exec vitest run integrations/kiro/src/sandbox/worktree.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm exec prettier --check integrations docs`

## 5. Test results

- worktree.test.ts: 24 passed, 0 failed.
- `pnpm typecheck`: exit 0. `pnpm lint`: exit 0 (no dependency violations, 277 modules).
- `pnpm test`: 39 files, 529 passed, 0 failed, exit 0 (505 before this task).
- Prettier: see the PR description for the final check result.
- A first run failed 1 test (`git add` refused paths outside the sparse cone). Fixed with `--sparse`.

## 6. Remaining issues

- `Patch.diff` is a JS string (C2 contract). A binary-free but non-UTF-8 text file would be altered by decoding. Binary files are safe because `--binary` emits ASCII. Accepted risk; a contract change (bytes) would go to `architect`.
- The symlink test is skipped silently where the OS refuses symlink creation (common on Windows without developer mode). The unit tests cover the mode check.
- The `cmd rmdir` fallback is tested through an injected `rm` failure, not a real long path.
- `Worktree` is not yet wired to `DockerSandboxRunner`/`collectPatch` in `docker-sandbox.ts`; that wiring is Engine composition work (P5-02). `security` review of the sandbox change is required.
- Real Docker was not run in this task.

## 7. Dependencies or blockers

P4-02 (PR #34, base of this branch) must merge first. P2-02 is Done on this base.

## 8. Recommended next task

P5-02 (build step: sandbox, prompt, diff, protected-path check, destroy), using `Worktree.hostMounts()` and `collectPatch()`.
