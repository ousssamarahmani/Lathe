/**
 * Per-app roles and permissions (task P1-05). Shape follows contract C1:
 * explicit permission names in `resource.verb` form, and roles that may only
 * grant declared permissions.
 */

/** C1 `PermissionName`: `resource.verb`, lower case. Wildcards cannot match. */
const PERMISSION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** C1 `RoleName`. */
const ROLE = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * Permissions every signed-in user has without an active org, because a user
 * must see and choose their orgs before one is active (C4 v1.1
 * `ORG_INDEPENDENT_PERMISSIONS`). Only user actions can use them.
 */
export const USER_PERMISSIONS = ['session.read', 'session.update'] as const;
export type UserPermission = (typeof USER_PERMISSIONS)[number];

export interface Authz<P extends string = string, R extends string = string> {
  readonly permissions: readonly P[];
  readonly roles: readonly R[];
  /** Permissions of `role`. Empty for an unknown role. */
  permissionsOf(role: string): readonly P[];
  /** True if `role` exists in this app's role map. */
  hasRole(role: string): role is R;
}

/**
 * Declares an app's permissions and roles. TypeScript rejects a role that lists
 * an undeclared permission; the same is checked at runtime, with the C1 name
 * rules, so a bad map fails at startup rather than granting anything.
 */
export function defineAuthz<const P extends string, const R extends string>(definition: {
  readonly permissions: readonly P[];
  readonly roles: Readonly<Record<R, readonly NoInfer<P>[]>>;
}): Authz<P, R> {
  const declared = new Set<string>();
  for (const p of definition.permissions) {
    if (!PERMISSION.test(p)) throw new Error(`invalid permission name ${JSON.stringify(p)}`);
    if (declared.has(p)) throw new Error(`duplicate permission ${p}`);
    if ((USER_PERMISSIONS as readonly string[]).includes(p)) {
      throw new Error(`${p} is a user permission and cannot be granted by a role`);
    }
    declared.add(p);
  }

  const byRole = new Map<string, ReadonlySet<P>>();
  for (const [role, perms] of Object.entries(definition.roles) as [string, readonly P[]][]) {
    if (!ROLE.test(role)) throw new Error(`invalid role name ${JSON.stringify(role)}`);
    const set = new Set<P>();
    for (const p of perms) {
      if (!declared.has(p)) throw new Error(`role ${role} grants undeclared permission ${p}`);
      set.add(p);
    }
    byRole.set(role, set);
  }

  const permissions = Object.freeze([...declared]) as readonly P[];
  const roles = Object.freeze([...byRole.keys()]) as readonly R[];
  return Object.freeze({
    permissions,
    roles,
    permissionsOf: (role: string) => Object.freeze([...(byRole.get(role) ?? [])]),
    hasRole: (role: string): role is R => byRole.has(role),
  });
}

/**
 * Deny by default. True only when `role` is a role of `authz` that explicitly
 * lists `permission`. An unknown role, an unknown permission, a non-string, or
 * any error inside the check gives false.
 */
export function can(authz: Authz, role: unknown, permission: unknown): boolean {
  try {
    if (typeof role !== 'string' || typeof permission !== 'string') return false;
    return authz.permissionsOf(role).includes(permission);
  } catch {
    // Deliberately a denial, never a grant: security.md, deny by default.
    return false;
  }
}

/** True if every permission of `role` is also held by `byRole`: assigning it cannot escalate. */
export function isWithin(authz: Authz, role: string, byRole: string): boolean {
  if (!authz.hasRole(role) || !authz.hasRole(byRole)) return false;
  const mine = authz.permissionsOf(byRole);
  return authz.permissionsOf(role).every((p) => mine.includes(p));
}
