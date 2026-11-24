# P3-04 Engine API (backend)

## 1. Objective completed
P3-04 **partially completed**: Fastify routes for projects, specs, plans, runs, approvals and the SSE event stream, over a store port and an executor port. No Postgres store and no `main.ts` wiring yet (see 6).

## 2. Files created or modified
- `services/factory-engine/src/api/`: `authz.ts`, `executor.ts`, `store.ts`, `pagination.ts`, `memory-store.ts`, `server.ts`, `test-executor.ts` (test fixture), `index.ts`, `api.test.ts`.
- `services/factory-engine/src/index.ts` (export `api`), `services/factory-engine/package.json` (`fastify` 5.12.8, exact), `pnpm-lock.yaml`.
- `services/factory-engine/src/evidence/evidence.test.ts`: one-line type fix (`head: ... ?? 'missing'`), it failed `tsc` under `exactOptionalPropertyTypes` after the merge.
- Merge of `origin/main`: conflicts in `pnpm-workspace.yaml` and `vitest.config.ts`; kept both sides (`services/factory-engine` plus `apps/*`, `templates/*`; `apps/workspace` is covered by `apps/*`). `pnpm-lock.yaml` auto-merged and was regenerated with `pnpm install --no-frozen-lockfile`.

## 3. Technical decisions
- Route logic runs through an `Executor` port. Production: `createFoundationExecutor`, which builds one foundation `defineAction` per route (authenticate, active org from session, membership, `can`, tenant tx, handler, audit). Rejected: calling `getPrincipal` and `can` by hand in each handler, which would duplicate and could drift from the foundation order.
- Permission and schemas come from C4 `ROUTES`, not re-typed. An `onRoute` hook refuses to start the server for any route without a permission declared in `engineAuthz`. Rejected: a convention-only check.
- Handler body, query and params are one strict Zod input. No org, role or verdict is read from the client; handlers get `orgId` only from `RouteContext`. Malformed ids are 404.
- Specific C4 conflict codes (`stale_approval`, `invalid_state_transition`) travel as `ActionError('conflict')` with fixed messages mapped in the API layer, because the foundation `ActionErrorCode` has no such codes. Rejected: editing the foundation (out of scope).
- Approval hash binding uses `hashContent` from P3-03 compared with the spec/plan/delivery hash; the store persists the approval. `InMemoryApprovals` is not used because persistence is the store's job. Self-approval of a spec is denied (403, audited).
- Cancel uses `transitionRun(..., 'CANCELLED')` without a capability. The API cannot reach a passing state: the capability module is not exported.
- SSE: runs after the action authorizes; `id: <seq>`; resume from `after` query or `Last-Event-ID` (query wins); reads the run state before the events so no event is lost at the terminal state; ends at a terminal state; polls otherwise.

## 4. Tests executed
From `C:\Users\user\Desktop\lathe-wt-p304`: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm exec prettier --check services`.
Integration tests (`pnpm --filter @lathe/factory-engine test:integration`): **not run**, no Postgres store exists in this task, and none were written.

## 5. Results
- frozen install: exit 0. typecheck: exit 0. lint (eslint + import boundaries): exit 0. prettier: exit 0.
- `pnpm test`: 38 files, 527 tests passed, 0 failed (exit 0). New: `src/api/api.test.ts`, 28 tests: deny-by-default (all registered routes have a declared permission; every one answers 401 without a session; unregistered/undeclared route throws at startup; role without permission 403 plus denied audit), org scoping (foreign id equals missing id on 13 routes; client org in body, query, header ignored/rejected), pagination, approvals (hash binding, stale, self-approval), cancel, error shape, SSE (ids, `Last-Event-ID` replay, query precedence, live polling, no stream for foreign org, unknown role, anonymous).

## 6. Remaining issues
- No Postgres `EngineApiStore` (needs RLS tables via `withTenant`, a non-owner role) and no composition in `src/main.ts` (does not exist yet). The foundation executor path is typed and built but not exercised against real Postgres here.
- Not implemented C4 routes (return 404): `getMe`, `setActiveOrg`, `getOverview`, `listEvidence`, `getPatch`, `listVerificationReports`, `getDelivery`, `listAgents`. A test pins this list.
- Plan creation and run start are not routes (orchestrator work, P3-05+); run creation only inserts a `DEFINED` run for an approved spec.
- SSE polling interval is a constant default (1 s); no heartbeat comments.
- Role names (`viewer`, `operator`, `approver`, `owner`) are mine; confirm with architect/security. `security` review required (authz, API auth).
- Request-id header is not echoed; the id is only in error bodies.

## 7. Dependencies or blockers
Needs P3-03 branch (this branch is stacked on it). `fastify` 5.12.8 is a new dependency.

## 8. Recommended next task
Postgres `EngineApiStore` plus integration tests as the non-owner role, then `main.ts` composition.
