import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, memberships, organizations } from '../db/schema.js';
// Registers every tenant table of the package for the registry checks below.
import '../index.js';
import {
  createDb,
  createPool,
  createTestUser,
  deleteTestUsers,
  expectPgError,
} from '../db/test-db.js';
import { parseOrgId, type OrgId, type UserId } from './ids.js';
import { registeredTenantTables } from './tenant-table.js';
import { withTenant, withUser } from './with-tenant.js';

const INSUFFICIENT_PRIVILEGE = '42501';

// One connection, so every test that checks for leaked context reuses the
// connection the previous transaction ran on.
let pool: pg.Pool;
let db: NodePgDatabase;

const orgA = parseOrgId(randomUUID());
const orgB = parseOrgId(randomUUID());
let userX: UserId; // member of A and B
let userY: UserId; // member of A only
let userZ: UserId; // member of nothing; used for inserts that must fail or roll back
const requestId = randomUUID();
let membershipXinA: string;

async function createOrgWithMember(orgId: OrgId, name: string, userId: UserId): Promise<string> {
  return withTenant(db, orgId, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name });
    const [row] = await tx
      .insert(memberships)
      .values({ orgId, userId, role: 'owner' })
      .returning({ id: memberships.id });
    if (!row) throw new Error('membership insert returned no row');
    return row.id;
  });
}

async function currentContext(): Promise<{ org: string | null; user: string | null }> {
  const result = await pool.query<{ org: string | null; user: string | null }>(
    "SELECT current_setting('app.org_id', true) AS org, current_setting('app.user_id', true) AS user",
  );
  const row = result.rows[0];
  if (!row) throw new Error('no row');
  return row;
}

/** Context is cleared if the setting was never set (null) or reset after a transaction (''). */
function expectNoContext(ctx: { org: string | null; user: string | null }): void {
  expect(ctx.org ?? '').toBe('');
  expect(ctx.user ?? '').toBe('');
}

beforeAll(async () => {
  pool = createPool('app', 1);
  db = createDb(pool);
  userX = await createTestUser(pool, 'p1-02-x');
  userY = await createTestUser(pool, 'p1-02-y');
  userZ = await createTestUser(pool, 'p1-02-z');
  membershipXinA = await createOrgWithMember(orgA, 'Org A', userX);
  await createOrgWithMember(orgB, 'Org B', userX);
  await withTenant(db, orgA, (tx) =>
    tx.insert(memberships).values({ orgId: orgA, userId: userY, role: 'member' }),
  );
  await withTenant(db, orgA, (tx) =>
    tx.insert(auditEvents).values({
      orgId: orgA,
      action: 'test.seed',
      resourceType: 'test',
      outcome: 'success',
      requestId,
    }),
  );
});

afterAll(async () => {
  for (const orgId of [orgA, orgB]) {
    await withTenant(db, orgId, (tx) =>
      tx.delete(organizations).where(eq(organizations.id, orgId)),
    );
  }
  await deleteTestUsers(pool, [userX, userY, userZ]);
  await pool?.end();
});

describe('RLS is enabled and forced', () => {
  it('every table defined with tenantTable() has forced RLS and a policy', async () => {
    const registered = registeredTenantTables();
    expect(registered).toContain('memberships');
    const result = await pool.query<{
      table: string;
      enabled: boolean;
      forced: boolean;
      policies: number;
    }>(
      `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
       ORDER BY c.relname`,
      [registered],
    );
    expect(result.rows.map((r) => r.table)).toEqual([...registered]);
    for (const row of result.rows) {
      expect(row, row.table).toMatchObject({ enabled: true, forced: true });
      expect(row.policies, row.table).toBeGreaterThan(0);
    }
  });

  it('every table with a NOT NULL org_id was defined with tenantTable()', async () => {
    const result = await pool.query<{ table: string }>(
      `SELECT table_name AS table FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'org_id' AND is_nullable = 'NO'
       ORDER BY table_name`,
    );
    expect(result.rows.map((r) => r.table)).toEqual([...registeredTenantTables()]);
  });

  it.each(['organizations', 'audit_events'])('%s has forced RLS', async (table) => {
    const result = await pool.query(
      `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class
       WHERE oid = $1::regclass`,
      [table],
    );
    expect(result.rows).toEqual([{ enabled: true, forced: true }]);
  });
});

describe('no tenant context', () => {
  it.each([
    ['memberships', 'SELECT count(*)::int AS n FROM memberships'],
    ['organizations', 'SELECT count(*)::int AS n FROM organizations'],
    ['audit_events', 'SELECT count(*)::int AS n FROM audit_events'],
  ])('%s returns zero rows', async (_table, query) => {
    const result = await pool.query<{ n: number }>(query);
    expect(result.rows).toEqual([{ n: 0 }]);
  });

  it('cannot insert a membership', async () => {
    const code = await expectPgError(() =>
      pool.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')", [
        orgA,
        userZ,
      ]),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('withTenant isolates organizations', () => {
  it('sees only memberships of its own org', async () => {
    const orgs = await withTenant(db, orgA, (tx) =>
      tx.selectDistinct({ orgId: memberships.orgId }).from(memberships),
    );
    expect(orgs).toEqual([{ orgId: orgA }]);
  });

  it('cannot read another org\u2019s membership by id', async () => {
    const rows = await withTenant(db, orgB, (tx) =>
      tx.select().from(memberships).where(eq(memberships.id, membershipXinA)),
    );
    expect(rows).toEqual([]);
  });

  it('cannot see another organization', async () => {
    const rows = await withTenant(db, orgB, (tx) =>
      tx.select({ id: organizations.id }).from(organizations),
    );
    expect(rows).toEqual([{ id: orgB }]);
  });

  it('cannot read another org\u2019s audit events', async () => {
    const rows = await withTenant(db, orgB, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.requestId, requestId)),
    );
    expect(rows).toEqual([]);
  });

  it('cannot update or delete another org\u2019s rows', async () => {
    const updated = await withTenant(db, orgB, (tx) =>
      tx
        .update(memberships)
        .set({ role: 'admin' })
        .where(eq(memberships.id, membershipXinA))
        .returning(),
    );
    const deleted = await withTenant(db, orgB, (tx) =>
      tx.delete(memberships).where(eq(memberships.id, membershipXinA)).returning(),
    );
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    const stillThere = await withTenant(db, orgA, (tx) =>
      tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(eq(memberships.id, membershipXinA)),
    );
    expect(stillThere).toEqual([{ role: 'owner' }]);
  });

  it('rejects inserting a row with another org\u2019s org_id', async () => {
    const code = await expectPgError(() =>
      withTenant(db, orgB, (tx) =>
        tx.insert(memberships).values({ orgId: orgA, userId: userZ, role: 'x' }),
      ),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('rejects moving a row into another org', async () => {
    const code = await expectPgError(() =>
      withTenant(db, orgA, (tx) =>
        tx.update(memberships).set({ orgId: orgB }).where(eq(memberships.id, membershipXinA)),
      ),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('rejects an audit event for another org', async () => {
    const code = await expectPgError(() =>
      withTenant(db, orgB, (tx) =>
        tx.insert(auditEvents).values({
          orgId: orgA,
          action: 'test.forge',
          resourceType: 'test',
          outcome: 'success',
          requestId,
        }),
      ),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('rejects an org id that is not a UUID before reaching the database', async () => {
    await expect(withTenant(db, "x' OR '1'='1" as OrgId, async () => 1)).rejects.toThrow(
      'org id must be a UUID',
    );
  });
});

describe('context never leaks between transactions', () => {
  it('is cleared after withTenant commits', async () => {
    await withTenant(db, orgA, (tx) => tx.select().from(memberships));
    expectNoContext(await currentContext());
    const result = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM memberships');
    expect(result.rows).toEqual([{ n: 0 }]);
  });

  it('is cleared and the write rolled back when fn throws', async () => {
    const userId = userZ;
    await expect(
      withTenant(db, orgA, async (tx) => {
        await tx.insert(memberships).values({ orgId: orgA, userId, role: 'member' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expectNoContext(await currentContext());
    const rows = await withTenant(db, orgA, (tx) =>
      tx.select().from(memberships).where(eq(memberships.userId, userId)),
    );
    expect(rows).toEqual([]);
  });

  it('keeps concurrent transactions on a shared pool apart', async () => {
    const shared = createPool('app', 3);
    const sharedDb = createDb(shared);
    try {
      const runs = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? orgA : orgB));
      const seen = await Promise.all(
        runs.map((orgId) =>
          withTenant(sharedDb, orgId, async (tx) => {
            const rows = await tx.selectDistinct({ orgId: memberships.orgId }).from(memberships);
            const setting = await tx.execute<{ org: string }>(
              sql`SELECT current_setting('app.org_id') AS org`,
            );
            return {
              expected: orgId,
              rows: rows.map((r) => r.orgId),
              setting: setting.rows[0]?.org,
            };
          }),
        ),
      );
      for (const s of seen) {
        expect(s.rows).toEqual([s.expected]);
        expect(s.setting).toBe(s.expected);
      }
    } finally {
      await shared.end();
    }
  });
});

describe('withUser', () => {
  it('lists the user\u2019s own memberships in every org, and nobody else\u2019s', async () => {
    const rows = await withUser(db, userX, (tx) =>
      tx.select({ orgId: memberships.orgId, userId: memberships.userId }).from(memberships),
    );
    expect(rows.map((r) => r.userId)).toEqual([userX, userX]);
    expect(rows.map((r) => r.orgId).sort()).toEqual([orgA, orgB].sort());
  });

  it('sees only the organizations the user belongs to', async () => {
    const rows = await withUser(db, userY, (tx) =>
      tx.select({ id: organizations.id }).from(organizations),
    );
    expect(rows).toEqual([{ id: orgA }]);
  });

  it('cannot write memberships', async () => {
    const code = await expectPgError(() =>
      withUser(db, userX, (tx) =>
        tx.insert(memberships).values({ orgId: orgA, userId: userX, role: 'admin' }),
      ),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot change the user\u2019s own role', async () => {
    const updated = await withUser(db, userX, (tx) =>
      tx
        .update(memberships)
        .set({ role: 'admin' })
        .where(eq(memberships.userId, userX))
        .returning(),
    );
    expect(updated).toEqual([]);
  });

  it('sees no audit events', async () => {
    const rows = await withUser(db, userX, (tx) => tx.select().from(auditEvents));
    expect(rows).toEqual([]);
  });

  it('is cleared after the transaction', async () => {
    await withUser(db, userX, (tx) => tx.select().from(memberships));
    expectNoContext(await currentContext());
  });

  it('withTenant does not inherit a user context', async () => {
    const setting = await withTenant(db, orgA, (tx) =>
      tx.execute<{ user: string }>(sql`SELECT current_setting('app.user_id', true) AS user`),
    );
    expect(setting.rows[0]?.user ?? '').toBe('');
  });
});
