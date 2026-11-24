# ADR 0003: Kiro authentication for automation (D3)

## Status
Proposed decision from spike P0-04, 2026-11-19. Awaiting approval by the project lead (person A). This change invalidates the 2026-11-17 approval of the earlier version of this file (`docs/reviews/P0-03-human.md`).

## Context
Lathe runs Kiro inside an untrusted sandbox with no human at the keyboard. The sandbox may hold only the Kiro credential (`.kiro/steering/security.md`). ADR 0002 chose ACP. The spike tried four modes: A (ACP, API key), B (ACP, login session), C (headless, API key), D (host).

## Options considered
1. **API key (`KIRO_API_KEY`)**, modes A and C. Not available: API keys are created only on Pro, Pro+, Pro Max and Power plans; the team's account is Kiro Free.
2. **Login session in a dedicated Docker volume**, mode B. A one-time device-flow login inside a container; the session lives in a named volume mounted only into agent sandboxes.
3. **Host Kiro with a disposable worktree**, mode D. Rejected: the agent would run with the host user's files, network and credentials.

## Decision (proposed)
Use **mode B** for the Kiroween MVP. Switch to an API key (mode A) if the plan is upgraded; the adapter's interface (C2) does not depend on which.

## Consequences
- The session is a real credential and every agent in the sandbox can read it. Mitigations: a **dedicated Builder ID account for Lathe runtime**, not a person's own account; the volume is mounted only into agent sandboxes, never into a verifier or the host; egress allow-list (P4-02); revoke with `kiro-cli logout` and deleting the volume.
- Credits are shared with whatever account signs in.
- Contract C2 needs v1.2: a `kiro-session` mount source that may be read-write, and a type for permission requests (spike finding 1).
- A human must sign in again when the session expires.

## Open criterion
Kiro's terms of use and rate limits must permit automated use. **Not confirmed** for the Free plan. The lead checks before agents run unattended or the demo is recorded. If not permitted: a paid plan with an API key (mode A).

## Verification
`docs/spikes/kiro-acp.md`: handshake, prompt that wrote a file, and cancellation, all inside the hardened container. P4-01 and P4-02 re-check with the production image and the egress allow-list.
