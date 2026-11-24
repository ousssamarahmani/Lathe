import { defineAuthz } from '@lathe/application-foundation';

/**
 * Permissions and roles of the operator API (C4 `ROUTES`). Roles never replace
 * permission checks: every route declares a permission and `can()` decides.
 * `session.*` permissions are user permissions of the foundation and are not
 * granted by roles.
 */
export const ENGINE_PERMISSIONS = [
  'overview.read',
  'projects.read',
  'projects.create',
  'specs.read',
  'specs.submit',
  'specs.approve',
  'plans.read',
  'plans.approve',
  'runs.read',
  'runs.create',
  'runs.cancel',
  'evidence.read',
  'verification.read',
  'delivery.read',
  'delivery.approve',
  'agents.read',
] as const;

export type EnginePermission = (typeof ENGINE_PERMISSIONS)[number];

const READ = [
  'overview.read',
  'projects.read',
  'specs.read',
  'plans.read',
  'runs.read',
  'evidence.read',
  'verification.read',
  'delivery.read',
  'agents.read',
] as const satisfies readonly EnginePermission[];

export const engineAuthz = defineAuthz({
  permissions: ENGINE_PERMISSIONS,
  roles: {
    viewer: READ,
    operator: [...READ, 'projects.create', 'specs.submit', 'runs.create', 'runs.cancel'],
    approver: [...READ, 'specs.approve', 'plans.approve', 'delivery.approve'],
    owner: ENGINE_PERMISSIONS,
  },
});
