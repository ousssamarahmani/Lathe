# Report: P1-06 Tenant contract (architect)

## 1. Objective completed
P1-06, **completed, pending B's acknowledgment as consumer**. C1 is frozen v1 and answers B's Q1 to Q5. `defineTenantContract()` validates an app's contract.

## 2. Files
`packages/shared-contracts/src/tenant-contract.ts`, `packages/shared-contracts/src/tenant-contract.test.ts`, `docs/handoffs/architect-to-consumers-contracts-v1.md` (answers appended).

## 3. Decisions
| Decision | Rejected | Reason |
|---|---|---|
| Table kinds `tenant`, `organization`, `audit` | Only tenant tables | Q3: the two foundation tables must be checked too, but neither has a plain `org_id` NOT NULL |
| Test principals per role in both orgs, password via an env var name | A test-login route, or passwords in the contract | Uses the real sign-in path; no secret in the repository; every role is covered |
| `.test`/`.example` emails only | Any email | Seed data must not contain personal data (`engineering-standards.md`) |
| `alsoTouches` | `tables: []` | Additive; keeps one main table per action for the suites |
| Drop the `via-actions` fixture strategy | Keep it | Sign-up is closed by default (P1-03), so actions cannot create the principals |
| `defineTenantContract` is a thin `TenantContract.parse` | Put it in the foundation | Apps and the harness use the same check |
| Hierarchy deferred to v2 (P7-01) | Add fields now | YAGNI; the design depends on P7-01 |

## 4. Tests executed
`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`.

## 5. Results
Run after merging `origin/main` and applying B's review of PR #18:

| Command | Result | Exit |
|---|---|---|
| `pnpm install --frozen-lockfile` | up to date | 0 |
| `pnpm typecheck` | 4 of 5 workspace projects, all Done | 0 |
| `pnpm lint` | eslint clean, no dependency violations (121 modules) | 0 |
| `pnpm test` | 18 files, 246 tests passed | 0 |
| `pnpm exec vitest run packages/shared-contracts/src/tenant-contract.test.ts` | 32 passed | 0 |
| `pnpm exec prettier --check packages docs` | all files formatted | 0 |

### Review changes (B, PR #18), each with a test
1. `passwordEnv` must match `^LATHE_TEST_[A-Z0-9_]*PASSWORD$`; the harness resolves only such names (Q1).
2. `fixtures.script` is relative to the app root: no leading `/`, `\`, drive letter, `..`, nor `.github/`, `packages/`, `node_modules/` prefix. The seed runs as the app DB role, never the owner role.
3. Optional `sample`, `markField` (a key of `sample`) and `idField` on actions; `sample` and `markField` only on create and update. Additive.
4. Exactly one `organization` and one `audit` table (Q3).
5. No update or delete action on the audit table (Q3).
6. read, update and delete paths need a `:param` segment; list and create paths must not end with one.
7. Duplicate principal emails are compared case-insensitively.

## 6. Remaining issues
"Template app contract validates" (acceptance) needs the template app (P1-07, B). The test uses a Support-Desk-shaped sample contract instead.

## 7. Blockers
B acknowledges C1 v1 in the handoff file. P2-04 (tenant isolation suite) can start after this merges.

## 8. Next task
P2-04 tenant isolation suite (A), P1-07 template app with its contract (B).
