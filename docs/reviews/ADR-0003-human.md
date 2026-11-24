# Approval: ADR 0003 Kiro authentication for automation (D3)

- **Approver:** Oussama Rahamni (person A, project lead)
- **Date:** 2026-11-22
- **Verdict:** **Approved**: mode B (`kiro-cli acp` in the hardened container, signed in with its own Kiro login session in a dedicated volume)
- **Approved content:** `docs/adr/0003-kiro-authentication-for-automation.md`, git blob `0bd8aadd3e05c5754d887c4e2767710175ef20b0`, sha256 `d2214e565fc9626ea47d0980ae77251e940c57d2d767f2964554b99f6217046d`
- **Evidence:** spike P0-04 (`docs/spikes/kiro-acp.md`, PR #8), reviewed by B (`docs/reviews/P0-04-B-review.md`)

## Conditions

1. Runtime uses a dedicated Builder ID account for Lathe, not a person's own account.
2. The session volume is mounted only into agent sandboxes, never into a verifier or the host (enforced by contract C2 v1.2).
3. The spike session (volume `lathe-kiro-p004-home`) is logged out and the volume deleted.

## Not covered by this approval

- **Open criterion:** Kiro's terms of use and rate limits for automated use on the Free plan are not confirmed. Agents must not run unattended, and the demo must not be recorded, until the lead has checked them. If automated use is not permitted, switch to a paid plan with an API key (mode A).
- Any change to the ADR after this date invalidates this approval.

This supersedes the 2026-11-17 approval of the earlier ADR 0003 text in `docs/reviews/P0-03-human.md`.
