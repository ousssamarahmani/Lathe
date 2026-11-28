# P5-03 Independent verification (backend)

## 1. Objective completed
P5-03: `runVerifyStep` runs `lathe-verify` in a fresh verifier sandbox and binds the result to a hash. Completed against fakes. A real-Docker run was not done.

## 2. Files created or modified
- `services/factory-engine/src/pipeline/verify.ts` (new)
- `services/factory-engine/src/pipeline/verify.test.ts` (new, 18 tests)
- `services/factory-engine/src/pipeline/index.ts` (exports)
- `docs/reports/P5-03-backend.md`

## 3. Technical decisions
- New ports `VerifierSandboxProvider` (`liveAgentSandboxes`, `create`) and `VerifierHandle` (`startEphemeralPostgres`, `exec`) in the Engine, because C2 `SandboxHandle` has no exec. Rejected: changing C2 (architect owns it); a handoff is needed when the real provider (kiro-integration) is written.
- `harnessRef` is always `deps.baseCommit`; the patch is passed as data and applied by the provider. Rejected: letting the provider pick the harness from the patched tree.
- Outcome comes only from the parsed `VerificationReport`, and it must agree with the exit code, app and base commit. Any disagreement, timeout, crash or bad JSON gives `error`. Rejected: trusting the exit code alone.
- Binding hash = sha256 of `canonicalJson({commit, patchSha256, harnessSha256, policySha256})`. It is stored in a `verify_result` evidence entry next to the harness `resultHash`.
- Fail goes to REPAIRING while `repairAttempts < MAX_REPAIR_ATTEMPTS`, else FAILED. Error goes to FAILED with reason `verification_error`.
- Agent sandbox still alive, or the liveness check throws: `refused`, no verifier created, run stays VERIFYING (fail closed).
- Defense in depth: the stored patch hash, base commit and `checkPatchPaths` are re-checked; a mismatch gives `error` before any verifier exists.
- CLI invocation follows C3 and the real CLI: `lathe-verify <app> --worktree <dir> --commit <sha> --report <file> --patch <file> [--fault <name>]`, built from `VerifyRequest`. The report is read from the `--report` file through a new `VerifierHandle.readFile` port, then parsed with `VerificationReport`. A missing report, or a report only on stdout, is an error. Rejected: `--app --patch --json` with a stdout report (flags the CLI does not have). `--fault` is added only when `VerifyRequest.faultInjection` is set (P5-05, absent now).

## 4. Tests executed
- `pnpm install --frozen-lockfile`
- `pnpm typecheck`, `pnpm lint`, `pnpm test`
- `pnpm exec vitest run src/pipeline/verify.test.ts`
- `pnpm exec prettier --check services docs`

## 5. Results
- install, typecheck, lint: exit 0.
- `pnpm test`: exit 0, 49 files passed, 675 tests passed, 5 skipped (680).
- verify tests alone: 18 passed.
- `prettier --check services docs`: exit 0.

## 6. Remaining issues
- No real Docker, real Postgres or real `lathe-verify` run. Fakes only.
- The real `VerifierSandboxProvider` (clean checkout, harness from base commit, patch apply, ephemeral Postgres, exec with timeout kill) does not exist yet.
- Evidence stores the `verify_gate` findings truncated to 50 per gate.
- Repair itself is P5-04.

## 7. Dependencies or blockers
Depends on P5-02 (362b0d3). No blockers.

## 8. Recommended next task
P5-04 repair step, then the real verifier provider with Docker.
