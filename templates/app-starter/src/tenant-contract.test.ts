import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TenantContract } from '@lathe/shared-contracts';
import { describe, expect, it } from 'vitest';
import { authz } from './server/authz';
import { SEED_PRINCIPALS } from './server/seed-data';
import { tenantContract } from './tenant-contract';

const appRoot = fileURLToPath(new URL('..', import.meta.url));

/** `/v1/notes/:id` -> `src/app/v1/notes/[id]/route.ts`. */
function routeFile(path: string): string {
  const segments = path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith(':') ? `[${s.slice(1)}]` : s));
  return `${appRoot}src/app/${segments.join('/')}/route.ts`;
}

describe('tenant contract (C1)', () => {
  it('is a valid C1 contract', () => {
    expect(TenantContract.safeParse(tenantContract).success).toBe(true);
  });

  it('declares exactly the roles and permissions of the app', () => {
    expect(tenantContract.permissions).toEqual([...authz.permissions]);
    for (const role of tenantContract.roles) {
      expect(role.permissions).toEqual([...authz.permissionsOf(role.name)]);
    }
    expect(tenantContract.roles.map((r) => r.name)).toEqual([...authz.roles]);
  });

  it('lists exactly the seeded principals, so the harness can sign in as each', () => {
    expect(tenantContract.principals.map((p) => p.email)).toEqual(
      SEED_PRINCIPALS.map((p) => p.email),
    );
  });

  it('every action and the session routes exist as route files exporting that method', () => {
    const routes = [
      ...tenantContract.actions.map((a) => a.http),
      tenantContract.session.setActiveOrg,
    ];
    for (const { method, path } of routes) {
      const file = routeFile(path);
      expect(existsSync(file), `${method} ${path}`).toBe(true);
      expect(readFileSync(file, 'utf8'), `${method} ${path}`).toMatch(
        new RegExp(`export const ${method} = route\\(`),
      );
    }
    // Sign-in is Better Auth's catch-all route.
    expect(tenantContract.session.signIn.path.startsWith('/auth/')).toBe(true);
    expect(existsSync(`${appRoot}src/app/auth/[...all]/route.ts`)).toBe(true);
  });

  it('every tenant table has its create, read, list, update and delete actions', () => {
    for (const table of tenantContract.tables.filter((t) => t.kind === 'tenant')) {
      const kinds = tenantContract.actions.filter((a) => a.table === table.name).map((a) => a.kind);
      expect([...kinds].sort(), table.name).toEqual(['create', 'delete', 'list', 'read', 'update']);
    }
  });

  it('the seed script it names exists in the app', () => {
    expect(existsSync(`${appRoot}${tenantContract.fixtures.script}`)).toBe(true);
  });

  it('passwordEnv is the variable the seed script reads', () => {
    const seed = readFileSync(`${appRoot}${tenantContract.fixtures.script}`, 'utf8');
    expect(seed).toContain(`source['${tenantContract.passwordEnv}']`);
  });
});
