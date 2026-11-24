import { defineAction, defineOrgActions, memberships, users } from '@lathe/application-foundation';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { authz } from './authz';

/**
 * Org, session and membership actions from the foundation, bound to this app's
 * permissions. Every request body is a strict object: an `orgId` or `userId`
 * field is rejected, never used.
 */
export const orgActions = defineOrgActions(authz, {
  invite: 'members.invite',
  manage: 'members.manage',
  leave: 'members.leave',
});

export interface Member {
  readonly membershipId: string;
  readonly role: string;
  readonly name: string;
  readonly email: string;
  readonly joinedAt: string;
}

export const listMembers = defineAction(authz, {
  permission: 'members.read',
  resourceType: 'membership',
  input: z.strictObject({}),
  handler: async ({ tx, orgId }): Promise<Member[]> => {
    const rows = await tx
      .select({
        membershipId: memberships.id,
        role: memberships.role,
        name: users.name,
        email: users.email,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, orgId))
      .orderBy(asc(memberships.createdAt));
    return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
  },
});
