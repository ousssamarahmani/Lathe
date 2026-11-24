# Handoff: backend (B) → architect (A): C1 v2 for hierarchical scopes

- **From:** backend (person B), task P7-01
- **To:** architect (person A), owner of contract C1 (`packages/shared-contracts/src/tenant-contract.ts`)
- **Blocked task:** P7-02 (Team Operations scaffold) and its harness run; P2-06 ("explicit deny wins" property)
- **Deadline:** before P7-02 starts (Nov 26)
- **Status:** requested, not acknowledged

## What is needed

C1 v1 knows only `org_id` (Q4 was deferred to v2 in P1-06). P7-01 adds opt-in scopes org → team →
project to the foundation. The suites need to know, from the contract alone, which actions act on
a scope and how to set up scoped grants and denies for the test principals.

## Why

Without it the tenant isolation and RBAC suites only test org-wide roles. A Team Operations bug
such as "a grant on team 1 also works on team 2" or "a deny on a project is ignored" would pass
every gate.

## What P7-01 implements (the interface to describe)

- Tables (migration `0005_scopes.sql`), all tenant tables with forced RLS:
  - `scopes (id, org_id, kind 'team'|'project', parent_id, parent_kind)`: a team has no parent, a
    project's parent is a team of the same org (composite FK). Fixed depth.
  - `scope_grants (org_id, scope_id, membership_id, role)`: the role's permissions at the scope and below.
  - `scope_denies (org_id, scope_id, membership_id, permission)`: blocks the permission at the scope and below.
- Decision (`canInScope`): a deny anywhere on the chain wins over every allow, including the org
  owner; otherwise allowed by the org role or a grant on the chain; nothing off the chain counts.
- Route wrapper `defineScopedAction(authz, { permission, input, scope: (input) => scopeId | null, … })`.
  A foreign or unknown scope is 404; a denied permission is 403.
- Admin actions from `defineScopeActions(authz, { manage, read })`: `createScope`, `grantScopeRole`,
  `revokeScopeRole`, `denyScopePermission`, `removeScopeDeny`, `listScopeRules`, `myScopePermissions`.

## Proposed C1 v2 additions (suggestion; the shape is yours)

```ts
// On TenantAction: which input field names the scope, if the action is scoped.
scope?: { param: string /* path param or body field, e.g. 'projectId' */; kind: 'team' | 'project' };

// On TenantContract: opt-in, so v1 apps stay valid.
scopes?: {
  /** Routes the harness uses to build the fixture tree and rules. */
  create: HttpRoute;      // body { kind: 'team' } | { kind: 'project', parentId }
  grant: HttpRoute;       // body { scopeId, membershipId, role }
  deny: HttpRoute;        // body { scopeId, membershipId, permission }
};
```

Checks the suites could then run: a grant on team 1 does not work on team 2 or on the org; a project
grant does not reach its team; a deny on a project blocks the action there (even for the owner) and
not on a sibling project; a scope id of org A answers 404 to org B; a member cannot change their own
rules.

## Acknowledgment

_(architect: acknowledge here with the resulting commit or report)_
