# Landing page claims (P9-01)

Every statement on the landing page and the artifact that proves it. The page text lives in `apps/workspace/src/app/(marketing)/content.ts`; this table must list every claim id there (checked by `landing.test.tsx`). Person A signs off this list before the page is final (Dec 1).

Status values:
- **Built and tested**: merged on `main`, with tests.
- **In review**: code exists in an open pull request, not merged.
- **Planned**: designed in the repository, not built. The page says "Planned".

Not allowed on the page: pricing, invented numbers or metrics, "production ready", deployment claims, screenshots that are not real captures.

| Claim id | Section | Status | Evidence | Sign-off |
|---|---|---|---|---|
| `workflow-loop` | How it works | Planned | `docs/architecture/05-verification-repair-loop.md`, `docs/adr/0002-kiro-integration-via-acp.md` | pending |
| `tenant-isolation` | What exists today | Built and tested | `packages/application-foundation/migrations/0002_tenancy_rls.sql`, `packages/application-foundation/src/tenancy/tenancy.integration.test.ts`, `docs/reports/P1-02-backend.md` | pending |
| `deny-by-default` | What exists today | Built and tested | `packages/application-foundation/src/authz/action.ts`, `src/authz/policy.test.ts`, `src/authz/authz.integration.test.ts`, `docs/reports/P1-05-backend.md` | pending |
| `auth-and-orgs` | What exists today | Built and tested | `packages/application-foundation/src/auth/auth.integration.test.ts`, `src/orgs/orgs.integration.test.ts`, `docs/reports/P1-03-backend.md` | pending |
| `audit-log` | What exists today | Built and tested | `packages/application-foundation/src/audit/audit.ts`, `src/db/schema.integration.test.ts` | pending |
| `verification-harness` | What exists today | In review | PR #5 (P2-01, P2-02). The P2-02 parser fix is still open | pending |
| `kiro-sandbox` | What exists today | Built and tested | `docs/spikes/kiro-acp.md`, `scripts/spikes/kiro-sandbox/docker-run-args.json`, `docs/adr/0003-kiro-authentication-for-automation.md` | pending |
| `arch-foundation` | Architecture | Built and tested | `packages/application-foundation/src/index.ts` | pending |
| `arch-contracts` | Architecture | Built and tested | `packages/shared-contracts/src/api.ts` | pending |
| `arch-harness` | Architecture | In review | PR #5 | pending |
| `arch-engine` | Architecture | Planned | `docs/architecture/02-factory-engine.md` | pending |
| `arch-delivery` | Architecture | Planned | `docs/architecture/06-github-delivery.md` | pending |
| `arch-workspace` | Architecture | In review | `docs/design/design-system.md`, `docs/design/wireframes.md` (P9-00, in review) | pending |
| `kiro-dev-time` | Kiro | Built and tested | `.kiro/agents`, `.kiro/steering`, `.kiro/specs`, `docs/kiro-usage.md` | pending |
| `kiro-runtime` | Kiro | In review | `docs/adr/0002-kiro-integration-via-acp.md`, `docs/spikes/kiro-acp.md` (adapter is P4-01) | pending |

## Notes for the sign-off

- `kiro-sandbox` is marked Built: the spike ran Kiro over ACP in the hardened container and recorded the result. The production sandbox (egress allow-list, pinned image) is P4-02 and is not claimed.
- `kiro-runtime` is In review, not Built: only the spike exists; the adapter that the Engine uses (P4-01) does not.
- `verification-harness` must not move to Built until PR #5 merges with the P2-02 parser fix.

## Sections not on the page yet

| Section (task text) | Why it is missing | When |
|---|---|---|
| Showcase of Support Desk and Team Operations | the apps do not exist | after P6-01 / P7-02, with real screenshots |
| Workspace screenshots | the Workspace screens do not exist | after P9-03 and P9-06 |
| "Watch demo" | no video yet | after P10-04 |
