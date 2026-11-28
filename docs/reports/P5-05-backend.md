# P5-05 Demo fault injection (backend)

## 1. Objective completed
P5-05: Engine-side, labeled injection of a tenant-isolation bug on demo runs (D12). Completed in code and unit/integration-with-fakes tests. Not run against a real Postgres, real Kiro or the real `lathe-verify`.

## 2. Files created or modified
- `services/factory-engine/src/pipeline/fault.ts` (new): `applyFault`, `faultFlagFor`, `createFaultInjector`, `FaultInjectionError`, `RunFaultSource`.
- `services/factory-engine/src/pipeline/fault.test.ts` (new, 18 tests).
- `services/factory-engine/src/pipeline/build.ts`: `BuildFaultInjector.afterTask` context gains `final`; the call catches `FaultInjectionError`, writes `fault_error` evidence and fails the run with `build_patch_invalid`.
- `services/factory-engine/src/pipeline/verify.ts`: optional `faults: RunFaultSource` dep; `VerifyRequest.faultInjection` is set from it, so `verifyArgv` adds `--fault <name>`.
- `services/factory-engine/src/pipeline/index.ts`: export lines.

## 3. Technical decisions
- Transformation: remove the first added line `eq(<table>.orgId, ctx.orgId)` in a `kb/` file of the agent diff, fix the hunk counts and later hunk starts of that file. Rejected: appending a hunk (cannot be made deterministic against unknown file content).
- The injected change is recorded as its own small patch (`injectedPatch`, SHA-256 in evidence). The agent's patch hash is kept as `agentPatchSha256` in `fault_injected`. Rejected: overwriting the agent hash.
- Injection acts on the final task only (its patch is the cumulative one sent to verification); `final` was added to the hook context. Rejected: injecting per task, which would be lost because the next sandbox gets the prior patch.
- First attempt only: `repairAttempts === 0`. Fail closed: fault on a non-demo run, unknown fault, or no applicable filter throws `FaultInjectionError`.
- Filter must be a whole added line, and the patch must keep more than one new-side line in its hunk.

## 4. Tests executed
`pnpm install --frozen-lockfile`; `pnpm typecheck`; `pnpm lint`; `pnpm test`; `pnpm exec prettier --check services docs`.

## 5. Test results
typecheck 0, lint 0 (0 warnings after cleanup), prettier 0. `pnpm test`: 50 files passed, 695 tests passed, 5 skipped (pre-existing), exit 0. New file: 18 of 18 pass.

## 6. Remaining issues
- No run-level "injected" flag is persisted. The existing `runs.demo` and `runs.fault_injection` columns plus the `fault_injected` evidence entry are the record. A store field would touch orchestrator code outside this task.
- `RunFaultSource` has no Postgres implementation yet; the composition root must provide one reading `runs.demo`/`runs.fault_injection`/`repair_attempts`.
- Removing the only condition of a `where(...)` would produce non-compiling code; this is not detected. The demo agent output is expected to use `and(eq(orgId), ...)` form.
- The `--fault` flag is passed on every verify of a demo run with a fault (including after repair), as specified; harness-side handling is P2/verification's.
- No assertion against the real P5-04 repair loop or P8-01 delivery: the "cannot reach AWAITING_APPROVAL" test is at the verify step with a failing report.

## 7. Dependencies or blockers
Stacked on P5-03 (688a8ec, PR #44). No new dependencies.

## 8. Recommended next task
Wire `createFaultInjector` and the `faults` source in the composition root; P5-07 demo run.
