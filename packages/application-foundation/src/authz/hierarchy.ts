/**
 * Hierarchical scopes (task P7-01): org → team → project, opt-in per app.
 *
 * Pure decision logic. The database part (scopes, grants, denies) is in
 * `src/scopes/`, and `defineScopedAction` wires both into the action pipeline.
 *
 * Rules (`security.md`):
 *   - inheritance flows down: the org role, and any grant on a scope above or at
 *     the target, applies to the target;
 *   - an explicit deny anywhere on the chain wins over every allow, including the
 *     org owner's role;
 *   - nesting never escalates: grants and denies on scopes outside the chain
 *     (siblings, children) have no effect on the target;
 *   - deny by default: unknown role, unknown permission or any error is a denial.
 */
import { can, type Authz } from './policy.js';

export type ScopeKind = 'team' | 'project';

/** A role granted to one membership on one scope, and so on everything below it. */
export interface ScopeGrant {
  readonly scopeId: string;
  readonly role: string;
}

/** A permission explicitly denied to one membership on one scope and everything below it. */
export interface ScopeDeny {
  readonly scopeId: string;
  readonly permission: string;
}

/** Everything the decision needs about one membership and one target. */
export interface ScopeContext {
  /** The membership's org-wide role. */
  readonly orgRole: string;
  /**
   * Scope ids from the top of the chain to the target: `[]` for the org itself,
   * `[team]` for a team, `[team, project]` for a project.
   */
  readonly chain: readonly string[];
  /** The membership's grants. Grants on scopes outside the chain are ignored. */
  readonly grants: readonly ScopeGrant[];
  /** The membership's denies. Denies on scopes outside the chain are ignored. */
  readonly denies: readonly ScopeDeny[];
}

export const MAX_SCOPE_DEPTH = 2;

/**
 * True only when `permission` is declared, not denied anywhere on the chain, and
 * granted by the org role or by a grant on the chain.
 */
export function canInScope(authz: Authz, ctx: ScopeContext, permission: unknown): boolean {
  try {
    if (typeof permission !== 'string' || !authz.permissions.includes(permission)) return false;
    if (ctx.chain.length > MAX_SCOPE_DEPTH) return false;
    const onChain = new Set(ctx.chain);
    if (onChain.size !== ctx.chain.length) return false; // a malformed chain is a denial
    if (ctx.denies.some((d) => d.permission === permission && onChain.has(d.scopeId))) {
      return false;
    }
    if (can(authz, ctx.orgRole, permission)) return true;
    return ctx.grants.some((g) => onChain.has(g.scopeId) && can(authz, g.role, permission));
  } catch {
    // Deliberately a denial, never a grant: security.md, deny by default.
    return false;
  }
}

/** The declared permissions `canInScope` allows, in declaration order. */
export function effectivePermissions<P extends string>(
  authz: Authz<P>,
  ctx: ScopeContext,
): readonly P[] {
  return authz.permissions.filter((p) => canInScope(authz, ctx, p));
}

/**
 * True if granting (or revoking) `role` at the caller's target cannot escalate:
 * the role exists, and every permission it carries is one the caller holds there.
 */
export function mayAssignInScope(authz: Authz, caller: ScopeContext, role: string): boolean {
  if (!authz.hasRole(role)) return false;
  return authz.permissionsOf(role).every((p) => canInScope(authz, caller, p));
}
