import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAction, defineUserAction } from './action.js';
import { defineAuthz } from './policy.js';

/*
 * Type-level tests: each `@ts-expect-error` line must fail to typecheck. If one
 * starts compiling (for example, `permission` becomes optional), `pnpm typecheck`
 * fails with "Unused '@ts-expect-error' directive".
 */
const authz = defineAuthz({
  permissions: ['notes.read'],
  roles: { viewer: ['notes.read'] },
});

describe('defineAction types', () => {
  it('requires a declared permission', () => {
    const handler = async () => 1;
    const input = z.strictObject({});

    // @ts-expect-error: an action without a permission does not compile.
    expect(() => defineAction(authz, { input, resourceType: 'note', handler })).toThrow();

    expect(() =>
      // @ts-expect-error: an undeclared permission does not compile.
      defineAction(authz, { permission: 'notes.delete', input, resourceType: 'note', handler }),
    ).toThrow('not declared');

    expect(() =>
      // @ts-expect-error: a role map cannot grant an undeclared permission.
      defineAuthz({ permissions: ['a.b'], roles: { r: ['a.c'] } }),
    ).toThrow('undeclared');

    expect(() =>
      // @ts-expect-error: user actions take only user permissions.
      defineUserAction({ permission: 'notes.read', input, resourceType: 'note', handler }),
    ).toThrow('not a user permission');

    const ok = defineAction(authz, {
      permission: 'notes.read',
      input,
      resourceType: 'note',
      handler,
    });
    expect(ok.permission).toBe('notes.read');
    expect(ok.scope).toBe('org');
  });
});
