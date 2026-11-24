# Report: P2-02 Protected-path check (verification)

## 1. Objective completed
P2-02, **completed, pending review**. Gate 1 (`protected-paths`) rejects any agent patch that touches a protected path. It parses `git diff` text, fails closed on anything it does not recognise, and is the first real gate in `lathe-verify`.

## 2. Files
`packages/verification-harness/`: `src/gates/patch-parser.ts`, `src/gates/protected-paths.ts`, `src/gates/protected-paths.fixtures.ts` (30 fixtures), tests `src/gates/protected-paths.test.ts` and `src/cli-patch.test.ts`, `policies/protected-paths.json`; updated `src/{gate,registry,runner,cli,index}.ts`, `fixtures/README.md`, `package.json` (zod 4.6.7 to validate the policy file, as `engineering-standards.md` requires for file input). `pnpm-lock.yaml` regenerated.

## 3. Decisions
| Decision | Rejected | Reason |
|---|---|---|
| Fail closed: unknown header lines, non-git diffs, malformed hunks and ambiguous headers are findings | Ignore what is not understood | An unparsed line is where a bypass hides |
| Hunk lines counted from `@@` ranges | Pattern-match `---`/`+++` anywhere | Content such as `--- a/.github/x` inside a hunk must not be read as a header (fixture `allow-modify`) |
| Every path from every header is checked (`diff --git`, `---`, `+++`, `rename`, `copy`) | Trust one header | A mismatched `+++` target is caught (fixture `reject-hidden-target-header`) |
| Paths folded before matching: NFKC, lowercase, trailing dots and spaces stripped | Exact match | `.GitHub/` and `.github./` are the same folder on Windows and macOS |
| Any symlink or submodule in a patch is rejected, wherever it is | Only symlinks inside protected folders | A symlink elsewhere can point into the harness |
| Protected: harness, harness self-test, `.github/`, shared contracts, `.kiro/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | Only harness and `.github/` | Contracts, steering and dependencies need the architect or a human |
| Patch passed with `--patch <file>`; missing patch gives `error` | Diff the worktree in the gate | The patch is the canonical artifact from the sandbox (C2 `Patch`); the gate cannot pass without it |

## 4. Tests executed
`pnpm install`, `pnpm typecheck`, `pnpm exec eslint packages`, `pnpm test`, `pnpm exec prettier --check packages pnpm-lock.yaml`.

## 5. Results (2026-11-19, Node v24.14.0, Windows)
All exit 0. `Test Files 13 passed`, `Tests 124 passed` (40 new: 30 fixtures, 10 gate, helper and CLI tests). 24 fixtures must fail and do; 6 must pass and do. Covered: direct edits, deletes, renames and copies in or out, mode-only changes, binary patches, case and trailing-dot variants, `..`, absolute and backslash paths, git-quoted octal paths, symlinks (new and mode change), submodules, lockfile, contracts, `.kiro`, hidden `+++` target, non-git diff, unknown header, truncated hunk.

## 6. Remaining issues
- Windows 8.3 short names (`GITHUB~1`) are not folded; the verifier runs on Linux.
- `format-patch` (email) output is rejected by design; the sandbox must produce plain `git diff` (P4-03).
- Policy changes need human approval (`security.md`); this PR creates the first policy file, so it needs it now.

## 7. Blockers and contract follow-up
- Contract C3 documents the CLI as `lathe-verify <app> --worktree --commit --report`. This adds `--patch <file>`. Architect (A) to add it in contracts v1.2 together with `VerifyRequest.patch`, and B to acknowledge.
- Stacked on PR #5 (P2-01). Merge #5 first.

## 8. Next task
P2-03 build, type, lint and test gates (due Nov 20).
## Fix after B's review (2026-11-22)
Bypass found by B: a plain `---`/`+++` diff placed after a binary section was skipped by the parser, so the gate passed while `git apply` changed `.github/workflows/ci.yml`. The parser now reads binary sections strictly (`literal`/`delta`, base85 lines, blank line, at most two blocks; then only `diff --git` or end of input). New fixtures: `reject-plain-diff-after-binary`, `reject-plain-diff-after-binary-reverse-block`, `reject-garbage-in-binary-data`, `allow-binary-in-app-with-reverse-block`; the first failed on the old parser before the fix. Defence in depth (check the paths git actually changed after applying the patch in the verifier) is assigned to P5-03.
