import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '../auth/schema.js';
import type { OrgId } from '../tenancy/ids.js';
import {
  acceptInvitation,
  changeRoleInTx,
  createInvitationInTx,
  createOrganization,
  findMembershipInTx,
  listMyMemberships,
  removeMemberInTx,
  setActiveOrg,
  type OrgDeps,
} from '../orgs/orgs.js';
import { ActionError, defineAction, defineUserAction } from './action.js';
import { isWithin, type Authz } from './policy.js';

const MembershipRef = z.strictObject({ membershipId: z.uuid() });
const RoleName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);

function knownRole(authz: Authz, role: string): void {
  if (!authz.hasRole(role)) throw new ActionError('validation_failed', `unknown role ${role}`);
}

/**
 * No escalation: a caller may only grant, change or remove roles whose
 * permissions they hold themselves.
 */
function notAbove(authz: Authz, role: string, callerRole: string): void {
  if (!isWithin(authz, role, callerRole)) {
    throw new ActionError('forbidden', 'cannot manage a role with permissions you do not have');
  }
}

/**
 * The P1-04 operations as actions, with this app's permissions. Request bodies
 * are strict objects: an `orgId` or `userId` field is rejected, never used.
 */
export function defineOrgActions<P extends string>(
  authz: Authz<P>,
  permissions: {
    /** Create invitations. */
    readonly invite: NoInfer<P>;
    /** Change roles and remove other members. */
    readonly manage: NoInfer<P>;
    /** Leave the organization. Grant it to every role that may leave. */
    readonly leave: NoInfer<P>;
  },
  options: Pick<OrgDeps, 'newId' | 'newToken'> = {},
) {
  return {
    inviteMember: defineAction(authz, {
      permission: permissions.invite,
      action: 'invitation.create',
      resourceType: 'invitation',
      input: z.strictObject({
        role: RoleName,
        ttlSeconds: z.number().int().optional(),
      }),
      handler: async (ctx, input) => {
        knownRole(authz, input.role);
        notAbove(authz, input.role, ctx.membership.role);
        return createInvitationInTx(ctx.tx, options, ctx.caller, ctx.orgId, input);
      },
      resourceId: (r) => r.invitationId,
    }),

    changeMemberRole: defineAction(authz, {
      permission: permissions.manage,
      action: 'membership.change_role',
      resourceType: 'membership',
      input: MembershipRef.extend({ role: RoleName }),
      handler: async (ctx, input) => {
        knownRole(authz, input.role);
        const target = await findMembershipInTx(ctx.tx, ctx.orgId, input.membershipId);
        notAbove(authz, target.role, ctx.membership.role);
        notAbove(authz, input.role, ctx.membership.role);
        await changeRoleInTx(ctx.tx, ctx.orgId, input);
        return { membershipId: input.membershipId, role: input.role };
      },
      resourceId: (_r, input) => input.membershipId,
    }),

    removeMember: defineAction(authz, {
      permission: permissions.manage,
      action: 'membership.remove',
      resourceType: 'membership',
      input: MembershipRef,
      handler: async (ctx, input) => {
        const target = await findMembershipInTx(ctx.tx, ctx.orgId, input.membershipId);
        if (target.id === ctx.membership.id) {
          throw new ActionError('validation_failed', 'use leaveOrganization to leave');
        }
        notAbove(authz, target.role, ctx.membership.role);
        await removeMemberInTx(ctx.tx, ctx.orgId, input);
        return { membershipId: input.membershipId };
      },
      resourceId: (_r, input) => input.membershipId,
    }),

    leaveOrganization: defineAction(authz, {
      permission: permissions.leave,
      action: 'membership.leave',
      resourceType: 'membership',
      input: z.strictObject({}),
      handler: async (ctx) => {
        await removeMemberInTx(ctx.tx, ctx.orgId, { membershipId: ctx.membership.id });
        return { membershipId: ctx.membership.id };
      },
      resourceId: (r) => r.membershipId,
    }),

    /** C4 v1.1 `GET /v1/me`. `permissions` are a hint for the UI; every action re-checks. */
    getMe: defineUserAction({
      permission: 'session.read',
      action: 'session.read',
      resourceType: 'session',
      input: z.strictObject({}),
      handler: async (ctx) => {
        const [user] = await ctx.db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, ctx.principal.userId));
        if (!user) throw new ActionError('unauthenticated', 'user not found');
        const memberships = await listMyMemberships({ db: ctx.db }, ctx.caller);
        const active = memberships.find((m) => m.orgId === ctx.principal.activeOrgId);
        return {
          user,
          memberships,
          // A stale pointer (membership since removed) is reported as no active org.
          activeOrgId: (active?.orgId ?? null) as OrgId | null,
          permissions: active ? [...authz.permissionsOf(active.role)] : [],
        };
      },
    }),

    /** C4 v1.1 `POST /v1/session/active-org`. */
    setActiveOrg: defineUserAction({
      permission: 'session.update',
      action: 'session.set_active_org',
      resourceType: 'membership',
      input: MembershipRef,
      handler: (ctx, input) => setActiveOrg({ db: ctx.db }, ctx.caller, input),
    }),

    createOrganization: defineUserAction({
      permission: 'session.update',
      action: 'organization.create',
      resourceType: 'organization',
      input: z.strictObject({ name: z.string().min(1).max(200) }),
      handler: (ctx, input) => createOrganization({ db: ctx.db, ...options }, ctx.caller, input),
    }),

    acceptInvitation: defineUserAction({
      permission: 'session.update',
      action: 'invitation.accept',
      resourceType: 'invitation',
      input: z.strictObject({ token: z.string().max(100) }),
      handler: (ctx, input) => acceptInvitation({ db: ctx.db }, ctx.caller, input.token),
    }),
  };
}
