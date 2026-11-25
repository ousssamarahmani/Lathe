# P2-03 build, typecheck, lint and test gates (verification)

Branch `task/P2-03-build-gates`, based on `44c91a1`. Not committed.

## 1. Objective completed
P2-03: completed. The `static` gate (typecheck, lint, build) and the `tests` gate now run the target app's commands as processes, with diff integrity checks. Each check has a must-catch fixture. Results use the C3 schema (`GateOutcome` mapped by the runner to `GateResult`).

## 2. Files created or modified
Created, all under `packages/verification-harness/`:
- `policies/static-tests.json` (commands, timeout, test-count floor)
- `src/gates/process.ts` (process runner, env allow-list, timeout kill, output redaction)
- `src/gates/integrity.ts` (diff scanner and the integrity checks)
- `src/gates/integrity.fixtures.ts` (33 fixtures)
- `src/gates/build-gates.ts` (`staticGate`, `testsGate`, policy schema)
- `src/gates/build-gates.test.ts` (52 tests)

Modified: `src/registry.ts` (wires both gates), `src/index.ts` (exports).
Also `docs/reports/P2-03-verification.md`.

## 3. Technical decisions
- Integrity checks scan the patch (`ctx.patch`), not the tree, and reuse `parsePatch` so unparseable input fails closed (`integrity.unparseable`). Rejected: grepping the worktree, which cannot tell what the agent added from what existed.
- Lint-silencing and build-script edits are checked in `static`. Focus, skip and test-config edits are checked in `tests`. Integrity runs before any command, and a finding stops the gate without running the app's code.
- Test-config check flags any added or removed line with a weakening key in `vitest|vite|jest|playwright|mocha` config files, plus deletion or rename of such a file and edits to `test`/`typecheck`/`lint`/`build` scripts in `package.json`. Rejected: comparing numeric thresholds, because renamed keys and other forms would slip through. The cost is that legitimate edits to those keys need a human or policy change.
- Test result is read from the JSON reporter file, not from stdout. Zero executed tests, fewer than the floor (policy `minTests[app]`, default 1), any failed test, any skipped or todo test, a missing or unreadable report, or a non-zero exit all fail. Rejected: trusting exit code alone (`passWithNoTests` would pass).
- App directory is `apps/<app>` in the worktree, with the app name checked against `Slug`. This is an assumption; the verifier layout is P5-03.
- Commands run with only `PATH`, home and temp variables, so no credentials reach them. On Windows, arguments with spaces are quoted because `shell: true` concatenates them.

## 4. Tests executed
- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm exec prettier --check packages`

## 5. Test results
- install, typecheck, lint, prettier check: exit 0 (final runs, after `prettier --write` on the new files).
- `pnpm test`: first run 195 passed, 1 failed. The failure was `tests-reject-config-renamed`: a rename away from `vitest.config.ts` was checked against the new name. I fixed the scanner to track the old path. Final run: 17 files passed, 196 tests passed, 0 failed, exit 0 (144 before, 52 new).
- A Node deprecation warning (DEP0190, `shell: true`) appears in test output. It is expected on Windows and the arguments are policy constants.

## 6. Remaining issues
- The gates were exercised with a fake runner and real tiny `node` processes. They were not run against a real app with real vitest, because no app exists yet (P3).
- Changes to `eslint.config.*` and `tsconfig*.json` are not checked, so lint or type strictness can still be loosened there. Suggest a follow-up rule or a handoff to `architect` on scope.
- The skip check is conservative: any skipped or todo test in the run fails the gate, so an app with legitimate skipped tests would need a policy option.
- No "deleted test" diff check. The test-count floor covers mass deletion, but a deletion above the floor is not caught.
- `minTests` is empty. Real floors per app need to be set by `verification` with human approval once apps have tests.
- The `static` gate does not check that `pnpm run <script>` exists beyond a non-zero exit.

## 7. Dependencies or blockers
None for this task. The verifier container layout (P5-03) must match `apps/<app>`.

## 8. Recommended next task
P2-04 tenant isolation suite, then a follow-up for the config-loosening gap above.

## Fix for review item: `.fails` tests accepted by the tests gate (PR #22)

- **Bug:** `it.fails`/`test.fails` pass in vitest when the body throws. Neither `TEST_SKIP` nor the report counts saw it, so the tests gate passed.
- **Fix:** new rule `integrity.fails` (`integrity.ts`): the diff scan rejects added `.fails` in the chain form (`it/test/describe/suite/bench`, `.fails.each`, `.concurrent.fails`), bracket form, and any `x.fails(` / `x.fails.` call (covers `test.extend` tests). `testsGate` also scans test sources (`*.test|spec.*`, `__tests__`; not `node_modules`/`dist`) of the patched tree, so a pre-existing `.fails` is caught; the run is not started.
- **Runtime check:** probed the vitest JSON reporter on an `it.fails` that throws: the test is `status: "passed"`, `meta: {}`, no `failureMessages`. The report exposes nothing, so a runtime rejection is not possible; the tree scan is the control.
- **Rejected alternative:** diff scan only. It misses a `.fails` already in the tree.
- **Regression:** 6 reject fixtures, 1 allow fixture (`failsafe`) and 2 gate tests. Before the fix: 7 failed, 54 passed in `build-gates.test.ts` (6 fixtures + tree test). After: all pass.
- **Results (worktree root):** `pnpm typecheck` 0, `pnpm lint` 0, `pnpm test` 17 files / 205 tests passed, `prettier --check packages docs` 0.
