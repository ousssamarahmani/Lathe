# P5-01 Plan step: backend report

## 1. Objective completed
P5-01 Plan step, completed in the Engine against a fake KiroAdapter. Not run against real Kiro.

## 2. Files created or modified
- `services/factory-engine/src/pipeline/plan.ts`, `pipeline/index.ts`: `runPlanStep`, `buildPlannerPrompt`, `extractJsonObjects`, `planApprovalSubject`, dependency interfaces.
- `services/factory-engine/src/pipeline/plan.test.ts`: 12 tests.
- `services/factory-engine/src/index.ts`: exports the pipeline module.
- This report.

## 3. Technical decisions
- Spec is serialized as JSON inside a labeled fence. A fence string inside the spec is replaced, so the spec cannot close the fence. Rejected: raw interpolation.
- Exactly one JSON object is accepted. Zero or several are invalid and feed back to the retry. Rejected: taking the first object (ambiguous).
- Validation reuses `validatePlan` (PlanDraft schema plus targetPaths check) from the domain module. Rejected: a second validator.
- Timeout or adapter error escalates at once with no retry. Only invalid output is retried, once. Rejected: retrying infrastructure errors (hides faults).
- Plan, approval and sandbox access go through small injected interfaces (`PlanStore`, `PlanApprovalRequests`, `PlannerSandboxProvider`, `SpecSource`). The step imports nothing from `integrations/*`.
- Evidence output and validation feedback are redacted with the P3-03 redactor and size-capped.
- Run moves DEFINED→PLANNED with the Engine capability. It never moves to BUILDING.

## 4. Tests executed
- `pnpm install --frozen-lockfile`
- `pnpm typecheck`, `pnpm lint`, `pnpm test`
- `pnpm exec prettier --check services docs`
- `pnpm exec vitest run src/pipeline` in `services/factory-engine`

## 5. Test results
- typecheck exit 0. lint exit 0 (no dependency violations, 367 modules). Prettier exit 0.
- Root `pnpm test`: 47 files passed, 621 tests passed, 5 skipped (626), exit 0. The skips were not touched by this task.
- Pipeline file alone: 12 passed, 0 failed. It covers valid plan, one retry, double failure, path outside targetPaths, prose and two objects, injection fence, timeout with cancel, adapter error, secret redaction, non-DEFINED run, and two fast-check properties (100 runs for the PLANNED invariant).
- Lint initially failed on non-null assertions in the WIP; fixed.

## 6. Remaining issues
- Real `PlanStore`, approvals persistence and sandbox provider are not implemented. Only interfaces and in-memory test doubles exist. The composition root does not wire them.
- No Workspace UI for plan approval (separate task).
- Planner agent profile `planner` is assumed to exist in the Kiro integration. Not tested with real Kiro.
- Property test seeds are not logged beyond fast-check defaults.

## 7. Dependencies or blockers
Depends on P3-01..P3-03, which are in the merged #20 branch. This work is stacked on #20.

## 8. Recommended next task
P5-02 Build step, and wiring of the real stores in `main.ts`.
