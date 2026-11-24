import { z } from 'zod';
import { findMembershipInTx } from '../orgs/orgs.js';
import {
  createScopeInTx,
  denyScopePermissionInTx,
  grantScopeRoleInTx,
  listScopeRulesInTx,
  removeScopeDenyInTx,
  revokeScopeRoleInTx,
} from '../scopes/scopes.js';
import { ActionError, defineScopedAction, type ScopedActionContext } from './action.js';
import { canInScope, effectivePermissions, mayAssignInScope } from './hierarchy.js';
import type { Authz } from './policy.js';

const RoleName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const PermissionName = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const Rule = z.strictObject({ scopeId: z.uuid(), membershipId: z.uuid() });

/**
 * Anti-escalation for every rule change, on top of `manage` at the scope:
 *   - nobody changes rules about themselves (no lifting your own deny, no self-grant);
 *   - nobody changes rules about a member whose org role carries a permission the
 *     caller does not hold at that scope (a team lead cannot deny or grant the owner).
 */
async function checkTarget(
  authz: Authz,
  ctx: ScopedActionContext,
  membershipId: string,
): Promise<void> {
  if (membershipId === ctx.membership.id) {
    throw new ActionError('forbidden', 'you cannot change your own scope rules');
  }
  const target = await findMembershipInTx(ctx.tx, ctx.orgId, membershipId);
  if (!mayAssignInScope(authz, ctx.scopeContext, target.role)) {
    throw new ActionError('forbidden', 'cannot manage a member with permissions you do not have');
  }
}

/**
 * Scope administration for an app that opts in to hierarchical scopes (task P7-01),
 * bound to its own permissions. `manage` allows creating scopes and changing grants
 * and denies at a scope and below; `read` allows reading one's own effective
 * permissions at a scope.
 */
export function defineScopeActions<P extends string>(
  authz: Authz<P>,
  permissions: { readonly manage: NoInfer<P>; readonly read: NoInfer<P> },
) {
  const knownPermission = (p: string): void => {
    if (!(authz.permissions as readonly string[]).includes(p)) {
      throw new ActionError('validation_failed', `unknown permission ${p}`);
    }
  };

  return {
    /** A team needs `manage` org-wide; a project needs `manage` on its team. */
    createScope: defineScopedAction(authz, {
      permission: permissions.manage,
      action: 'scope.create',
      resourceType: 'scope',
      input: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('team') }),
        z.strictObject({ kind: z.literal('project'), parentId: z.uuid() }),
      ]),
      scope: (input) => (input.kind === 'project' ? input.parentId : null),
      handler: (ctx, input) =>
        createScopeInTx(ctx.tx, ctx.orgId, {
          kind: input.kind,
          parentId: input.kind === 'project' ? input.parentId : null,
        }),
      resourceId: (r) => r.id,
    }),

    grantScopeRole: defineScopedAction(authz, {
      permission: permissions.manage,
      action: 'scope.grant_role',
      resourceType: 'scope',
      input: Rule.extend({ role: RoleName }),
      scope: (input) => input.scopeId,
      handler: async (ctx, input) => {
        if (!authz.hasRole(input.role)) {
          throw new ActionError('validation_failed', `unknown role ${input.role}`);
        }
        await checkTarget(authz, ctx, input.membershipId);
        if (!mayAssignInScope(authz, ctx.scopeContext, input.role)) {
          throw new ActionError(
            'forbidden',
            'cannot grant a role with permissions you do not have',
          );
        }
        return grantScopeRoleInTx(ctx.tx, ctx.orgId, ctx.principal.userId, input);
      },
    }),

    revokeScopeRole: defineScopedAction(authz, {
      permission: permissions.manage,
      action: 'scope.revoke_role',
      resourceType: 'scope',
      input: Rule.extend({ role: RoleName }),
      scope: (input) => input.scopeId,
      handler: async (ctx, input) => {
        await checkTarget(authz, ctx, input.membershipId);
        if (!mayAssignInScope(authz, ctx.scopeContext, input.role)) {
          throw new ActionError(
            'forbidden',
            'cannot revoke a role with permissions you do not have',
          );
        }
        return revokeScopeRoleInTx(ctx.tx, ctx.orgId, input);
      },
    }),

    denyScopePermission: defineScopedAction(authz, {
      permission: permissions.manage,
      action: 'scope.deny',
      resourceType: 'scope',
      input: Rule.extend({ permission: PermissionName }),
      scope: (input) => input.scopeId,
      handler: async (ctx, input) => {
        knownPermission(input.permission);
        await checkTarget(authz, ctx, input.membershipId);
        return denyScopePermissionInTx(ctx.tx, ctx.orgId, ctx.principal.userId, input);
      },
    }),

    /** Lifting a deny gives a permission back, so the caller must hold it there. */
    removeScopeDeny: defineScopedAction(authz, {
      permission: permissions.manage,
      action: 'scope.remove_deny',
      resourceType: 'scope',
      input: Rule.extend({ permission: PermissionName }),
      scope: (input) => input.scopeId,
      handler: async (ctx, input) => {
        knownPermission(input.permission);
        await checkTarget(authz, ctx, input.membershipId);
        if (!canInScope(authz, ctx.scopeContext, input.permission)) {
          throw new ActionError('forbidden', 'cannot lift a deny on a permission you do not have');
        }
        return removeScopeDenyInTx(ctx.tx, ctx.orgId, input);
      },
    }),

    listScopeRules: defineScopedAction(authz, {
      permission: permissions.manage,
      action: 'scope.read_rules',
      resourceType: 'scope',
      input: z.strictObject({ scopeId: z.uuid() }),
      scope: (input) => input.scopeId,
      handler: (ctx, input) => listScopeRulesInTx(ctx.tx, ctx.orgId, input.scopeId),
    }),

    /** The caller's own effective permissions at a scope: a UI hint, every action re-checks. */
    myScopePermissions: defineScopedAction(authz, {
      permission: permissions.read,
      action: 'scope.read_permissions',
      resourceType: 'scope',
      input: z.strictObject({ scopeId: z.uuid() }),
      scope: (input) => input.scopeId,
      handler: async (ctx) => ({
        scope: ctx.scope,
        permissions: [...effectivePermissions(authz, ctx.scopeContext)],
      }),
    }),
  };
}
