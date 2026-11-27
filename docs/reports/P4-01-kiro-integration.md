# P4-01 Kiro adapter: report (kiro-integration)

## 1. Objective completed

P4-01, partially completed. The C2 `KiroAdapter` is implemented for the P0-04 path (ACP over stdio to `kiro-cli acp`, mode B) and tested against a fake ACP server and two hand-written transcripts. The real-CLI smoke script exists but was **not run** (it needs a Kiro login and a `/workspace/app` directory). The task's "works against the real CLI" criterion is therefore open.

## 2. Files created or modified

New package `@lathe/kiro-integration` in `integrations/kiro/`:

- `package.json`, `tsconfig.json`, `vitest.config.ts`
- `src/adapter.ts`: `AcpKiroAdapter` and the session (JSON-RPC client, event log, timeouts, permission answers)
- `src/acp-schemas.ts`: Zod schemas for every inbound message
- `src/permission-policy.ts`: `decidePermission`
- `src/process.ts`: `AcpProcess`, `SpawnFn`, `hostSpawn`
- `src/errors.ts`: `KiroAdapterError`, `KiroTimeoutError`
- `src/index.ts`
- `src/testing/fake-acp-server.ts`: `FakeAcpServer` (scripted) and `ReplayAcpServer` (transcripts)
- `src/adapter.test.ts`, `src/replay.test.ts`
- `fixtures/transcripts/edit-turn.jsonl`, `fixtures/transcripts/cancelled-turn.jsonl`
- `scripts/real-smoke.ts`

Modified: `pnpm-workspace.yaml`, root `vitest.config.ts`, `pnpm-lock.yaml`.

## 3. Technical decisions

- **Injectable `SpawnFn(context)`** that receives the filtered env, the `SandboxHandle` and the request. Rejected: spawning inside the adapter, which would make tests run the CLI and leave P4-02 no hook to run the CLI in a container.
- **Env allow-list, empty by default.** The child never sees host variables unless named in `envAllowlist`.
- **`start()` does not send `request.prompt`.** The Engine calls `session.prompt(text)`; `request.prompt` is validated but unused by the adapter. Rejected: auto-sending, because the Engine may build a later prompt from plan state. Needs confirmation from `architect` (see section 6).
- **Timeouts.** Handshake (`initialize` and `session/new` each) throws `KiroTimeoutError('handshake')`. A prompt timeout sends `session/cancel`, ends the turn with `stopReason: 'timeout'` and kills the process if the agent ignores the cancel. `cancel()` throws `KiroTimeoutError('cancel')` after killing the process. `SessionRequest.timeoutMs` is a hard session limit. Defaults: handshake 30 s (the spike measured about 7 s for `initialize`), prompt 600 s, cancel 10 s, all configurable.
- **Permission policy.** No policy rejects every request. With a policy: `read`, `search`, `think` allowed; `edit`, `delete`, `move` only when every location (normalised, absolute) is under `allowWritesUnder`; `execute` only when `allowCommands`; any other kind (including `fetch`) rejected. Only `allow_once` is ever selected. If the agent offers no matching option the reply is `cancelled`. Every decision becomes a `permission_request` event.
- **No client capabilities advertised.** `fs/*` and `terminal/*` requests from the agent get JSON-RPC `-32601`.
- **`_kiro/*` and unmapped `session/update` kinds** are accepted and counted (`stats().ignoredNotifications`), not turned into events, because C2 has no event for them.
- **stderr is drained and never stored**, since it can carry secrets.
- Process death mid-prompt ends the turn with `stopReason: 'error'` plus an `adapter_error` (`process_exited`), instead of rejecting `prompt()`.

## 4. Tests executed

All from `C:\Users\user\Desktop\lathe-wt-p401`:

- `pnpm install --no-frozen-lockfile`, then `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm lint` (eslint and `scripts/check-import-boundaries.mjs`)
- `pnpm test`
- `pnpm exec vitest run --project @lathe/kiro-integration`
- `pnpm exec prettier --check integrations`
- **Not run:** `integrations/kiro/scripts/real-smoke.ts` (no login, no `/workspace/app`, not for CI).

## 5. Test results

- Both installs exit 0. `pnpm typecheck` exit 0. `pnpm lint` exit 0 ("no dependency violations found"). Prettier exit 0.
- `pnpm exec vitest run --project @lathe/kiro-integration`: 2 files, **27 passed, 0 failed**.
- `pnpm test` (whole repo): 35 files, **469 passed, 0 failed**, exit 0.
- Lint failed once on first run (`no-this-alias` in `events()`, `no-useless-assignment` in the smoke script). Both fixed in one attempt.

Coverage in the 27 tests: handshake order and `mcpServers: []`; auth_required; handshake timeout for both methods; invalid request not spawned; spawn_failed; env empty by default and allow-listed; event mapping and seq order; prompt wire format; busy; prompt after close; cancel; prompt timeout; timeout with ignored cancel (process killed); `cancel()` timeout; session limit; permission deny without policy; allow and reject cases (outside path, `..`, prefix sibling, execute, fetch, no location); `allow_always` never chosen; malformed JSON, wrong version, unknown response id, bad `tool_call`, foreign session id; unsupported agent request; child exit mid-prompt; idempotent close; two transcript replays.

## 6. Remaining issues

- Real Kiro not exercised. Transcripts are hand-written from `docs/spikes/kiro-acp.md`, not recorded from a live run, so field shapes (for example `kind` and `locations` in permission requests, `rawInput`) are inferred from the ACP spec and need a check against a real run.
- `hostSpawn` runs the CLI on the host. The sandboxed spawn (docker run/exec, hardening) is P4-02. Process kill in a container must also destroy the container (P4-02).
- Open question for `architect`: C2 `SessionRequest.prompt` is unused by the adapter (see section 3).
- No C2 event type for `_kiro/*` notifications, so evidence only gets counts.
- The timeout tests use real timers with 50 ms limits and one 1 s test (session limit, contract minimum). No flakes seen in the runs above, but they are time-based.
- `security` review of this package is required before Done. Review file not written (not my role).

## 7. Dependencies or blockers

New dev dependencies in `integrations/kiro/package.json`: `@types/node` 22.20.5 and `tsx` 4.23.15 (same versions as `verification-harness`; `tsx` runs the smoke script). Runtime: `zod` 4.6.7 and `@lathe/shared-contracts`. No new versions in the lockfile beyond the new importer. Blocked for the real smoke: a Kiro login (human) and P4-02.

## 8. Recommended next task

P4-02 (sandbox runner, with the `SpawnFn` that runs `kiro-cli acp` in the hardened container), then run `real-smoke.ts` inside it and replace the hand-written transcripts with recorded ones.

## 9. Security fix after review (PR #33)
- **Reads confined.** `decidePermission` now checks `read`, `search` and `think` like writes. Reads are allowed only under the target-app and application-foundation mounts (from `sandbox.spec.mounts`, falling back to the policy write roots). `KIRO_SESSION_PATH` (`/home/agent/.kiro`), `/proc`, `/sys`, `/dev` and `/etc` are always denied. A read with no path is denied. `think` with no path stays allowed.
- **rawInput paths checked.** Every path field of `rawInput` (path, file_path, filePath, destination, target, source, from, to, newPath, oldPath, cwd, directory) and every nested string that starts with `/` must pass the same check as `locations`. A relative path in a path field is denied. Paths are normalized first and compared by segment (`/workspace/app2` is not under `/workspace/app`). Applies to execute (cwd only) and think too.
- **Env pinned.** `envAllowlist` accepts only `SecretEnvName` values (`KIRO_API_KEY`); anything else throws `invalid_request` at construction. A name also reaches the child only if `sandbox.spec.secretEnv` declares it.
- **Limits.** `rawInput`/`rawOutput` over 16 KiB become `{ truncated: true }`. At most 10 000 events per session; one error event marks the overflow and only `turn_end` is still recorded.
- **Tests.** New `src/permission-policy.test.ts` (probes from review plus a fast-check property, 500 runs) and 4 new adapter tests. Before the fix: 18 failed. After: all pass. `fast-check` 4.10.3 added as a dev dependency of `integrations/kiro` (same version as the foundation).
- **Dependency on P4-02.** Symlinks are not resolved by the policy. The sandbox must contain no link that leaves the mounts, and the container must not mount `/home/agent/.kiro` into the app tree.
- **Checks run:** `pnpm typecheck` 0, `pnpm lint` 0, `pnpm exec prettier --check integrations docs` 0. `pnpm test` had 2 timeouts (5 s default) in `scripts/import-boundaries` under full-repo load; the same project passes alone (43 passed).
