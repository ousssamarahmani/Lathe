import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TenantContract } from '@lathe/shared-contracts';
import { describe, expect, it } from 'vitest';
import { authz } from './server/authz';
import { SEED_PRINCIPALS } from './server/seed-data';
import { tenantContract, UNDECLARED_ROUTES } from './tenant-contract';

const appRoot = fileURLToPath(new URL('..', import.meta.url));

/** `/v1/tickets/:id` -> `src/app/v1/tickets/[id]/route.ts`. */
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

  it('tickets have create, read, list and update; never delete (tickets are closed)', () => {
    const kinds = tenantContract.actions.filter((a) => a.table === 'tickets').map((a) => a.kind);
    expect([...new Set(kinds)].sort()).toEqual(['create', 'list', 'read', 'update']);
    expect(existsSync(routeFile('/v1/tickets/:id'))).toBe(true);
    expect(readFileSync(routeFile('/v1/tickets/:id'), 'utf8')).not.toMatch(/export const DELETE/);
  });

  it('every ticket route is declared to the harness or listed as undeclared with a reason', () => {
    const declared = new Set(tenantContract.actions.map((a) => `${a.http.method} ${a.http.path}`));
    const undeclared = new Set(UNDECLARED_ROUTES.map((r) => `${r.method} ${r.path}`));
    const ticketsDir = `${appRoot}src/app/v1/tickets`;
    const found: string[] = [];
    for (const entry of readdirSync(ticketsDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || entry.name !== 'route.ts') continue;
      const rel = relative(`${appRoot}src/app`, join(entry.parentPath, entry.name))
        .split(sep)
        .slice(0, -1)
        .map((s) => (s.startsWith('[') ? `:${s.slice(1, -1)}` : s));
      const text = readFileSync(join(entry.parentPath, entry.name), 'utf8');
      for (const m of text.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) =/g)) {
        found.push(`${m[1]} /${rel.join('/')}`);
      }
    }
    expect(found.length).toBeGreaterThan(0);
    for (const r of found) expect(declared.has(r) || undeclared.has(r), r).toBe(true);
    for (const r of undeclared) expect(found, r).toContain(r);
  });
  it('the seed script it names exists in the app', () => {
    expect(existsSync(`${appRoot}${tenantContract.fixtures.script}`)).toBe(true);
  });

  it('passwordEnv is the variable the seed script reads', () => {
    const seed = readFileSync(`${appRoot}${tenantContract.fixtures.script}`, 'utf8');
    expect(seed).toContain(`source['${tenantContract.passwordEnv}']`);
  });
});
