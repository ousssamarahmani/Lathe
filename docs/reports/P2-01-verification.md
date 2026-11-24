# Report: P2-01 Runner, result schema, CLI (verification)

## 1. Objective completed
P2-01, **partially completed**. Runner, `lathe-verify` CLI and result hashing exist and are tested. Not done: the dedicated CI self-test workflow (needs `devops`, see 7). The result schema is contract C3 (P0-07); the runner validates every report against it.

## 2. Files
`packages/verification-harness/`: `src/{gate,registry,hash,runner,cli,bin,index}.ts`, tests `src/{runner,hash,cli}.test.ts` and `src/test-helpers.ts`, `bin/lathe-verify.mjs`, `policies/README.md`, `fixtures/README.md`, `package.json`, `tsconfig.json`. `pnpm-lock.yaml` regenerated.

## 3. Decisions
| Decision | Rejected | Reason |
|---|---|---|
| Unimplemented gates report `error` | Skip them or pass them | A harness that cannot fail is a defect; today the CLI always exits 2 |
| Runner validates its own report with C3 before returning | Trust the runner | It cannot emit `overall: passed` that its gates do not show |
| A gate that throws, fails without findings, or registers under the wrong id becomes `error` | Crash the run | Always produce a report |
| `harnessSha256` = tree hash of `src/`, `policySha256` = tree hash of `policies/` | Package version | Any edit changes the hash; reproducible across OSes (LF enforced) |
| `tsx` 4.23.15 to run the CLI | Build step | Workspace packages export TypeScript sources; `@types/node` 22.20.5 for Node APIs |

## 4. Tests executed
`pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`, and the real CLI: `pnpm --filter @lathe/verification-harness lathe-verify support-desk --worktree /workspace/app --commit <sha> --report <file>`.

## 5. Results (2026-11-18, Node v24.14.0, Windows)
All exit 0; `Test Files 11 passed, Tests 84 passed` (19 new in the harness). CLI: exit 2, `protected-paths=error`, rest `not_run`, report written and valid.

## 6. Remaining issues
- Gates are placeholders until P2-02 to P2-07.
- Symlinks are skipped by `hashTree`; the protected-path gate (P2-02) must reject symlinks in patches.
- Not run on Node 22 or inside a verifier container.

## 7. Blockers
`devops` (B): `.github/workflows/harness-selftest.yml` from the task text. Harness unit tests already run in CI through `pnpm test`; a separate self-test job is useful once per-gate fixtures exist (P2-02).

## 8. Next task
P2-02 protected-path check (first real gate).