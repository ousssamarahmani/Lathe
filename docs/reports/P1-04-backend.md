# P1-04 Organizations and memberships (backend)

Person: B. Branch: `task/P1-04-orgs`, based on `task/P1-03-auth` at `0b39b66` (P1-03 is in review). Date: 2026-11-19.

## 1. Objective completed

P1-04, **completed, pending security and architect review**. The orgs module provides: create an organization with its first owner, list the caller's memberships, invite by link, accept, change role, remove a member or leave, and switch the session's active org. The last owner cannot leave, be removed or be demoted, enforced by a database trigger that also holds under concurrent requests. The org is never taken from request input. 21 new integration tests and 12 unit tests; 6 deliberate mutations, each caught.

Scope agreed with person B before starting: the operations are **internal functions**, not HTTP routes. Permission checks (who may invite, change roles, remove) are added when P1-05's `defineAction` wraps them. Each operation already checks that the caller is a member of the org. The foundation knows only the `owner` role; every other role name belongs to each app's role map (P1-05).

## 2. Files created or modified

New, all under `packages/application-foundation/`:
- `src/orgs/orgs.ts`: `createOrganization`, `listMyMemberships`, `createInvitation`, `acceptInvitation`, `changeRole`, `removeMember`, `setActiveOrg`, `OWNER_ROLE`, types `Caller`, `OrgDeps`, `MembershipSummary`.
- `src/orgs/errors.ts`: `OrgError` with codes `not_found`, `conflict`, `last_owner`, `validation_failed`.
- `src/orgs/invite-token.ts`: `newInviteToken`, `hashInviteToken`, `isInviteToken`.
- `src/orgs/schema.ts`: `invitations` (defined with `tenantTable()`).
- `src/orgs/index.ts`.
- `src/orgs/orgs.integration.test.ts` (21 tests), `src/orgs/invite-token.test.ts` (12 tests).
- `migrations/0004_orgs.sql`.

Modified:
- `src/index.ts`: exports the orgs module.
- `src/tenancy/tenancy.integration.test.ts`: imports the package index, so the tenant-table registry checks see `invitations` too.

No new dependency.

## 3. Technical decisions

- **Last owner enforced in the database** by trigger `memberships_keep_owner` (after update of `role`/`org_id` or delete of an owner row). It locks the organization row before counting owners. Two transactions that each demote a different owner then check one after the other, and the second fails. Rejected: a check in TypeScript only (code that bypasses the module could break it, and a count without a lock races); a deferred constraint (same race).
- **Invite tokens**: 32 random bytes, base64url. Only the sha256 is stored, never in logs or audit events. Rejected: storing the token (a database read would expose live invite links).
- **Reading an invitation before membership**: a new policy `invitations_token_read` lets a transaction that set `app.invite_token_hash` read exactly the one invitation with that hash, and only while unused and unexpired. Accepting then runs in `withTenant` with the org **from that invitation row**, locks the row (`FOR UPDATE`) and re-checks it, so two parallel accepts cannot both win. Rejected: a `SECURITY DEFINER` function (owner rights, larger blast radius), and putting the org id in the link (client-supplied org).
- **Unknown, used, expired, malformed and foreign** all give `not_found`, indistinguishable. Malformed tokens are rejected without a query.
- **`setActiveOrg(membershipId)`** (C4 v1.1): `withUser` finds the membership through the self-read policy, so only the caller's own memberships match; the session update also requires `sessions.user_id = caller`. The client never sends an org id. A refusal writes a `denied` audit event.
- **Org-less audit rows readable by their actor.** New policy `audit_events_self_read` (`org_id IS NULL AND actor_id = app_current_user_id()`). Needed to verify that a denied org switch was audited; it also lets a user see their own denials. Never other users' events, never tenant events.
- **Removing a member clears that org from their sessions** in the same transaction. `defineAction` (P1-05) must still re-check the membership on every request; this only avoids a stale pointer.
- **Every change writes an audit event in the same transaction**: `organization.create`, `invitation.create`, `invitation.accept`, `membership.change_role`, `membership.remove`, `membership.leave`, `session.set_active_org`.
- **Role names** follow C1's `RoleName` format, enforced by `CHECK` constraints on `memberships.role` and `invitations.role` as well as in code.
- **Injected randomness**: `OrgDeps.newId` and `OrgDeps.newToken` (engineering standards).

## 4. Tests executed

Windows, Node v24.14.0, pnpm 9.15.9, Docker 26.0.0, `postgres:16` (local, port 5433).

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm format:check
# mutations: database ones applied with psql as superuser, code ones by editing src/orgs/orgs.ts;
# each followed by
#   pnpm --filter @lathe/application-foundation exec vitest run --config vitest.integration.config.ts src/orgs
# and restored afterwards
```

## 5. Test results

| Command | Result | Exit |
|---|---|---|
| `pnpm typecheck` | all packages `Done` | 0 |
| `pnpm lint` | clean | 0 |
| `pnpm test` | `Test Files 10 passed (10)`, `Tests 87 passed (87)` | 0 |
| `pnpm test:integration` | `migrations applied: 0004_orgs.sql` on first run; `Test Files 4 passed (4)`, `Tests 93 passed (93)` | 0 |
| `pnpm format:check` | clean | 0 |

The 21 integration tests, run as the app role: creator becomes owner and the creation is audited; empty name rejected; a user lists only their own orgs; invite and accept gives the invited role, is audited, and the same link fails a second time; only the hash is stored and the token is not in the audit log; expired, unknown, changed and malformed tokens rejected; an existing member gets `conflict` and the invitation stays usable; of two parallel accepts exactly one wins; invitations are invisible from another org and a non-member cannot create one; bad role and bad lifetime rejected; role change audited; the last owner cannot be demoted, removed or leave; an owner can leave after handing over; two owners demoting each other in parallel leave exactly one owner; removing a member clears their session's active org and is audited; memberships of another org cannot be changed or removed; a non-member cannot act with a real membership id; `setActiveOrg` sets the caller's session; someone else's membership id is refused and audited as `denied`; another user's session is refused.

Mutations (each restored afterwards; final state checked: trigger present, owned by `lathe_owner`; token policy back to `token_hash = ... AND accepted_at IS NULL AND expires_at > now()`):

| Mutation | Result |
|---|---|
| trigger `memberships_keep_owner` dropped | 2 failed: last owner, parallel demotion |
| trigger without the organization row lock | 1 failed: parallel demotion (see section 6) |
| token policy and accept step 2 without the used/expired filter and row lock | 2 failed: single use, parallel accept |
| `setActiveOrg` updates any session id | 1 failed: another user's session |
| `removeMember` leaves the session's active org | 1 failed: session cleared on removal |
| caller membership check removed | 2 failed: non-member invite, non-member role change and removal |

## 6. Remaining issues

- **The lock mutation is caught by a race.** Without the lock, two parallel demotions only both succeed if their checks interleave. It was caught in the run above but the test is timing-dependent for that particular bug. The trigger itself is deterministic with the lock (the second transaction waits on the org row).
- **No permission checks yet.** Any member can call every operation. P1-05 must wrap each one with `defineAction` and a permission before any route exposes it. Until then these functions must not be wired to HTTP.
- **Org-less audit rows are readable only by their actor.** An operator view of denied requests without an org needs a separate path later.
- **Invitations cannot be revoked** before they expire. Not in the task; small follow-up if needed.
- **Deleting a user who is the last owner** skips the trigger (no tenant context in that transaction, so the org row is not visible). The org keeps existing without an owner. Only reachable through direct user deletion, which no operation offers.
- Not run on Node 22 locally; CI runs Node 22.

## 7. Dependencies or blockers

- P1-03 must merge first (this branch contains it).
- Reviewers: `security` and `architect`, plus a diff read by person A (security-critical).

## 8. Recommended next task

P1-05 authorization and audit write: `defineAction({ permission, input, handler })` running authenticate (`getPrincipal`) → resolve membership (re-check `activeOrgId`) → `can()` → `withTenant` → handler → audit, with per-app role maps. Wrap the P1-04 operations with it.
