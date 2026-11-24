# Spike P0-04: Kiro execution modes

Date: 2026-11-19. Kiro CLI 3.4.0 on the host and in the container. Docker Desktop 29.9.2 with WSL2. Account: Kiro Free, signed in with AWS Builder ID.

## Result

**Go, with mode B.** Kiro runs over ACP inside a hardened container, signed in with its own device-flow session.

| Mode | Description | Result |
|---|---|---|
| A | ACP in a container, `KIRO_API_KEY` | **Not available.** API keys are created at app.kiro.dev and only for Pro, Pro+, Pro Max or Power plans (kiro.dev Authentication docs). The account is Kiro Free |
| B | ACP in a container, Kiro login session in a dedicated volume | **Works** (evidence below) |
| C | Headless `kiro-cli chat --no-interactive` in a container, `KIRO_API_KEY` | **Not available**, same reason as A. Not tested with a login session |
| D | Kiro on the host, disposable worktree | Not needed |

## How mode B was run

1. Image `lathe-spike/kiro:p0-04` from `scripts/spikes/kiro-sandbox/Dockerfile`: Debian slim, Kiro CLI from the official install script, user `10001`, no shell login.
2. Hardening on every container: `--user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --read-only`, tmpfs `/tmp`, `--pids-limit 256 --memory 2g --cpus 2`, no Docker socket. Checked inside the container: `CapEff 0`, `NoNewPrivs 1`, root file system read-only, `/var/run/docker.sock` absent.
3. Login once: `kiro-cli login --license free --use-device-flow` in the container, with the volume `lathe-kiro-p004-home` mounted at `/home/lathe`. The human confirmed a one-time code in the browser. Result: `Logged in`, exit 0; `kiro-cli whoami` in a new container: `Logged in with Builder ID`.
4. Handshake with `scripts/spikes/acp-handshake.mjs` (no dependencies). Exact commands: "Re-run from a clean clone" below.

## Re-run from a clean clone

Bash, repository root, Docker running. `H` holds the flags from `scripts/spikes/kiro-sandbox/docker-run-args.json`.

```bash
H="--rm -i --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --read-only \
   --tmpfs /tmp:rw,noexec,nosuid,size=64m --pids-limit 256 --memory 2g --cpus 2"
docker build -t lathe-spike/kiro:p0-04 scripts/spikes/kiro-sandbox
docker run $H -v lathe-kiro-p004-home:/home/lathe lathe-spike/kiro:p0-04 login --license free --use-device-flow
docker run $H -v lathe-kiro-p004-home:/home/lathe lathe-spike/kiro:p0-04 whoami
mkdir -p /tmp/lathe-spike-work
node scripts/spikes/acp-handshake.mjs --out /tmp/lathe-spike-out --cwd /workspace/app \
  --timeout 180000 --cancel-after 5000 -- \
  docker run $H -v lathe-kiro-p004-home:/home/lathe -v /tmp/lathe-spike-work:/workspace/app \
  lathe-spike/kiro:p0-04 acp
cat /tmp/lathe-spike-work/SPIKE_OK.txt   # expected: lathe spike ok
# clean up the credential
docker run $H -v lathe-kiro-p004-home:/home/lathe lathe-spike/kiro:p0-04 logout
docker volume rm lathe-kiro-p004-home
```

Before the login, the same handshake failed at `session/new` with `-32000 Authentication required. Not logged in. Set the KIRO_API_KEY environment variable or run kiro-cli login first`.

## Evidence (client exit 0)

| Step | Result | Time |
|---|---|---|
| `initialize` | protocol version 1; capabilities `loadSession`, image and embedded context in prompts; auth methods `aws-builder-id`, `aws-iam-identity-center` | 7.1 s |
| `session/new` with `cwd: /workspace/app`, `mcpServers: []` | session id returned | 0.9 s |
| `session/prompt` "create SPIKE_OK.txt containing exactly: lathe spike ok" | `stopReason: end_turn`; the file exists in the mounted workdir with exactly `lathe spike ok` | 3.5 s |
| Second long prompt, `session/cancel` after 5 s | `stopReason: cancelled` | 5.0 s |

Notifications during the run: 60 `session/update` (`agent_message_chunk` 6, `tool_call` 3, `tool_call_update` 8, `session_info_update` 39, config and command updates 4). Kiro sent **3 `session/request_permission`** requests for its tool calls; the spike client answered `allow_once`. Kiro also sent `_kiro/*` extension notifications: `memory/syncStatus`, `governance/state`, `mcp/status`, `powers/items_changed`, `tools/didChange`, `sessions/changed`, `steering/documents_changed`, `progressive_context/items_changed`.

## Findings for P4-01 (adapter) and P4-02 (sandbox)

1. **Permission requests must be answered by policy.** Kiro asks before tool calls. The adapter must answer from a fixed policy (for example: writes only under `/workspace/app`), never `allow` everything, and log each decision as evidence. Contract C2 has no type for this yet.
2. **The credential is a mounted session, not an env var.** Kiro refreshes its token, so the session volume must be writable. C2 allows only `KIRO_API_KEY` as a secret and only the target app as read-write; both need a v1.2 change (`kiro-session` mount source).
3. **Extension notifications** (`_kiro/...`) arrive alongside ACP. The adapter must accept and record them, not fail on unknown methods. Memory sync and MCP status deserve a check that nothing outside the session is loaded or uploaded.
4. **Egress was not restricted** in this spike (default Docker network). The P4-02 allow-list starts from the hosts on kiro.dev "Firewalls, proxies and data perimeters": `runtime.us-east-1.kiro.dev`, `q.us-east-1.amazonaws.com`, `prod.us-east-1.auth.desktop.kiro.dev`, `management.us-east-1.kiro.dev`, `telemetry.us-east-1.kiro.dev`, `app.kiro.dev`. Device-flow login also needs the AWS sign-in hosts, only during login.
5. `initialize` takes about 7 s; plan the adapter's start timeout above that.

## Not done

- Egress allow-list and the production image (P4-02).
- Long or multi-file prompts, and resuming with `session/load`.
- Kiro CLI version not pinned: the installer's sha256 is recorded but not checked. P4-02 pins and verifies it.
- Kiro's terms of use and rate limits for automated use on the Free plan: not confirmed (ADR 0003).
- Headless mode with a login session.
