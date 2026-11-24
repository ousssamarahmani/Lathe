# Report: P7-01 Hierarchical scopes in the skeleton (backend)

Branch `task/P7-01-hierarchy`, from `main` at `4b2e5a7`. Not committed at the time of writing.

## 1. Objective completed

P7-01 **completed in code, pending review** (security + architect). Opt-in scopes org → team →
project in `packages/application-foundation`: inheritance flows down, an explicit deny anywhere on
the chain wins (also over the org owner), nesting never escalates. Acceptance item "Support Desk
harness still passes" is **not run**: Support Desk (P6-01) and the harness suites (P2-04, P2-05)
are not on `main`. Existing behavior of `defineAction` is unchanged (all P1-05 tests pass).

## 2. Files created or modified

Created:
- `packages/application-foundation/src/authz/hierarchy.ts`: pure decision (`canInScope`, `effectivePermissions`, `mayAssignInScope`).
- `packages/application-foundation/src/authz/hierarchy.test.ts`: 8 fast-check properties, 7 examples.
- `packages/application-foundation/src/authz/scope-actions.ts`: `defineScopeActions(authz, { manage, read })`.
- `packages/application-foundation/src/scopes/{schema,scopes,index}.ts`: tables and in-transaction operations.
- `packages/application-foundation/src/scopes/scopes.integration.test.ts`: 19 integration tests.
- `packages/application-foundation/migrations/0005_scopes.sql`.
- `docs/handoffs/backend-to-architect-c1-v2-scopes.md`: C1 v2 request (Q4).

Modified:
- `packages/application-foundation/src/authz/action.ts`: `defineScopedAction`; authentication and the rollback/audit path extracted into `startOrgAction` and `inTenant`, shared with `defineAction` (same order of checks as before).
- `packages/application-foundation/src/authz/index.ts`, `src/index.ts`: exports.

## 3. Technical decisions

| Decision | Rejected alternative | Reason |
|---|---|---|
| Fixed depth: team under org, project under team | Teams nested in teams | Matches the documented chain; bounded chain, simpler proofs. Revisit if Team Operations needs sub-teams. |
| Structure (`scopes`) in the foundation, names and data in the app | Teams/projects tables in the foundation | The foundation stays generic and knows nothing about Team Operations. |
| Separate `scope_grants` (role) and `scope_denies` (permission) | One rules table with an effect column | Grants carry roles, denies carry permissions; two tables keep both strictly typed and checked. |
| A deny wins over every allow, including the org owner | Owner bypasses denies | `security.md`: "an explicit deny wins". Another owner can lift it. |
| Composite, org-qualified foreign keys (`(org_id, scope_id)`, `(org_id, membership_id)`, `(org_id, parent_id, parent_kind)`) | Plain FKs plus application checks | A cross-org reference is impossible in the database, whatever the code does (tested). |
| Anti-escalation: no rule changes about yourself; target member's org role must be within the caller's permissions at the scope; granted/revoked role within the caller's; lifting a deny needs the permission | Only "manage at the scope" | Otherwise a lead could lift its own deny, block the owner, or grant itself more. |
| `defineScopedAction` parses input before the permission check | Check first, like `defineAction` | The scope id comes from the input. Validation errors reveal no data. |
| Unknown or foreign scope → 404, also for a non-UUID scope id | 400 for a bad id | A foreign resource must look like a missing one. |

## 4. Tests executed

From `C:\Users\Bg\Lathe` unless stated:
- `npx vitest run --project @lathe/application-foundation src/authz/hierarchy.test.ts`
- `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`
- `pnpm test:integration` with `POSTGRES_DB=lathe_p701_test`: a fresh local database created with the same roles and grants as `infra/postgres/init/roles.sql.in` (the usual dev database carries P1-07's `notes` table, see section 6).
- Mutation runs: 4 planted bugs in `hierarchy.ts` against the unit tests; 6 planted bugs in `scope-actions.ts`, `action.ts`, `scopes.ts` against the scopes integration test.

## 5. Test results

- `pnpm test`: 17 files, 209 tests passed, 0 failed, exit 0. `hierarchy.test.ts`: 15 passed (8 properties at 2000 runs each).
- `pnpm test:integration`: 6 files, 132 tests passed (113 existing + 19 new), 0 failed, exit 0.
- `pnpm typecheck`: exit 0. `pnpm lint`: exit 0, "no dependency violations found (120 modules, 289 dependencies cruised)".
- `pnpm format:check`: exit 1, only the 12 `apps/workspace` CSS files already failing on `main` on Windows (CRLF; fixed by the `*.css` line in P9-01's `.gitattributes`). `prettier --check packages/application-foundation`: all files pass.
- Mutations, unit level (each must fail): allow checked before deny (3 failed), grants off the chain count (4 failed), deny only at the target (2 failed), child grant reaches parent (3 failed).
- Mutations, integration level: self-rule check removed (1 failed), target-above check removed (3 failed), grant role ceiling removed (1 failed), lifting a deny without the permission (1 failed), org role only instead of `canInScope` (2 failed). **Survivor:** dropping the `org_id` filter from the scope lookup, because RLS still hides the other org's scope. This is the intended second layer, not a gap.

## 6. Remaining issues

- "Support Desk harness still passes": **not run** (no Support Desk, harness suites not merged).
- C1 has no way to declare scoped actions; the suites cannot test scopes yet. Handoff to architect filed, not acknowledged.
- Local dev database: P1-07's template migrated `notes` into it, which makes the foundation test "every table with a NOT NULL org_id was defined with tenantTable()" fail there. Not caused by P7-01; ran on a fresh database instead. The test database `lathe_p701_test` is left in place locally.
- Scope rules are read per request (two small queries); no caching.
- `listScopeRules` shows rules set directly on a scope, not inherited ones.
- Deleting a team cascades to its projects and their rules; apps must delete their own team/project rows accordingly.

## 7. Dependencies or blockers

None for this task. P7-02 needs P1-07 merged and the C1 v2 answer.

## 8. Recommended next task

Review of P7-01 (security + architect), then P7-02 (Team Operations scaffold) once P1-07 is merged.
