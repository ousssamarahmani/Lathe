import { describe, expect, it } from 'vitest';
import { TenantContract, defineTenantContract, type TenantContractInput } from './index.js';
import { at, clone } from './test-fixtures.js';

const valid = {
  contractVersion: 1,
  app: 'support-desk',
  permissions: ['tickets.read', 'tickets.update'],
  roles: [
    { name: 'requester', permissions: ['tickets.read'] },
    { name: 'agent', permissions: ['tickets.read', 'tickets.update'] },
  ],
  tables: [
    {
      kind: 'tenant',
      name: 'tickets',
      orgColumn: 'org_id',
      primaryKey: 'id',
      rls: { enabled: true, forced: true },
    },
    {
      kind: 'tenant',
      name: 'ticket_events',
      orgColumn: 'org_id',
      primaryKey: 'id',
      rls: { enabled: true, forced: true },
    },
    {
      kind: 'organization',
      name: 'organizations',
      primaryKey: 'id',
      rls: { enabled: true, forced: true },
    },
    {
      kind: 'audit',
      name: 'audit_events',
      orgColumn: 'org_id',
      appendOnly: true,
      rls: { enabled: true, forced: true },
    },
  ],
  actions: [
    {
      id: 'tickets.get',
      permission: 'tickets.read',
      kind: 'read',
      table: 'tickets',
      http: { method: 'GET', path: '/api/tickets/:id' },
    },
    {
      id: 'tickets.update',
      permission: 'tickets.update',
      kind: 'update',
      table: 'tickets',
      alsoTouches: ['ticket_events'],
      sample: { title: 'x', priority: 1, open: true } as Record<string, string | number | boolean>,
      markField: 'title' as string | undefined,
      idField: 'ticketId',
      http: { method: 'PATCH', path: '/api/tickets/:id' },
    },
  ],
  session: {
    signIn: { method: 'POST', path: '/auth/sign-in/email' },
    setActiveOrg: { method: 'POST', path: '/api/session/active-org' },
  },
  principals: [
    { key: 'req-a', email: 'req-a@lathe.test', org: 'a', role: 'requester' },
    { key: 'req-b', email: 'req-b@lathe.test', org: 'b', role: 'requester' },
    { key: 'agent-a', email: 'agent-a@lathe.test', org: 'a', role: 'agent' },
    { key: 'agent-b', email: 'agent-b@lathe.test', org: 'b', role: 'agent' },
  ],
  passwordEnv: 'LATHE_TEST_PASSWORD',
  fixtures: { strategy: 'seed-script', script: 'scripts/seed.ts' },
};
type C = typeof valid;
const rejects = (mutate: (c: C) => unknown) => {
  const c = clone(valid);
  const out = mutate(c) ?? c;
  expect(TenantContract.safeParse(out).success).toBe(false);
};

describe('C1 TenantContract (P1-06)', () => {
  it('accepts a valid contract and defineTenantContract returns it', () => {
    expect(TenantContract.safeParse(valid).success).toBe(true);
    expect(defineTenantContract(valid as TenantContractInput).app).toBe('support-desk');
  });
  it('defineTenantContract throws on an invalid contract', () => {
    expect(() =>
      defineTenantContract({ ...valid, permissions: ['*'] } as TenantContractInput),
    ).toThrow();
  });

  it('rejects a role granting an undeclared permission', () =>
    rejects((c) => void at(c.roles, 0).permissions.push('tickets.delete')));
  it('rejects wildcard permissions', () => rejects((c) => void c.permissions.push('*')));
  it('rejects an action on an undeclared table', () =>
    rejects((c) => void (at(c.actions, 0).table = 'secrets')));
  it('rejects alsoTouches naming an undeclared table (Q5)', () =>
    rejects((c) => void (at(c.actions, 1).alsoTouches = ['secrets'])));
  it('rejects duplicate routes', () =>
    rejects((c) => void (at(c.actions, 1).http = { method: 'GET', path: '/api/tickets/:id' })));
  it('rejects unknown keys', () => rejects((c) => ({ ...c, bypassRls: true })));

  it('rejects a tenant table without forced RLS', () =>
    rejects((c) => void (at(c.tables, 0).rls = { enabled: true, forced: false })));
  it('rejects a tenant column other than org_id', () =>
    rejects((c) => ({
      ...c,
      tables: [{ ...at(c.tables, 0), orgColumn: 'tenant' }, ...c.tables.slice(1)],
    })));
  it('rejects a contract with no tenant table', () =>
    rejects((c) => ({ ...c, tables: c.tables.slice(2) })));
  it('rejects an audit table that is not append-only (Q3)', () =>
    rejects((c) => ({
      ...c,
      tables: [...c.tables.slice(0, 3), { ...at(c.tables, 3), appendOnly: false }],
    })));
  it('rejects an organization table under another name (Q3)', () =>
    rejects((c) => ({
      ...c,
      tables: [...c.tables.slice(0, 2), { ...at(c.tables, 2), name: 'orgs' }, at(c.tables, 3)],
    })));

  it('rejects a role with no principal in org b (Q1)', () =>
    rejects((c) => ({ ...c, principals: c.principals.filter((p) => p.key !== 'agent-b') })));
  it('rejects a principal with an undeclared role (Q1)', () =>
    rejects((c) => void (at(c.principals, 0).role = 'admin')));
  it('rejects duplicate principal emails (Q1)', () =>
    rejects((c) => void (at(c.principals, 1).email = 'req-a@lathe.test')));
  it('rejects real-looking email domains for principals (Q1)', () =>
    rejects((c) => void (at(c.principals, 0).email = 'someone@gmail.com')));
  it('rejects a password value where an env var name belongs (Q1)', () => {
    rejects((c) => void (c.passwordEnv = 'hunter2'));
    rejects((c) => void (c.passwordEnv = 'correct horse battery'));
  });
  it('rejects passwordEnv names outside LATHE_TEST_*PASSWORD (review 1)', () => {
    for (const name of [
      'GITHUB_TOKEN',
      'KIRO_API_KEY',
      'ENGINE_DATABASE_URL',
      'BETTER_AUTH_SECRET',
      'LATHE_DB_OWNER_PASSWORD',
      'POSTGRES_SUPERUSER_PASSWORD',
      'LATHE_TEST_TOKEN',
    ])
      rejects((c) => void (c.passwordEnv = name));
    for (const name of ['LATHE_TEST_PASSWORD', 'LATHE_TEST_ORG_A_PASSWORD'])
      expect(TenantContract.safeParse({ ...clone(valid), passwordEnv: name }).success).toBe(true);
  });
  it('rejects unsafe seed script paths (review 2)', () => {
    for (const script of [
      '/etc/seed.ts',
      '\\seed.ts',
      'scripts\\seed.ts',
      'C:/seed.ts',
      'c:seed.ts',
      '../seed.ts',
      'scripts/../../seed.ts',
      '.github/seed.ts',
      'packages/application-foundation/seed.ts',
      'node_modules/x/seed.ts',
      '',
    ])
      rejects((c) => void (c.fixtures.script = script));
  });
  it('accepts an app-relative seed script (review 2)', () =>
    expect(
      TenantContract.safeParse({
        ...clone(valid),
        fixtures: { strategy: 'seed-script', script: 'db/seed.ts' },
      }).success,
    ).toBe(true));
  it('rejects markField that is not a key of sample (review 3)', () => {
    rejects((c) => void (at(c.actions, 1).markField = 'missing'));
    rejects((c) => void delete (at(c.actions, 1) as { sample?: unknown }).sample);
  });
  it('rejects sample values that are not scalars and sample on reads (review 3)', () => {
    rejects((c) => void (at(c.actions, 1).sample = { a: { b: 1 } } as never));
    rejects((c) => void (at(c.actions, 0).sample = { title: 'x' }));
  });
  it('rejects an invalid idField (review 3)', () =>
    rejects((c) => void (at(c.actions, 1).idField = 'a.b')));

  it('requires exactly one organization table (review 4)', () => {
    rejects((c) => ({ ...c, tables: c.tables.filter((t) => t.kind !== 'organization') }));
    rejects((c) => ({ ...c, tables: [...c.tables, at(c.tables, 2)] }));
  });
  it('requires exactly one audit table (review 4)', () => {
    rejects((c) => ({ ...c, tables: c.tables.filter((t) => t.kind !== 'audit') }));
    rejects((c) => ({ ...c, tables: [...c.tables, at(c.tables, 3)] }));
  });
  it('rejects update and delete actions on the audit table (review 5)', () => {
    rejects((c) => void (at(c.actions, 1).table = 'audit_events'));
    rejects((c) => {
      (c.actions as unknown[]).push({
        id: 'audit.delete',
        permission: 'tickets.update',
        kind: 'delete',
        table: 'audit_events',
        http: { method: 'DELETE', path: '/api/audit/:id' },
      });
    });
  });
  it('rejects read, update and delete routes without a :param segment (review 6)', () => {
    rejects((c) => void (at(c.actions, 0).http.path = '/api/tickets'));
    rejects((c) => void (at(c.actions, 1).http.path = '/api/tickets'));
  });
  it('rejects list and create routes ending with a :param segment (review 6)', () => {
    rejects((c) => void Object.assign(at(c.actions, 0), { kind: 'list' }));
    rejects((c) => void Object.assign(at(c.actions, 1), { kind: 'create' }));
  });
  it('accepts a list route and a create route without a trailing param (review 6)', () => {
    const c = clone(valid);
    (c.actions as unknown[]).push(
      {
        id: 'tickets.list',
        permission: 'tickets.read',
        kind: 'list',
        table: 'tickets',
        http: { method: 'GET', path: '/api/tickets' },
      },
      {
        id: 'tickets.create',
        permission: 'tickets.update',
        kind: 'create',
        table: 'tickets',
        http: { method: 'POST', path: '/api/teams/:teamId/tickets' },
      },
    );
    expect(TenantContract.safeParse(c).success).toBe(true);
  });
  it('rejects duplicate principal emails differing only by case (review 7)', () =>
    rejects((c) => void (at(c.principals, 1).email = 'REQ-A@lathe.test')));

  it('rejects a contract without session routes (Q1)', () =>
    rejects((c) => {
      const rest: Record<string, unknown> = { ...c };
      delete rest['session'];
      return rest;
    }));
});
