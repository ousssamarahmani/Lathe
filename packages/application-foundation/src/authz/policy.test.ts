import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { can, defineAuthz, isWithin, type Authz } from './policy.js';

const notes = defineAuthz({
  permissions: ['notes.read', 'notes.write', 'members.manage'],
  roles: {
    owner: ['notes.read', 'notes.write', 'members.manage'],
    member: ['notes.read', 'notes.write'],
    viewer: ['notes.read'],
    nobody: [],
  },
});

describe('defineAuthz', () => {
  it('rejects a role granting an undeclared permission', () => {
    expect(() =>
      defineAuthz({
        permissions: ['notes.read'],
        // A cast past the type check, as plain JavaScript could do.
        roles: { viewer: ['notes.write' as 'notes.read'] },
      }),
    ).toThrow('undeclared permission notes.write');
  });

  it.each(['*', 'notes.*', 'notes', 'Notes.read', 'notes.read ', '', 'notes..read'])(
    'rejects the permission name %j',
    (p) => {
      expect(() => defineAuthz({ permissions: [p], roles: {} })).toThrow('invalid permission name');
    },
  );

  it('rejects duplicates and user permissions', () => {
    expect(() => defineAuthz({ permissions: ['a.b', 'a.b'], roles: {} })).toThrow('duplicate');
    expect(() => defineAuthz({ permissions: ['session.read'], roles: {} })).toThrow(
      'user permission',
    );
  });

  it.each(['Owner', '', 'a b', 'x'.repeat(41)])('rejects the role name %j', (r) => {
    expect(() => defineAuthz({ permissions: ['a.b'], roles: { [r]: [] } })).toThrow(
      'invalid role name',
    );
  });

  it('returns frozen lists', () => {
    expect(Object.isFrozen(notes.permissions)).toBe(true);
    expect(Object.isFrozen(notes.permissionsOf('owner'))).toBe(true);
  });
});

describe('can', () => {
  it('grants exactly what a role lists', () => {
    expect(can(notes, 'member', 'notes.write')).toBe(true);
    expect(can(notes, 'viewer', 'notes.write')).toBe(false);
    expect(can(notes, 'nobody', 'notes.read')).toBe(false);
  });

  it.each([
    ['ghost', 'notes.read'],
    ['owner', 'notes.delete'],
    ['owner', '*'],
    ['__proto__', 'notes.read'],
    ['constructor', 'notes.read'],
    ['toString', 'notes.read'],
    ['owner', 'constructor'],
    [null, 'notes.read'],
    ['owner', undefined],
    [42, 'notes.read'],
  ])('denies role %j with permission %j', (role, permission) => {
    expect(can(notes, role, permission)).toBe(false);
  });

  it('denies when the policy itself throws', () => {
    const broken: Authz = {
      ...notes,
      permissionsOf: () => {
        throw new Error('boom');
      },
    };
    expect(can(broken, 'owner', 'notes.read')).toBe(false);
  });
});

describe('isWithin', () => {
  it('allows equal or smaller roles and refuses larger or unknown ones', () => {
    expect(isWithin(notes, 'member', 'owner')).toBe(true);
    expect(isWithin(notes, 'member', 'member')).toBe(true);
    expect(isWithin(notes, 'owner', 'member')).toBe(false);
    expect(isWithin(notes, 'ghost', 'owner')).toBe(false);
    expect(isWithin(notes, 'viewer', 'ghost')).toBe(false);
  });
});

// Property tests (testing.md). fast-check prints the seed and the shrunk
// counterexample on failure; add it as an example test above when it happens.
const permissionArb = fc
  .tuple(fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/), fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/))
  .map(([a, b]) => `${a}.${b}`);
const roleArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/);

const policyArb = fc
  .uniqueArray(permissionArb, { minLength: 1, maxLength: 8 })
  .filter((ps) => !ps.includes('session.read') && !ps.includes('session.update'))
  .chain((permissions) =>
    fc
      .dictionary(roleArb, fc.subarray(permissions), { maxKeys: 6 })
      .map((roles) => ({ permissions, roles })),
  );

describe('properties', () => {
  it('never grants without an explicit permission', () => {
    fc.assert(
      fc.property(policyArb, fc.string(), fc.string(), (def, role, permission) => {
        const authz = defineAuthz(def);
        const listed =
          Object.hasOwn(def.roles, role) && (def.roles[role] ?? []).includes(permission);
        return can(authz, role, permission) === listed;
      }),
      { numRuns: 500 },
    );
  });

  it('grants every permission a role lists, and nothing to unknown roles', () => {
    fc.assert(
      fc.property(policyArb, roleArb, (def, unknownRole) => {
        const authz = defineAuthz(def);
        for (const [role, perms] of Object.entries(def.roles)) {
          for (const p of perms) if (!can(authz, role, p)) return false;
        }
        if (Object.hasOwn(def.roles, unknownRole)) return true;
        return def.permissions.every((p) => !can(authz, unknownRole, p));
      }),
      { numRuns: 500 },
    );
  });

  it('isWithin never lets a role with an extra permission through', () => {
    fc.assert(
      fc.property(policyArb, (def) => {
        const authz = defineAuthz(def);
        for (const a of authz.roles) {
          for (const b of authz.roles) {
            const extra = authz.permissionsOf(a).some((p) => !authz.permissionsOf(b).includes(p));
            if (extra && isWithin(authz, a, b)) return false;
          }
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});
