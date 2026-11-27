# P4-02 Sandbox image, docker args, egress proxy, sandbox runner (kiro-integration)

Branch `task/P4-02-sandbox`, based on `task/P4-01-kiro-adapter` at `3f8bdf8`. Not committed.

## 1. Objective completed
P4-02: completed for the unit-tested parts and the live checks on this machine. `security` review is still required (sandbox change). Not exercised: a real Kiro session inside the sandbox (no login session or API key was mounted).

## 2. Files created or modified
- `integrations/kiro/sandbox-image/Dockerfile`, `egress-proxy.Dockerfile`, `egress-proxy-entrypoint.sh`
- `integrations/kiro/src/sandbox/errors.ts`, `docker-args.ts`, `egress-proxy.ts`, `docker-sandbox.ts`
- `integrations/kiro/src/sandbox/docker-args.test.ts`, `egress-proxy.test.ts`, `docker-sandbox.test.ts`
- `integrations/kiro/scripts/check-sandbox.ts`
- `integrations/kiro/src/index.ts` (exports), `integrations/kiro/package.json` (devDependency `fast-check` 4.10.3, same pin as application-foundation, for the property test; script `check-sandbox`), `pnpm-lock.yaml` (generated)

## 3. Technical decisions
- **Kiro CLI pinned by version and sha256** (3.4.0, zip from `desktop-release.q.us-east-1.amazonaws.com/3.4.0/`, build fails on mismatch). Rejected: the `cli.kiro.dev/install` script used in the spike, because it always installs latest (it installed 3.6.0 in my first build attempt).
- **Base images pinned by index digest** (`debian:bookworm-slim`, `alpine:3.20`), looked up from the Docker Hub registry API.
- **Container idles (`sleep infinity`), Kiro runs via `docker exec -i`**. The adapter's `SpawnFn` is `createDockerSpawn`. The adapter env is not forwarded into the container; the docker client gets only `pickDockerEnv` names. Rejected: `docker run -i ... kiro-cli acp` per session, which would tie the container life to one process and block `collectPatch` after exit.
- **Credential by name only**: `-e KIRO_API_KEY` with the value in the docker client env of the `run` call alone. Rejected: `-e KIRO_API_KEY=value` (visible in `docker inspect` args and process list on the host).
- **Per-sandbox internal network and proxy** (`lathe-net-<id>`, `lathe-proxy-<id>`, tinyproxy, deny by default, CONNECT to 443 only), so each spec's allow-list is its own. The proxy is also attached to `bridge`, so it is the only route out. Rejected: one shared proxy (shared allow-list, longer-lived state). Agent with an empty allow-list and every verifier get `--network none`.
- **HOME is a tmpfs** (`/home/agent`, noexec) with the `kiro-session` volume mounted under it at the fixed C2 path.
- **`collectPatch` runs host-side git** in the mounted worktree (`git add -A`, `diff --cached --binary`, hooks and fsmonitor disabled, empty env). Rejected: running git inside the container (needs git credentials-free but adds attack surface from agent-controlled `.git` config in the same place).
- **Host path validation** rejects `,`, quotes, `=`, `..`, relative paths and anything containing `docker.sock`, so `--mount` values cannot be split.
- Spec validation reuses the C2 `SandboxSpec` schema; failures become `SandboxError('invalid_spec')`.

## 4. Tests executed
All from the worktree root `C:\Users\user\Desktop\lathe-wt-p401`:
- `pnpm install --no-frozen-lockfile` then `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm exec prettier --check integrations`
- `pnpm --filter @lathe/kiro-integration check-sandbox` with both images built from `sandbox-image/` and referenced by their local digest

## 5. Test results
- install: exit 0, frozen install exit 0 ("Already up to date").
- typecheck: exit 0 (first run failed on `exactOptionalPropertyTypes` in my code; fixed).
- lint: exit 0, "no dependency violations found".
- test: 38 files, **505 tests passed**, exit 0. New: 36 tests in 3 files under `src/sandbox/` (one property test, 300 runs, over random specs). The first run failed once: my property test's regex matched `--pids-limit` as `--pid`; test fixed, no product change.
- prettier: "All matched files use Prettier code style!", exit 0.
- **Live check: run, Docker 29.9.2, 10 of 10 PASS**: no host env inside (canary `LATHE_CANARY_SECRET`, `GITHUB_TOKEN`, `ENGINE_DATABASE_URL` absent), not root (uid 10001), root FS read-only, `/tmp` writable and noexec, no docker socket, `packages/verification-harness` and `.github` invisible, blocked host (`example.com`) unreachable via proxy (curl exit 56, http 000), direct internet without proxy unreachable, allowed host (`app.kiro.dev`) reachable via proxy (http 200), container/proxy/network destroyed afterwards.

## 6. Remaining issues
- No real Kiro ACP session was run inside this sandbox (needs a session volume; human action). `initialize` through `docker exec` is untested.
- Images are referenced by the local image digest. Docker 29 (containerd store) accepted `name@sha256:<id>` locally; on other setups a registry push may be needed to get a repo digest. No digests are committed.
- Allow-list lacks AWS sign-in hosts (device-flow login); agents reuse a session and never log in. Telemetry host is on the list as the spike doc lists it; consider dropping it (decision for `security`).
- `check-sandbox` uses curl exit codes and HTTP status, so a proxy 403 or connection failure both count as blocked.
- tinyproxy filter matches the CONNECT host; DNS rebinding is not an issue because the sandbox resolves nothing itself (proxy resolves), but that was not tested separately.
- The sandbox image includes `git` and `curl`; `curl` is used by the live checks only and could be dropped from the runtime layer.
- `collectPatch` was tested with a fake runner, not against a real worktree.
- Leftover local images `lathe/sandbox:p4-02` and `lathe/egress-proxy:p4-02`, and `%TEMP%\p402\k340.zip`.

## 7. Dependencies or blockers
- `security` review required. Needs P4-01 (this branch is based on it). Real-Kiro smoke inside the sandbox needs a human-provided session volume (ADR 0003).

## 8. Recommended next task
P4-03 (worktree and patch handling) or a real-Kiro smoke inside this sandbox once a session volume exists.


## 9. Fix round for PR #34 review (git on the host over an agent-writable tree)

**Finding (blocking):** `collectPatch()` ran `git add -A` with cwd in the agent-writable app dir. An agent could plant `.git/config` with `filter.<x>.clean` plus `* filter=<x>` in `.gitattributes`; git discovered that repo first and ran the filter on the host. `-c core.hooksPath/fsmonitor/pager` do not stop filters.

**Fix** (`integrations/kiro/src/sandbox/git-safe.ts`, exported from `src/index.ts`, used by every git call):
- Explicit `--git-dir=<trusted dir outside the mount>` and `--work-tree=<app dir>`; git never discovers a repo from the agent tree. New required option `DockerSandboxOptions.resolveGitDir(input)`; a git dir inside the work tree (or containing it) is refused. The git dir's root tree must correspond to the app dir (P4-03 worktree code must provide that).
- Env: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL`=empty temp file, `GIT_ATTR_NOSYSTEM=1`, `GIT_CEILING_DIRECTORIES`=temp root, private `GIT_INDEX_FILE` in the temp dir, plus `PATH`/`SystemRoot` only. Flags: `core.attributesFile`=empty file, `core.hooksPath`=empty dir, `core.fsmonitor=false`, `core.pager=cat`, `diff.external=`, `protocol.allow=never`, `--no-ext-diff --no-textconv`. cwd is the temp dir, not the agent dir.
- **Fail closed:** `assertNoGitMetadata` rejects (`SandboxError` code `unsafe_git_metadata`) any `.git`, `.gitattributes` or `.gitmodules` anywhere under the app dir (also trailing dot/space and `GIT~1` aliases; uses `lstat`, does not follow symlinks). Rejected alternative: excluding them from the patch, which would silently change what the agent produced.
- Non-blocking items done: bind sources may not be a filesystem root, the repo root (`repoRoot` option), or contain `packages/verification-harness` or `.github` (`assertSafeBindSource`); `egressAllowlist` must be a subset of `KIRO_EGRESS_HOSTS` before anything starts (the list still contains `telemetry.us-east-1.kiro.dev`; kept because Kiro expects it, review whether to drop it); tinyproxy now listens on its internal-network address (entrypoint resolves the `egress-proxy` alias, fails closed) instead of `0.0.0.0`. The proxy image changed, so its digest must be re-pinned after the next build.
- Note (item 6): the sandbox image installs apt packages without version pins (base image is digest-pinned, Kiro CLI is version and sha256 pinned). Accepted risk for MVP; not changed.

**Tests:** new `src/sandbox/git-safe.test.ts` (real git, real temp dirs): planted `.git` with clean filter does not run and is rejected; nested `.git` file, `.gitattributes` alone, `.gitmodules`, `GIT~1` rejected; a filter in a host global config (`GIT_CONFIG_GLOBAL` set, runner leaking the host env) does not run; git dir inside the tree refused; clean tree yields a patch. Before the fix 7 of 7 failed. After: kiro-integration 93 passed; root `pnpm test` 631 passed, 5 skipped; typecheck, lint, prettier clean. Live `check-sandbox` re-run with Docker (proxy image rebuilt): all 10 checks PASS.
