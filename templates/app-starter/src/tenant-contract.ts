/**
 * This app's tenant contract (C1 v1). The verification harness learns about the app
 * only through it: tables, actions (routes), roles and the test principals.
 *
 * Built from the same `authz` map and seed data the app uses, so it cannot drift from
 * the code. `defineTenantContract` validates it when this module is imported; the unit
 * test also checks that every action has a route file exporting that method.
 *
 * Extension point: add the actions of every new tenant resource here, with a `sample`
 * body for create and update.
 */
import { defineTenantContract } from '@lathe/shared-contracts';
import { APP_SLUG } from './server/app-slug';
import { authz } from './server/authz';
import { SEED_PRINCIPALS } from './server/seed-data';

const rls = { enabled: true, forced: true } as const;

export const tenantContract = defineTenantContract({
  contractVersion: 1,
  app: APP_SLUG,
  permissions: [...authz.permissions],
  roles: authz.roles.map((name) => ({ name, permissions: [...authz.permissionsOf(name)] })),
  tables: [
    { kind: 'organization', name: 'organizations', primaryKey: 'id', rls },
    { kind: 'audit', name: 'audit_events', orgColumn: 'org_id', appendOnly: true, rls },
    { kind: 'tenant', name: 'notes', orgColumn: 'org_id', primaryKey: 'id', rls },
  ],
  actions: [
    {
      id: 'notes.create',
      permission: 'notes.create',
      kind: 'create',
      table: 'notes',
      http: { method: 'POST', path: '/v1/notes' },
      sample: { title: 'Harness note', body: 'Created by the verification harness.' },
      markField: 'title',
    },
    {
      id: 'notes.get',
      permission: 'notes.read',
      kind: 'read',
      table: 'notes',
      http: { method: 'GET', path: '/v1/notes/:id' },
    },
    {
      id: 'notes.list',
      permission: 'notes.list',
      kind: 'list',
      table: 'notes',
      http: { method: 'GET', path: '/v1/notes' },
    },
    {
      id: 'notes.update',
      permission: 'notes.update',
      kind: 'update',
      table: 'notes',
      http: { method: 'PATCH', path: '/v1/notes/:id' },
      sample: { title: 'Harness note (edited)' },
      markField: 'title',
    },
    {
      id: 'notes.delete',
      permission: 'notes.delete',
      kind: 'delete',
      table: 'notes',
      http: { method: 'DELETE', path: '/v1/notes/:id' },
    },
  ],
  session: {
    signIn: { method: 'POST', path: '/auth/sign-in/email' },
    setActiveOrg: { method: 'POST', path: '/v1/session/active-org' },
  },
  principals: SEED_PRINCIPALS.map((p) => ({
    key: p.key,
    email: p.email,
    org: p.org,
    role: p.role,
  })),
  passwordEnv: 'LATHE_TEST_PASSWORD',
  fixtures: { strategy: 'seed-script', script: 'scripts/seed.ts' },
});
