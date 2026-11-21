# P0-10 Import-boundary enforcement (devops)

Person: B. Branch: `task/P0-10-import-boundaries`, from `origin/main` at `399ff88`. Date: 2026-11-19.

## 1. Objective completed

P0-10, **completed**. The dependency table in `.kiro/steering/architecture.md` is enforced by dependency-cruiser, run as part of `pnpm lint`, which CI already runs on every pull request. 16 rules, each proven by a planted violation in a fixture tree. A deliberate violation in a scratch file in the real tree fails `pnpm lint`; the clean tree passes.

## 2. Files created or modified

- `.dependency-cruiser.mjs` (new): the 16 rules and resolver options.
- `scripts/check-import-boundaries.mjs` (new): runs dependency-cruiser over the first-party folders that exist (`packages`, `apps`, `services`, `integrations`, `templates`, `scripts`, `tests`).
- `scripts/import-boundaries/import-boundaries.test.mjs` (new): 5 tests.
- `scripts/import-boundaries/fixtures/violations/**` (28 files) and `fixtures/clean/**` (12 files) (new).
- `package.json` (root): `lint` is now `eslint . && node scripts/check-import-boundaries.mjs`; dev dependency `dependency-cruiser` 18.8.0.
- `vitest.config.ts` (root): project `scripts` for tooling tests.
- `pnpm-lock.yaml`.

No change under `.github/`: the CI job already runs `pnpm lint`.

## 3. Technical decisions

- **dependency-cruiser** rather than ESLint plugins. One tool covers path-based rules, relative and package-name imports, type-only imports, and cycles. Rejected: `eslint-plugin-boundaries` (no cycle detection, needs `eslint-plugin-import-x` and a resolver on top), and ESLint's built-in `no-restricted-imports` (matches import strings, so `../../x` paths of any depth slip through). Pinned 18.8.0; supports Node 22 and 24. It is a dev dependency with no security impact on runtime code.
- **Rules apply to folders that do not exist yet** (`apps/`, `services/`, `integrations/`, `templates/`), so the boundary is in place before the code arrives.
- **Rules** (one per row of the table, plus cross-cutting ones):

  | Rule | Enforces |
  |---|---|
  | `no-circular` | no import cycles |
  | `no-unresolvable` | a relative or `@lathe/` import that does not resolve is an error, so a typo cannot escape the other rules |
  | `only-through-index` | another package is reached only through its `src/index.ts` |
  | `contracts-no-first-party`, `contracts-zod-only` | shared-contracts imports no first-party code and nothing but zod (tests may use vitest) |
  | `harness-only-contracts`, `nobody-imports-harness` | the harness imports only shared-contracts; nothing imports the harness |
  | `foundation-no-lathe` | application-foundation imports no service, integration, app or template |
  | `apps-no-lathe`, `app-not-other-app` | apps and the template import no service or integration, and never another app |
  | `workspace-only-contracts`, `workspace-no-db` | the Workspace imports only shared-contracts, and not `pg`, `drizzle-orm` or `better-auth` |
  | `engine-no-apps`, `engine-integrations-only-in-main` | the Engine imports no app; integrations only from `services/factory-engine/src/main.ts` |
  | `nobody-else-imports-integrations`, `integration-only-contracts` | integrations are imported only by the Engine composition root, and import only shared-contracts |

- **Type-only imports count** (`tsPreCompilationDeps: true`): a type import still couples packages.
- **Explicit folders, not `.`**: scanning `.` walked `node_modules` and did not finish within 5 minutes. `node_modules` stays visible as an import target (needed for the zod-only and no-database rules) through `doNotFollow`.
- **Fixtures mirror the repository layout** and are run with `--cwd`, so the tests use the exact config and script that `pnpm lint` uses. The fixture folder is excluded from the real scan.

## 4. Tests executed

Windows, Node v24.14.0, pnpm 9.15.9.

```powershell
node scripts/check-import-boundaries.mjs --cwd scripts/import-boundaries/fixtures/violations
node scripts/check-import-boundaries.mjs --cwd scripts/import-boundaries/fixtures/clean
node scripts/check-import-boundaries.mjs
# acceptance: scratch violation in the real tree
#   packages/application-foundation/src/scratch-violation.ts: import '../../verification-harness/src/index.js'
pnpm lint      # with the scratch file, then again after deleting it
# rules against the newest foundation code (branch task/P1-05-authz, in a temporary worktree)
node scripts/check-import-boundaries.mjs --cwd <worktree of task/P1-05-authz>
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
```

## 5. Test results

| Check | Result | Exit |
|---|---|---|
| violations fixture | `x 18 dependency violations (18 errors, 0 warnings)`; all 16 rules fire | 18 |
| clean fixture | `no dependency violations found (16 modules, 21 dependencies cruised)` | 0 |
| real repository (`main`) | `no dependency violations found (49 modules, 85 dependencies cruised)`, about 1 s | 0 |
| `pnpm lint` with the scratch violation | `error nobody-imports-harness: packages/application-foundation/src/scratch-violation.ts → packages/verification-harness/src/index.ts`, `1 dependency violations` | 1 |
| `pnpm lint` after deleting it | clean | 0 |
| `task/P1-05-authz` tree (P1-01 to P1-05 code) | `no dependency violations found (70 modules, 200 dependencies cruised)` | 0 |
| `pnpm typecheck` | all packages `Done` | 0 |
| `pnpm lint` | ESLint clean; `no dependency violations found (51 modules, 90 dependencies cruised)` | 0 |
| `pnpm test` | `Test Files 10 passed (10)`, `Tests 81 passed (81)` (5 new) | 0 |
| `pnpm format:check` | clean | 0 |

The 5 tests: exactly the 18 planted violations are reported and nothing else; every rule in the config has a planted violation; the checker exits non-zero on the violations tree; the clean tree passes; the repository passes.

## 6. Remaining issues

- **Layering inside the Engine** (`api → orchestrator/pipeline → {evidence, approvals} → {db, domain}`, modules through their `index.ts`) is not enforced yet. `services/factory-engine` does not exist; add the rules with P3-01, with fixtures.
- **"Nothing depends on Kiro Crew"** has no rule: Crew is not an importable package, so there is nothing to match.
- **Production code importing a dev dependency** (for example `fast-check` outside tests) is not checked. Not in this task.
- The scan list in `scripts/check-import-boundaries.mjs` must grow if code is added in a new top-level folder.
- Not run on Node 22 locally; CI runs Node 22.

## 7. Dependencies or blockers

None. Reviewer: `architect`.

## 8. Recommended next task

Review of PR #8 (P0-04 spike). Then P3-01 adds the Engine layering rules here.
