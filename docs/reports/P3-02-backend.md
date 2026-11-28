# Report: P3-02 Run state machine (backend)
## 1. Objective completed
P3-02, **completed, pending review**. Integration tests are written but **not run** (see 5).
## 2. Files
`services/factory-engine/src/orchestrator/{errors,capability,state-machine,run-store,memory-run-store,pg-run-store,index}.ts`, `state-machine.test.ts`, `run-store.integration.test.ts`. `services/factory-engine/src/index.ts` re-exports the orchestrator index (which does not export `capability.ts`).
## 3. Decisions
| Decision | Rejected | Reason |
|---|---|---|
| Pure `nextSnapshot` plus a `RunStore` port; the store locks the row (`FOR UPDATE`), calls `decide`, updates `runs` and appends `run_events` in one `withTenant` transaction | Updating state and inserting the event in separate calls | An illegal transition or crash leaves nothing half-written; the row lock gives gap-free `seq` |
| Passing states (`AWAITING_APPROVAL`, `DELIVERED`) need an `EngineCapability`: a branded object checked by identity against a WeakSet, issued by `issueEngineCapability()` in a module not exported from the package index | A boolean flag or string token | A flag or string can be forged from API or agent input; an object that only Engine code can import cannot |
| `VERIFYING → REPAIRING` consumes one attempt; the fourth throws `repair_limit_exceeded` (0–3, matches the `runs` CHECK) | Counting on re-entry to BUILDING | One counting point |
| Resume returns `NextAction` per non-terminal state; `BUILDING` maps to `restart_build` | Reattaching to a sandbox | Sandboxes do not survive an Engine restart |
| `MemoryRunStore` for unit tests, same contract as `PgRunStore` | Mocking Drizzle | Integration tests use real Postgres |
## 4. Tests executed
`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm exec prettier --check services`, `pnpm exec vitest run services/factory-engine/src/orchestrator --reporter=verbose`.
Not run: `pnpm --filter @lathe/factory-engine test:integration`.
## 5. Results
install 0, typecheck 0, lint 0 (after removing four non-null assertions in the integration test), prettier 0. `pnpm test`: 18 files, 226 tests passed. Orchestrator file: 12 tests passed, including two fast-check properties (random transition sequences: illegal edges throw, state stays valid, repairs stay at most 3; no passing state without the capability) and the crash/resume test with the in-memory store.
Integration (4 tests in `run-store.integration.test.ts`: persistence plus restart, rollback and capability, repair bound, other-org run is not found) was **not run**. The `LATHE_DB_*` and `POSTGRES_DB` variables are not set, and the only running Postgres container belongs to another project (`sparkkit-postgres-1`); I did not use it.
## 6. Remaining issues
Integration tests unverified. `issueEngineCapability` has no caller yet; the composition root (`src/main.ts`) and pipeline will use it. Only one `run_events` type (`state_changed`) exists.
## 7. Dependencies or blockers
Depends on P3-01 (done on its branch, PR base). No new dependencies.
## 8. Recommended next task
P3-03 (evidence and approvals), then P3-04 (API) using `transitionRun`.

## Fix round (PR #20 review by B)
- New migration `services/factory-engine/migrations/1001_run_state_guard.sql` (1000 is already applied on main): BEFORE UPDATE trigger on `runs` (SECURITY INVOKER, owner-owned). It refuses edges outside the allowed table, any change in DELIVERED/FAILED/CANCELLED, `repair_attempts` changes other than exactly +1 on VERIFYING->REPAIRING, and changes to id, org_id, project_id, spec_id, demo, fault_injection, created_at and an already-set plan_id. Violations raise SQLSTATE 23514. A unit test compares the SQL edge list with the TypeScript table.
- `TransitionDecision` no longer carries an event. `PgRunStore` and `MemoryRunStore` build the `run_events` row from (current, next, repairAttempts) with `buildTransitionEvent`; only `reason` (string, at most 200 chars) comes from the caller, anything else is rejected with `illegal_transition`.
- Tests: `state-guard.integration.test.ts` (Postgres, app role; 7 failed before the fix), `event-integrity.test.ts` (unit). Results: `pnpm test` 564 passed, 5 skipped; `pnpm test:integration` 35 passed (before the fix: 7 failed, 28 passed); typecheck, lint exit 0.

## Fix round 2 (PR #20, second review by B)
- `1001_run_state_guard.sql` now also has a BEFORE INSERT trigger on `runs`: a new run must be DEFINED, 0 repair attempts and no plan_id, otherwise SQLSTATE 23514. Four raw-INSERT tests as the app role in `state-guard.integration.test.ts` (DELIVERED, BUILDING with 3 attempts and DEFINED with a plan_id are refused; DEFINED/0/NULL is accepted). Before the trigger: 3 failed, 36 passed. After: 39 passed (6 files).
- Two seed helpers from #21 (`append-only*.integration.test.ts`) inserted runs as VERIFYING with a plan. They now insert DEFINED and walk legal edges. No Engine production code inserts runs yet.
- Documented where the app role's table grants come from (default privileges in `infra/postgres/init/roles.sql.in`, not `0001_initial.sql`) in the header of `1001_run_state_guard.sql` and in `migrations/README.md`.
- The "INSERT in a non-DEFINED state" gap listed above is now closed.
