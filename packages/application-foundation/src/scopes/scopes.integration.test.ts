/**
 * Hierarchical scopes (task P7-01) against real PostgreSQL, as the non-owner app
 * role: the action pipeline, the anti-escalation rules, tenant isolation, and the
 * database constraints that hold even if application code is wrong.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAuth, type Auth } from '../auth/auth.js';
import {
  ActionError,
  defineScopedAction,
  type ActionDeps,
  type ActionResult,
} from '../authz/action.js';
import { defineOrgActions } from '../authz/org-actions.js';
import { defineAuthz } from '../authz/policy.js';
import { defineScopeActions } from '../authz/scope-actions.js';
import { createDb, createPool, deleteTestUsers, expectPgError } from '../db/test-db.js';
import { parseOrgId, type OrgId, type UserId } from '../tenancy/ids.js';
import { withTenant, type TenantTx } from '../tenancy/with-tenant.js';
import { scopeGrants, scopes } from './schema.js';

const BASE_URL = 'http://localhost:3000';
const PASSWORD = `pw-${randomBytes(12).toString('hex')}`;
const RUN = randomUUID().slice(0, 8);

const authz = defineAuthz({
  permissions: [
    'tasks.read',
    'tasks.update',
    'tasks.delete',
    'scopes.manage',
    'scopes.read',
    'members.invite',
    'members.manage',
    'members.leave',
  ],
  roles: {
    owner: [
      'tasks.read',
      'tasks.update',
      'tasks.delete',
      'scopes.manage',
      'scopes.read',
      'members.invite',
      'members.manage',
      'members.leave',
    ],
    lead: ['tasks.read', 'tasks.update', 'scopes.manage', 'scopes.read', 'members.leave'],
    member: ['tasks.read', 'tasks.update', 'scopes.read', 'members.leave'],
    guest: ['scopes.read', 'members.leave'],
  },
});
const org = defineOrgActions(authz, {
  invite: 'members.invite',
  manage: 'members.manage',
  leave: 'members.leave',
});
const scope = defineScopeActions(authz, { manage: 'scopes.manage', read: 'scopes.read' });

/** Counts handler runs, so denial tests can prove the handler never ran. */
let taskRuns = 0;
const ProjectRef = z.strictObject({ projectId: z.uuid() });
const updateTask = defineScopedAction(authz, {
  permission: 'tasks.update',
  resourceType: 'task',
  input: ProjectRef,
  scope: (i) => i.projectId,
  handler: async (ctx) => {
    taskRuns += 1;
    return { chain: ctx.scope?.chain ?? [] };
  },
});
const deleteTask = defineScopedAction(authz, {
  permission: 'tasks.delete',
  resourceType: 'task',
  input: ProjectRef,
  scope: (i) => i.projectId,
  handler: async () => {
    taskRuns += 1;
    return { deleted: true };
  },
});
const failingTask = defineScopedAction(authz, {
  permission: 'tasks.read',
  resourceType: 'task',
  input: ProjectRef,
  scope: (i) => i.projectId,
  handler: async (ctx) => {
    await ctx.tx.insert(scopes).values({ orgId: ctx.orgId, kind: 'team' });
    throw new ActionError('conflict', 'planned failure');
  },
});

let pool: pg.Pool;
let db: NodePgDatabase;
let auth: Auth;
let deps: ActionDeps;
const userIds: string[] = [];

interface Person {
  readonly userId: UserId;
  readonly headers: Headers;
  membershipId: string;
}

async function signUp(label: string): Promise<Person> {
  const email = `${label}-${RUN}@example.test`;
  const created = await auth.api.signUpEmail({ body: { name: label, email, password: PASSWORD } });
  userIds.push(created.user.id);
  const response = await auth.handler(
    new Request(`${BASE_URL}/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE_URL,
        'x-forwarded-for': `10.${randomBytes(3).join('.')}`,
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { userId: created.user.id as UserId, headers: new Headers({ cookie }), membershipId: '' };
}

const req = (p: Person, input: unknown = {}) => ({
  headers: p.headers,
  input,
  requestId: randomUUID(),
});
function ok<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.value;
}
const code = <T>(result: ActionResult<T>): string => (result.ok ? 'ok' : result.code);

async function newOrg(owner: Person, name: string): Promise<OrgId> {
  const created = ok(await org.createOrganization(deps, req(owner, { name })));
  owner.membershipId = created.membershipId;
  ok(await org.setActiveOrg(deps, req(owner, { membershipId: created.membershipId })));
  return created.orgId;
}
async function join(owner: Person, who: Person, role: string): Promise<void> {
  const { token } = ok(await org.inviteMember(deps, req(owner, { role })));
  const { membershipId } = ok(await org.acceptInvitation(deps, req(who, { token })));
  who.membershipId = membershipId;
  ok(await org.setActiveOrg(deps, req(who, { membershipId })));
}
async function auditOf(orgId: string, requestId: string) {
  return withTenant(db, parseOrgId(orgId), async (tx) => {
    const r = await tx.execute<{ outcome: string; resource_id: string | null }>(
      sql`SELECT outcome, resource_id FROM audit_events WHERE request_id = ${requestId}`,
    );
    return r.rows;
  });
}

// Org A: owner, second owner, lead, member, guest. Org B: its own owner.
let owner: Person, owner2: Person, lead: Person, guest: Person, guest2: Person, ownerB: Person;
let orgA: OrgId, orgB: OrgId;
let t1: string, t2: string, p1: string, p2: string, p3: string, tB: string, pB: string;

beforeAll(async () => {
  pool = createPool('app', 5);
  db = createDb(pool);
  auth = createAuth({
    db,
    secret: randomBytes(32).toString('hex'),
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    allowSignUp: true,
  });
  deps = { db, auth };
  [owner, owner2, lead, guest, guest2, ownerB] = (await Promise.all(
    ['owner', 'owner2', 'lead', 'guest', 'guest2', 'owner-b'].map(signUp),
  )) as [Person, Person, Person, Person, Person, Person];
  orgA = await newOrg(owner, `Scopes A ${RUN}`);
  await join(owner, owner2, 'owner');
  await join(owner, lead, 'guest');
  await join(owner, guest, 'guest');
  await join(owner, guest2, 'guest');
  orgB = await newOrg(ownerB, `Scopes B ${RUN}`);

  const make = async (p: Person, input: unknown) =>
    ok(await scope.createScope(deps, req(p, input))).id;
  t1 = await make(owner, { kind: 'team' });
  t2 = await make(owner, { kind: 'team' });
  p1 = await make(owner, { kind: 'project', parentId: t1 });
  p2 = await make(owner, { kind: 'project', parentId: t1 });
  p3 = await make(owner, { kind: 'project', parentId: t2 });
  tB = await make(ownerB, { kind: 'team' });
  pB = await make(ownerB, { kind: 'project', parentId: tB });
});

afterAll(async () => {
  for (const id of [orgA, orgB]) {
    if (id)
      await withTenant(db, id, (tx) => tx.execute(sql`DELETE FROM organizations WHERE id = ${id}`));
  }
  await deleteTestUsers(pool, userIds);
  await pool.end();
});

describe('scoped actions: inheritance, deny wins, no escalation', () => {
  it('without any grant a guest is denied, the handler does not run, and the denial is audited', async () => {
    const before = taskRuns;
    const r = req(guest, { projectId: p1 });
    expect(code(await updateTask(deps, r))).toBe('forbidden');
    expect(taskRuns).toBe(before);
    expect(await auditOf(orgA, r.requestId)).toEqual([{ outcome: 'denied', resource_id: p1 }]);
  });

  it('a team grant reaches every project of the team, not the sibling team', async () => {
    ok(
      await scope.grantScopeRole(
        deps,
        req(owner, { scopeId: t1, membershipId: guest.membershipId, role: 'member' }),
      ),
    );
    expect(ok(await updateTask(deps, req(guest, { projectId: p1 })))).toEqual({ chain: [t1, p1] });
    expect(code(await updateTask(deps, req(guest, { projectId: p2 })))).toBe('ok');
    expect(code(await updateTask(deps, req(guest, { projectId: p3 })))).toBe('forbidden');
  });

  it('an explicit deny on a project wins over the inherited team grant, only on that project', async () => {
    ok(
      await scope.denyScopePermission(
        deps,
        req(owner, { scopeId: p1, membershipId: guest.membershipId, permission: 'tasks.update' }),
      ),
    );
    expect(code(await updateTask(deps, req(guest, { projectId: p1 })))).toBe('forbidden');
    expect(code(await updateTask(deps, req(guest, { projectId: p2 })))).toBe('ok');
    const mine = ok(await scope.myScopePermissions(deps, req(guest, { scopeId: p1 })));
    expect(mine.permissions).not.toContain('tasks.update');
    expect(mine.permissions).toContain('tasks.read');
  });

  it('a deny beats even an org owner, and the owner cannot lift a deny on themselves', async () => {
    expect(code(await deleteTask(deps, req(owner, { projectId: p1 })))).toBe('ok');
    ok(
      await scope.denyScopePermission(
        deps,
        req(owner2, { scopeId: p1, membershipId: owner.membershipId, permission: 'tasks.delete' }),
      ),
    );
    expect(code(await deleteTask(deps, req(owner, { projectId: p1 })))).toBe('forbidden');
    expect(code(await deleteTask(deps, req(owner, { projectId: p2 })))).toBe('ok');
    const lift = await scope.removeScopeDeny(
      deps,
      req(owner, { scopeId: p1, membershipId: owner.membershipId, permission: 'tasks.delete' }),
    );
    expect(code(lift)).toBe('forbidden');
    expect(code(await deleteTask(deps, req(owner, { projectId: p1 })))).toBe('forbidden');
  });

  describe('a team lead', () => {
    beforeAll(async () => {
      ok(
        await scope.grantScopeRole(
          deps,
          req(owner, { scopeId: t1, membershipId: lead.membershipId, role: 'lead' }),
        ),
      );
    });

    it('can grant roles within its own permissions on its team and below', async () => {
      const r = await scope.grantScopeRole(
        deps,
        req(lead, { scopeId: p2, membershipId: guest2.membershipId, role: 'member' }),
      );
      expect(code(r)).toBe('ok');
      expect(code(await updateTask(deps, req(guest2, { projectId: p2 })))).toBe('ok');
      expect(code(await updateTask(deps, req(guest2, { projectId: p1 })))).toBe('forbidden');
    });

    it('cannot grant a role above its own (owner) or manage outside its team', async () => {
      const above = await scope.grantScopeRole(
        deps,
        req(lead, { scopeId: t1, membershipId: guest2.membershipId, role: 'owner' }),
      );
      const outside = await scope.grantScopeRole(
        deps,
        req(lead, { scopeId: t2, membershipId: guest2.membershipId, role: 'member' }),
      );
      const team = await scope.createScope(deps, req(lead, { kind: 'team' }));
      expect([code(above), code(outside), code(team)]).toEqual([
        'forbidden',
        'forbidden',
        'forbidden',
      ]);
      expect(
        code(await scope.createScope(deps, req(lead, { kind: 'project', parentId: t1 }))),
      ).toBe('ok');
    });

    it('cannot deny or grant anything to a member above it, such as the owner', async () => {
      const deny = await scope.denyScopePermission(
        deps,
        req(lead, { scopeId: t1, membershipId: owner.membershipId, permission: 'tasks.read' }),
      );
      const grant = await scope.grantScopeRole(
        deps,
        req(lead, { scopeId: t1, membershipId: owner2.membershipId, role: 'member' }),
      );
      expect([code(deny), code(grant)]).toEqual(['forbidden', 'forbidden']);
    });

    it('cannot change its own rules, nor lift a deny on a permission it does not hold', async () => {
      const self = await scope.grantScopeRole(
        deps,
        req(lead, { scopeId: p1, membershipId: lead.membershipId, role: 'member' }),
      );
      expect(code(self)).toBe('forbidden');
      ok(
        await scope.denyScopePermission(
          deps,
          req(owner, {
            scopeId: p2,
            membershipId: guest2.membershipId,
            permission: 'tasks.delete',
          }),
        ),
      );
      const lift = await scope.removeScopeDeny(
        deps,
        req(lead, { scopeId: p2, membershipId: guest2.membershipId, permission: 'tasks.delete' }),
      );
      expect(code(lift)).toBe('forbidden');
      const liftOwn = await scope.removeScopeDeny(
        deps,
        req(owner, { scopeId: p1, membershipId: guest.membershipId, permission: 'tasks.update' }),
      );
      expect(code(liftOwn)).toBe('ok');
      expect(code(await updateTask(deps, req(guest, { projectId: p1 })))).toBe('ok');
    });
  });

  it('rejects unknown roles and permissions, and a duplicate grant is a conflict', async () => {
    const role = await scope.grantScopeRole(
      deps,
      req(owner, { scopeId: t2, membershipId: guest.membershipId, role: 'admin' }),
    );
    const perm = await scope.denyScopePermission(
      deps,
      req(owner, { scopeId: t2, membershipId: guest.membershipId, permission: 'tasks.purge' }),
    );
    const dup = await scope.grantScopeRole(
      deps,
      req(owner, { scopeId: t1, membershipId: guest.membershipId, role: 'member' }),
    );
    expect([code(role), code(perm), code(dup)]).toEqual([
      'validation_failed',
      'validation_failed',
      'conflict',
    ]);
  });

  it('a handler failure rolls back its writes and is audited as a failure', async () => {
    const count = async () =>
      withTenant(db, orgA, async (tx) => (await tx.select({ id: scopes.id }).from(scopes)).length);
    const before = await count();
    const r = req(owner, { projectId: p1 });
    expect(code(await failingTask(deps, r))).toBe('conflict');
    expect(await count()).toBe(before);
    expect((await auditOf(orgA, r.requestId)).map((e) => e.outcome)).toEqual(['failure']);
  });
});

describe('tenant isolation of scopes', () => {
  it('a scope of another org answers 404, like a scope that does not exist', async () => {
    const foreign = req(ownerB, { projectId: p1 });
    const missing = await updateTask(deps, req(ownerB, { projectId: randomUUID() }));
    const result = await updateTask(deps, foreign);
    expect([code(result), code(missing)]).toEqual(['not_found', 'not_found']);
    if (!result.ok && !missing.ok) expect(result.message).toBe(missing.message);
    expect(await auditOf(orgB, foreign.requestId)).toEqual([
      { outcome: 'denied', resource_id: null },
    ]);
    const read = await scope.listScopeRules(deps, req(ownerB, { scopeId: t1 }));
    expect(code(read)).toBe('not_found');
  });

  it('cannot target a membership of another org, even on its own scope', async () => {
    const r = await scope.grantScopeRole(
      deps,
      req(ownerB, { scopeId: tB, membershipId: guest.membershipId, role: 'member' }),
    );
    expect(code(r)).toBe('not_found');
  });

  it("cannot create a project under another org's team", async () => {
    const r = await scope.createScope(deps, req(ownerB, { kind: 'project', parentId: t1 }));
    expect(code(r)).toBe('not_found');
  });

  it('org b sees none of org a’s scopes or rules', async () => {
    const rows = await withTenant(db, orgB, async (tx) => ({
      scopes: (await tx.select({ id: scopes.id }).from(scopes)).map((s) => s.id).sort(),
      grants: (await tx.select({ id: scopeGrants.id }).from(scopeGrants)).length,
    }));
    expect(rows.scopes).toEqual([tB, pB].sort());
    expect(rows.grants).toBe(0);
  });

  it('no tenant context sees no rows', async () => {
    for (const table of ['scopes', 'scope_grants', 'scope_denies']) {
      const r = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(r.rows[0], table).toEqual({ n: 0 });
    }
  });
});

describe('database constraints (hold even if application code is wrong)', () => {
  const asOrg = <T>(id: OrgId, fn: (tx: TenantTx) => Promise<T>) => withTenant(db, id, fn);

  it("a grant cannot reference another org's scope or membership", async () => {
    expect(
      await expectPgError(() =>
        asOrg(orgB, (tx) =>
          tx.insert(scopeGrants).values({
            orgId: orgB,
            scopeId: t1,
            membershipId: ownerB.membershipId,
            role: 'member',
          }),
        ),
      ),
    ).toBe('23503');
    expect(
      await expectPgError(() =>
        asOrg(orgB, (tx) =>
          tx.insert(scopeGrants).values({
            orgId: orgB,
            scopeId: tB,
            membershipId: guest.membershipId,
            role: 'member',
          }),
        ),
      ),
    ).toBe('23503');
  });

  it("a project's parent must be a team of the same org; teams have no parent", async () => {
    const insert = (values: typeof scopes.$inferInsert) =>
      expectPgError(() => asOrg(orgB, (tx) => tx.insert(scopes).values(values)));
    expect(await insert({ orgId: orgB, kind: 'project', parentId: t1, parentKind: 'team' })).toBe(
      '23503',
    );
    expect(await insert({ orgId: orgB, kind: 'project', parentId: pB, parentKind: 'team' })).toBe(
      '23503',
    );
    expect(await insert({ orgId: orgB, kind: 'team', parentId: tB, parentKind: 'team' })).toBe(
      '23514',
    );
    expect(await insert({ orgId: orgB, kind: 'project' })).toBe('23514');
    expect(await insert({ orgId: orgB, kind: 'folder' as 'team' })).toBe('23514');
  });

  it('RLS refuses a row written for another org', async () => {
    const code42501 = await expectPgError(() =>
      asOrg(orgB, (tx) => tx.insert(scopes).values({ orgId: orgA, kind: 'team' })),
    );
    expect(code42501).toBe('42501');
  });

  it('removing a member removes their scope rules; deleting a team removes its projects', async () => {
    const countFor = (membershipId: string) =>
      asOrg(orgA, async (tx) => {
        const r = await tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM scope_grants WHERE membership_id = ${membershipId}`,
        );
        return r.rows[0]?.n;
      });
    expect(await countFor(guest2.membershipId)).toBeGreaterThan(0);
    ok(await org.removeMember(deps, req(owner, { membershipId: guest2.membershipId })));
    expect(await countFor(guest2.membershipId)).toBe(0);

    await asOrg(orgA, (tx) => tx.execute(sql`DELETE FROM scopes WHERE id = ${t2}`));
    expect(code(await updateTask(deps, req(owner, { projectId: p3 })))).toBe('not_found');
  });
});
