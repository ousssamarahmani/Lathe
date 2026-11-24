/**
 * Support Desk tenant contract (C1 v1). The verification harness learns about the app
 * only through it.
 *
 * Built from the same `authz` map and seed data the app uses. Two routes are not in the
 * contract because C1 v1 cannot describe them (see `UNDECLARED_ROUTES`): their bodies
 * need fields the suites cannot fill (`sample` is allowed on create and update only).
 * `ticket_comments` is not declared as a tenant table for the same reason: a comment is
 * created under a ticket id, which C1 v1 create actions cannot carry. Its isolation is
 * covered by the app's own integration tests until C1 can express nested resources.
 */
import { defineTenantContract } from '@lathe/shared-contracts';
import { APP_SLUG } from './server/app-slug';
import { authz } from './server/authz';
import { SEED_PRINCIPALS } from './server/seed-data';

const rls = { enabled: true, forced: true } as const;

/** Routes that exist but are not declared, each with the reason. Checked by the contract test. */
export const UNDECLARED_ROUTES = [
  { method: 'POST', path: '/v1/tickets/:id/assign', reason: 'body needs a staff membership id' },
  { method: 'POST', path: '/v1/tickets/:id/comments', reason: 'nested create under a ticket' },
] as const;

export const tenantContract = defineTenantContract({
  contractVersion: 1,
  app: APP_SLUG,
  permissions: [...authz.permissions],
  roles: authz.roles.map((name) => ({ name, permissions: [...authz.permissionsOf(name)] })),
  tables: [
    { kind: 'organization', name: 'organizations', primaryKey: 'id', rls },
    { kind: 'audit', name: 'audit_events', orgColumn: 'org_id', appendOnly: true, rls },
    { kind: 'tenant', name: 'tickets', orgColumn: 'org_id', primaryKey: 'id', rls },
  ],
  actions: [
    {
      id: 'tickets.create',
      permission: 'tickets.create',
      kind: 'create',
      table: 'tickets',
      http: { method: 'POST', path: '/v1/tickets' },
      sample: { title: 'Harness ticket', body: 'Opened by the verification harness.' },
      markField: 'title',
    },
    {
      id: 'tickets.get',
      permission: 'tickets.read',
      kind: 'read',
      table: 'tickets',
      http: { method: 'GET', path: '/v1/tickets/:id' },
    },
    {
      id: 'tickets.list',
      permission: 'tickets.list',
      kind: 'list',
      table: 'tickets',
      http: { method: 'GET', path: '/v1/tickets' },
    },
    {
      id: 'tickets.update',
      permission: 'tickets.update',
      kind: 'update',
      table: 'tickets',
      http: { method: 'PATCH', path: '/v1/tickets/:id' },
      sample: { title: 'Harness ticket (edited)' },
      markField: 'title',
    },
    {
      // Reads the ticket's conversation: same visibility as reading the ticket.
      id: 'tickets.comments',
      permission: 'comments.list',
      kind: 'read',
      table: 'tickets',
      http: { method: 'GET', path: '/v1/tickets/:id/comments' },
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
