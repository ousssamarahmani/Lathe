# @lathe/application-foundation

Reusable multi-tenant building blocks for apps on Lathe: authentication, organizations and
memberships, role-based authorization, tenant isolation with PostgreSQL row-level security, and
an append-only audit log. It knows nothing about Lathe itself.

Apps import only from the package root (`@lathe/application-foundation`). Never copy foundation
code into an app. `templates/app-starter` shows every extension point below in use; start a new
app with `pnpm new-app <name>`.

## What the foundation guarantees

- **Deny by default.** A route runs only through `defineAction`, which authenticates, re-checks
  the membership in the session's active org, checks the permission, parses the input, runs the
  handler in a tenant transaction and writes an audit event, in that order. Unknown roles and
  permissions deny.
- **Org from the session.** The active org comes from the session after a membership check,
  never from the request. Request schemas are strict, so an `orgId` field is rejected.
- **Tenant isolation.** Tenant tables carry `org_id NOT NULL` and forced RLS. `withTenant` sets
  the org per transaction (`set_config(..., true)`), so pooled connections never keep it. The
  app connects as a role that is not the table owner and has no `BYPASSRLS`.
- **Audit.** Every outcome of an action, including denials, is recorded in `audit_events`, which
  the app role cannot update or delete.

## Extension points

| Extension point | API | In the template |
|---|---|---|
| Roles and permissions | `defineAuthz({ permissions, roles })`. Permissions are `resource.verb`; a role can only grant declared permissions. `can()` and `isWithin()` are the checks. | `src/server/authz.ts` |
| Org-scoped action (route or page data) | `defineAction(authz, { permission, input, resourceType, resourceId?, handler })`. The handler gets `{ tx, orgId, principal, membership, caller }`. Throw `ActionError('not_found' \| 'forbidden' \| 'validation_failed' \| 'conflict', …)` for expected failures. | `src/server/notes.ts` |
| Signed-in action without an org | `defineUserAction({ permission: 'session.read' \| 'session.update', … })`. For choosing an org, accepting an invitation, creating an org. | via `defineOrgActions` |
| Members, invitations, org switching | `defineOrgActions(authz, { invite, manage, leave })` returns `inviteMember`, `changeMemberRole`, `removeMember`, `leaveOrganization`, `getMe`, `setActiveOrg`, `createOrganization`, `acceptInvitation`. Nobody can grant or manage a role with more permissions than their own. | `src/server/members.ts` |
| Tenant table | `tenantTable(name, columns, extra?)` adds `org_id`. Each table also needs a SQL migration with `ENABLE` and `FORCE ROW LEVEL SECURITY` and a policy on `app_current_org_id()`. | `src/server/schema.ts`, `migrations/` |
| Tenant transaction (outside actions) | `withTenant(db, orgId, fn)`; `withUser(db, userId, fn)` for a user's own memberships. Never set the context at session level. | `scripts/seed.ts` (through `seedDemo`) |
| Authentication | `createAuth({ db, secret, baseURL, trustedOrigins, allowSignUp? })` (Better Auth: email and password, database sessions, rate-limited sign-in, CSRF origin checks, telemetry off). Sign-up is closed unless an app opts in. Mount `auth.handler` at `/auth`. | `src/server/deps.ts`, `src/app/auth/[...all]/route.ts` |
| Current user | `getPrincipal(auth, headers)`: the only trusted source of the user id and active org pointer. Usually you do not call it; `defineAction` does. | |
| Migrations | `runMigrations(ownerClient, { appRole, dir? })`: forward-only SQL files in name order, as the owner role. Run the foundation's first, then the app's (prefix app files with the app name). | `scripts/migrate.ts` |
| Demo data | `seedDemo(auth, db, { orgs, users, password })`, with an auth instance that allows sign-up for that process only. The password comes from the environment. | `scripts/seed.ts` |
| Audit write (custom) | `writeAudit(tx, record)` inside the same transaction as the change. `defineAction` already does this. | |

## Not provided

Email delivery, SSO, billing, and hierarchical scopes (org → team → project, task P7-01) are not
in the foundation yet.

## Tests

`pnpm --filter @lathe/application-foundation test:integration` runs the integration tests against
a real PostgreSQL as the non-owner app role (variables in the repository `.env.example`).
