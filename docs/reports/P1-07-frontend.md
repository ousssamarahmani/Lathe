# Report: P1-07 Template app and generator (frontend)

Branch `task/P1-07-template`. Started before P1-06 was Done (lead exception, see section 7): the
template's tenant contract is built against C1 v1 from PR #18 at `c2246be` (approved, not merged),
merged into this branch together with `main` at `a8b4eec`.

## 1. Objective completed

P1-07 **completed, pending review** (architect). `templates/app-starter`: sign-in, org switcher,
members page with invitation links, one example tenant resource ("notes"), layout and design
tokens, a C1 tenant contract; `pnpm new-app <name>`; `packages/application-foundation/README.md`
with the extension points. Acceptance "passes P2 harness" is **not run**: the harness suites
(P2-04, P2-05, P2-06) are not merged and have known conflicts with this app (section 6).

## 2. Files created or modified

- `templates/app-starter/**`: Next.js app (`src/app/**` pages and `v1` routes, `src/server/**`
  actions, HTTP adapter, env, deps, seed data), `src/tenant-contract.ts` and its test,
  `migrations/app-starter_0001_notes.sql`, `scripts/{create-db,migrate,seed}.ts`,
  `e2e/**` and `playwright.config.ts`, unit and integration tests, `README.md`.
- `scripts/new-app.ts`, `scripts/new-app.test.mjs`; root `package.json` (`new-app` script).
- `packages/application-foundation/README.md` (new), `package.json` (`exports`),
  `src/db/migrate.ts` (`webpackIgnore` on the migrations URL).
- `pnpm-workspace.yaml` and `vitest.config.ts` (`apps/*`, `templates/*`), `.env.example`
  (`LATHE_TEST_PASSWORD` replaces `LATHE_DEMO_PASSWORD`; `LATHE_APP_BASE_URL`), `pnpm-lock.yaml`.

## 3. Technical decisions

| Decision | Rejected alternative | Reason |
|---|---|---|
| One adapter `route(action)` in `src/server/http.ts`; route files only export `route(...)` | Mapping results in each route | One place for status codes, the error shape `{ code, message, requestId }`, server request ids, and path params overriding body fields |
| Origin / `Sec-Fetch-Site` check on every non-GET route, on top of `SameSite=Lax` | Cookies alone | Cross-site writes with the session cookie are refused (tested) |
| Pages read data through the same actions (`load(action)`) | Direct queries in server components | Same session, membership, permission, RLS and audit as the API |
| Each app has its own database `<POSTGRES_DB>_<app>`, created by `pnpm db:create` (superuser, local/CI only) | Sharing the foundation's database; narrowing the foundation's table test | App tables mixed into the foundation database broke its "every NOT NULL org_id table is a tenantTable()" test; weakening that test is not allowed |
| Contract built from `authz` and the seed data, checked against the route files | A hand-written contract | Cannot drift from the code |
| Only `notes` declared as a tenant table in the contract | Also `memberships`, `invitations` | Those are foundation tables without create/read/update/delete routes of the C1 shape; the suites would report `no-create-action` |
| Webpack (`next build --webpack`) | Turbopack | Turbopack does not resolve the `./x.js` imports of the TypeScript source packages |
| Design tokens copied from `apps/workspace` | A shared UI package | Apps may not import `apps/workspace`; a package is a later decision |
| e2e: throwaway database `*_e2e` (dropped before and after), random auth secret and password per run, results outside the repo | Reusing the dev database | No state between runs, no secret on disk |

New dev dependencies (human approval required by `security.md`; approved by B in the session):
`tsx` 4.23.15 (runs the TypeScript scripts) and `@playwright/test` 1.65.1 (smoke test). Both in
`templates/app-starter/package.json` only, pinned.

## 4. Tests executed

From `C:\Users\Bg\Lathe`: `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm test:integration` (with `POSTGRES_DB=lathe_p701_test`, a fresh database, run twice), and in
`templates/app-starter`: `pnpm test:e2e`. Mutations (planted bug, then restored):
viewer allowed to create notes, run through `pnpm test:e2e`. Generated-app check:
`pnpm new-app smoke-check`, `pnpm install`, then its typecheck, unit tests, integration tests and
build; the app and its database were removed afterwards and the lockfile restored.

## 5. Test results

- `pnpm format:check`, `pnpm typecheck`: exit 0. `pnpm lint`: exit 0, "no dependency violations
  found (183 modules, 470 dependencies cruised)".
- `pnpm test`: 22 files, 313 tests passed, exit 0.
- `pnpm test:integration`: foundation 132 passed; template 15 passed, exit 0. First run:
  "app database created; migrations applied: 0001 … 0005, app-starter_0001_notes.sql"; second run:
  "app database exists; migrations applied: none pending". The foundation tests stay green because
  `notes` is now in the app's database.
- `pnpm test:e2e`: 4 passed (redirect without session; wrong password; org A note invisible to
  org B in the list and by URL; viewer sees no create form or member controls).
- Mutation, viewer may create notes: e2e 1 failed, 3 passed (caught). Earlier mutations on this
  branch (body id over path id, origin check off, viewer create, org id in responses, foreign
  delete answering 204, error message on 500): all caught by unit or integration tests.
- Generated app `smoke-check`: new-app, install, typecheck, integration (15 passed on its own
  database `lathe_smoke_check`) and build all exit 0. Its unit tests first had **1 failure**:
  `config.test.ts` hard-coded the template's database name, which the generator does not rename.
  Fixed (derived from `APP_SLUG`), and `new-app.test.mjs` now fails if any generated file still
  contains `app_starter`. After the fix: 46 passed.
- Earlier on this branch: manual run of `next start` with HTTP calls (sign-in, org switch, 404
  across orgs, 403 for a viewer, 401 without session, pages per org): all as expected. It found the
  missing-`params` bug on static routes, fixed with a regression test.

## 6. Remaining issues

- **Harness conflicts** (for `verification` / architect, PRs #23, #24, #26):
  - #24 deny-by-default scan expects `defineAction(...)` in route files; this app exports
    `route(action)` (the action itself is a `defineAction`), and the Better Auth catch-all route
    has no wrapper by design. Every route file would be flagged.
  - #23 compares a foreign row's 404 body with a missing row's; each error body carries its own
    `requestId`, so they differ unless the suite ignores that field.
  - #23 expects `GET /v1/notes?org_id=…` to answer 2xx; strict input schemas answer 400.
  - #23, #24, #26 send `{ label }`; this contract declares `sample` and `markField: 'title'`.
- e2e is not in CI (needs the browser download and a workflow change). CI integration should work:
  the CI `.env` has `POSTGRES_SUPERUSER` and its password. **Not verified in CI yet.**
- Local dev database `lathe` still holds `notes` and the template seed from the first run of this
  branch; the foundation integration test fails there until it is cleaned. Test databases left
  locally: `lathe_app_starter`, `lathe_p301_test`, `lathe_p302_test`, `lathe_p701_test`,
  `lathe_p701_test_app_starter`.
- After the e2e teardown drops its database, the still-open pool logs "database connection lost"
  (handled, no crash).
- PR #19 adds the same `exports` line to the foundation `package.json`; whichever merges second
  gets a trivial conflict.

## 7. Dependencies or blockers

Depends on P1-06 (#18): merge #18 before this PR. Started early as an exception to "Ready only
when dependencies are Done", because P1-07 and P6-01 were late; the lead (A) still needs to
confirm it.

## 8. Recommended next task

P6-01 (`pnpm new-app support-desk`, roles requester/agent/admin, tickets, comments, assignment)
and P7-02 (Team Operations on the P7-01 scopes).
