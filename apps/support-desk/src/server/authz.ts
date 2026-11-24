import { defineAuthz, OWNER_ROLE } from '@lathe/application-foundation';

/**
 * Support Desk roles (task P6-01):
 *   - requester: opens tickets, sees and comments on their own tickets only;
 *   - agent: sees every ticket of the org, triages, assigns, writes internal notes;
 *   - admin: an agent who can also invite people;
 *   - owner: the org's creator (foundation rule: an org always keeps one); the only
 *     role that changes or removes members, so no admin can demote an owner.
 *
 * "Sees every ticket" is a permission (`tickets.read_all`), not a role check: the
 * actions test the permission, and roles only grant it.
 */
const REQUESTER = [
  'tickets.create',
  'tickets.read',
  'tickets.list',
  'tickets.update',
  'comments.create',
  'comments.list',
  'members.leave',
] as const;
const AGENT = [
  ...REQUESTER,
  'tickets.read_all',
  'tickets.triage',
  'tickets.assign',
  'comments.internal',
  'members.read',
] as const;
const ADMIN = [...AGENT, 'members.invite'] as const;

export const authz = defineAuthz({
  permissions: [...ADMIN, 'members.manage'],
  roles: {
    [OWNER_ROLE]: [...ADMIN, 'members.manage'],
    admin: ADMIN,
    agent: AGENT,
    requester: REQUESTER,
  },
});

export type AppPermission = (typeof authz.permissions)[number];
export type AppRole = (typeof authz.roles)[number];

/** Roles whose members may be assigned tickets. Derived from the permission, not a list. */
export const canWorkTickets = (role: string): boolean =>
  authz.permissionsOf(role).includes('tickets.read_all');
