# Handoff: architect to all contract consumers, contracts v1

- **From:** architect (person A)
- **To:** backend, frontend, kiro-integration, verification (persons A and B)
- **Blocked task:** P0-07 is not Done until each consumer acknowledges below.
- **Deadline:** 2026-11-18

## What is needed

Review the contract you consume in `packages/shared-contracts/src/` and acknowledge it, or request a change. A change after acknowledgment goes through a new handoff.

| Contract | File | Status | Consumers |
|---|---|---|---|
| C1 Tenant contract | `tenant-contract.ts` | Draft (final in P1-06) | verification, backend (application-foundation) |
| C2 Kiro adapter and sandbox | `kiro-adapter.ts` | Frozen v1 | kiro-integration (implements), backend (Engine pipeline) |
| C3 Gates and `lathe-verify` | `gates.ts` | Frozen v1 | verification (implements), backend (Engine verify step) |
| C4 Engine API | `api.ts` | Frozen v1 | backend (implements), frontend (Workspace) |

## Points B should check against P1-01

- C1 requires every tenant table to declare `orgColumn: 'org_id'` and `rls: { enabled: true, forced: true }`. The P1-01 migration creates `memberships.org_id`; confirm that RLS for tenant tables lands in P1-02 so contracts can declare it truthfully.
- C4 never accepts an org id from the client. Organization switching (P1-04) must come from the membership.

## Acknowledgments

| Role | Person | Contract | Decision | Date |
|---|---|---|---|---|
| backend | B | C1, C4 | **Acknowledged with notes.** RLS on `memberships` lands in P1-02; P1-04 takes the active org from the membership only. C1 questions Q1–Q5 below, for P1-06 | 2026-11-18 |
| frontend | B | C4 | **Change requested:** R1–R4 below block Workspace tasks; R5–R8 are clarifications | 2026-11-18 |
| backend | A | C2, C3, C4 | pending | |
| kiro-integration | A | C2 | pending | |
| verification | A | C1, C3 | pending | |

## Response from B (backend, frontend), 2026-11-18

Reviewed on branch `task/P0-07-b-contract-ack`, taken from `origin/task/P0-07-interface-contracts` at `195f36a`. C2 and C3 were not reviewed (not consumed by B).

### Checks re-run by B

| Command | Result | Exit |
|---|---|---|
| `pnpm install --frozen-lockfile` | `Done in 6.1s` | 0 |
| `pnpm typecheck` | `packages/shared-contracts typecheck: Done` (and the two other packages) | 0 |
| `pnpm lint` | no findings | 0 |
| `pnpm test` | `Test Files 7 passed (7)`, `Tests 58 passed (58)` | 0 |

The C1 tests cover rejection of undeclared permissions, wildcards, actions on undeclared tables, tables without forced RLS, a tenant column other than `org_id`, duplicate routes and unknown keys. The C4 tests cover `/v1` prefix and declared permission on every route, no merge/deploy/override route, an org id rejected in a request body, a verdict rejected in a decision body, and fault injection only on demo runs.

### Answers to the two points for B

1. **RLS:** confirmed. P1-01 (branch `task/P1-01-schema-audit`, report `docs/reports/P1-01-backend.md`) creates `memberships.org_id` without RLS. P1-02 applies `tenantTable()` with `ENABLE` and `FORCE ROW LEVEL SECURITY` to `memberships` before any contract declares it.
2. **Org switching:** confirmed. P1-04 sets the active org only after checking that the user has a membership in it. No route trusts a client-supplied org id as authorization input.

### C1 questions for P1-06 (not blocking, C1 is a draft)

- **Q1. Harness login.** The tenant isolation suite must act as a user of org A and of org B, with each role. C1 has no field for test users or how to obtain a session. Proposal: a `testPrincipals` section, or a fixed login route from P1-03 that the harness uses.
- **Q2. Server actions.** `TenantAction.http` requires a method and path. If `defineAction` wraps Next.js server actions, they have no stable URL. Proposal: decide that every contract action is exposed as an `/api/...` route handler, or add a server-action kind.
- **Q3. Foundation tables.** `organizations` has no `org_id` (its `id` is the org) and `audit_events.org_id` is nullable (denied requests may have no org). Neither can be a `TenantTable`. Which suite tests isolation and append-only on these two?
- **Q4. Hierarchy.** C1 knows only `org_id`. P7-01 (Team Operations) adds team and project scopes with explicit deny. C1 needs a way to declare scoped tables and deny rules before P7-02.
- **Q5. Actions spanning tables.** `TenantAction.table` is required and single. An approval that reads a ticket and writes an approval row has one table only. Proposal: `tables: [...]`, or allow `custom` actions without a table.

### C4 change requests

Blocking for Workspace tasks:

- **R1. Current user (P9-02).** Add a route such as `GET /v1/me` returning the user, their memberships, the active org and the active org's **permissions**. The UI must hide actions the user cannot perform; the Engine still enforces.
- **R2. Login, logout, org switch (P9-02, P1-04).** C4 has no auth routes. State where they live (for example the Better Auth handler mounted on the Engine, outside `/v1`) and how the active org is switched without the client asserting an org (for example `POST /v1/session/active-org` with a membership id that the Engine checks).
- **R3. Patch content (P9-06).** `EvidenceEntry.summary` is limited to 500 characters and there is no route returning the patch. The diff viewer needs one, for example `GET /v1/runs/:runId/patches/:attempt`, returned as text and rendered as untrusted.
- **R4. Event stream resume (P9-05).** Define how `streamRunEvents` resumes after a reload or disconnect: replay from `seq` via `Last-Event-ID` or `?after=<seq>`. Without it, the live view loses agent events and gate results already sent.

Clarifications:

- **R5. List query parameters.** Lists are cursor-paginated, but `cursor` and `limit` are not defined (`request: null` on GET routes). Add a query schema to `RouteDef`.
- **R6. One spec, and spec edits (P9-04).** Add `GET /v1/specs/:specId`. Confirm that editing a spec means submitting a new version that sets the old one to `superseded`.
- **R7. Delivery before a PR exists (P9-06).** State whether `getDelivery` answers `not_found` before delivery, or returns a nullable body.
- **R8. Agents and Settings pages (P9-02).** No routes back them. Confirm they stay honest empty states for the MVP (cut ladder step 6).

## Answers from architect (P1-06, 2026-11-22)

C1 is final (frozen v1) in `packages/shared-contracts/src/tenant-contract.ts`.

- **Q1 harness login:** `session.signIn` and `session.setActiveOrg` name the routes; `principals` lists a test user per role in org A and org B (`.test`/`.example` emails); `passwordEnv` names the env var with their password. The contract never holds a secret.
- **Q2 server actions:** every contract action is an HTTP route through `defineAction`. A Next.js server action calls the same `defineAction` and is not listed.
- **Q3 foundation tables:** `organizations` (kind `organization`) and `audit_events` (kind `audit`, append-only) are declared and checked by the suites.
- **Q4 hierarchy:** not in v1; P7-01 adds it as v2.
- **Q5 several tables:** `table` is the main target, `alsoTouches` lists the rest.
- **Fixtures:** only `seed-script` remains. `via-actions` cannot create users because sign-up is closed by default (P1-03).
