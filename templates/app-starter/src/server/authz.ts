import { defineAuthz, OWNER_ROLE } from '@lathe/application-foundation';

/**
 * This app's permissions and roles. Extension point: add a permission per new
 * action, then grant it to roles. A role can only grant declared permissions.
 */
export const authz = defineAuthz({
  permissions: [
    'notes.read',
    'notes.list',
    'notes.create',
    'notes.update',
    'notes.delete',
    'members.read',
    'members.invite',
    'members.manage',
    'members.leave',
  ],
  roles: {
    // Only the owner manages members, so no role can remove or demote an owner.
    [OWNER_ROLE]: [
      'notes.read',
      'notes.list',
      'notes.create',
      'notes.update',
      'notes.delete',
      'members.read',
      'members.invite',
      'members.manage',
      'members.leave',
    ],
    member: [
      'notes.read',
      'notes.list',
      'notes.create',
      'notes.update',
      'notes.delete',
      'members.read',
      'members.leave',
    ],
    viewer: ['notes.read', 'notes.list', 'members.read', 'members.leave'],
  },
});

export type AppPermission = (typeof authz.permissions)[number];
export type AppRole = (typeof authz.roles)[number];
