import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import fc from 'fast-check';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizations, parseOrgId, withTenant, type OrgId } from '@lathe/application-foundation';
import { approvals, gateResults, plans, projects, runEvents, runs, specs } from './schema.js';
import { createPool, expectPgError } from './test-db.js';

// Property 8 (preservation): inserts, RLS and direct UPDATE/DELETE refusal on the
// append-only tables behave the same before and after the fix. These tests never
// delete runs/specs/plans/projects (that is the bug condition of Property 1).
// Requirements 3.1, 3.6.

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error('expected a value');
  return x;
}

const SHA = 'b'.repeat(64);
const TABLES = ['run_events', 'gate_results', 'approvals'] as const;
let pool: pg.Pool;
let db: NodePgDatabase;
let userId: string;
const orgA = parseOrgId(randomUUID());
const orgB = parseOrgId(randomUUID());

async function seedRun(orgId: OrgId) {
  const slug = `pres-${randomUUID().slice(0, 8)}`;
  return withTenant(db, orgId, async (tx) => {
    const [p] = await tx
      .insert(projects)
      .values({ orgId, name: slug, slug, targetApp: 'support-desk' })
      .returning();
    const [s] = await tx
      .insert(specs)
      .values({
        orgId,
        projectId: must(p).id,
        version: 1,
        title: 'KB',
        body: 'Knowledge base',
        contentSha256: SHA,
        status: 'submitted',
      })
      .returning();
    const [pl] = await tx
      .insert(plans)
      .values({ orgId, specId: must(s).id, contentSha256: SHA, status: 'approved' })
      .returning();
    const [r] = await tx
      .insert(runs)
      .values({
        orgId,
        projectId: must(p).id,
        specId: must(s).id,
        state: 'DEFINED',
      })
      .returning();
    // A run must be inserted as DEFINED; walk it to VERIFYING along legal edges.
    await tx
      .update(runs)
      .set({ planId: must(pl).id, state: 'PLANNED' })
      .where(eq(runs.id, must(r).id));
    for (const state of ['BUILDING', 'VERIFYING'] as const) {
      await tx
        .update(runs)
        .set({ state })
        .where(eq(runs.id, must(r).id));
    }
    return { planId: must(pl).id, runId: must(r).id };
  });
}

async function count(orgId: OrgId, table: string): Promise<number> {
  return withTenant(db, orgId, async (tx) => {
    const res = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`,
    );
    return must(res.rows[0]).n;
  });
}

type SeededRun = Awaited<ReturnType<typeof seedRun>>;
let runA: SeededRun;
let runB: Awaited<ReturnType<typeof seedRun>>;

beforeAll(async () => {
  pool = createPool('app', 3);
  db = drizzle({ client: pool });
  for (const o of [orgA, orgB]) {
    await withTenant(db, o, (tx) =>
      tx.insert(organizations).values({ id: o, name: `preservation ${o.slice(0, 8)}` }),
    );
  }
  const res = await pool.query<{ id: string }>(
    `INSERT INTO users (name, email) VALUES ('preservation', $1) RETURNING id`,
    [`preservation-${orgA}@example.test`],
  );
  userId = must(res.rows[0]).id;
  runA = await seedRun(orgA);
  runB = await seedRun(orgB);
});

afterAll(async () => {
  // Evidence rows block deleting the orgs and the approver, by design: nothing to clean up.
  await pool.end();
});

const insertEvidence = {
  run_events: (
    tx: Parameters<Parameters<typeof withTenant>[2]>[0],
    orgId: OrgId,
    r: typeof runA,
    n: number,
  ) =>
    tx
      .insert(runEvents)
      .values({ orgId, runId: r.runId, seq: n, type: 'state_changed', payload: { n } }),
  gate_results: (
    tx: Parameters<Parameters<typeof withTenant>[2]>[0],
    orgId: OrgId,
    r: typeof runA,
    n: number,
  ) =>
    tx.insert(gateResults).values({
      orgId,
      runId: r.runId,
      attempt: 0,
      gate: 'tests',
      status: 'passed',
      resultHash: SHA,
      report: { n },
    }),
  approvals: (tx: Parameters<Parameters<typeof withTenant>[2]>[0], orgId: OrgId, r: typeof runA) =>
    tx.insert(approvals).values({
      orgId,
      subjectType: 'plan',
      subjectId: r.planId,
      contentSha256: SHA,
      decision: 'approved',
      approverId: userId,
    }),
};

// gate_results is unique per (run, attempt, gate), so each insert uses a fresh run.
async function addEvidence(table: (typeof TABLES)[number], orgId: OrgId, r: SeededRun, n: number) {
  const run = table === 'gate_results' ? await seedRun(orgId) : r;
  await withTenant(db, orgId, (tx) => insertEvidence[table](tx, orgId, run, n));
}

describe('append-only tables: preserved behavior', () => {
  it('inserts succeed in the own org and RLS hides other orgs (property)', async () => {
    let next = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...TABLES),
        fc.integer({ min: 1, max: 3 }),
        async (table, k) => {
          const beforeA = await count(orgA, table);
          const beforeB = await count(orgB, table);
          for (let i = 0; i < k; i++) {
            const n = ++next;
            await addEvidence(table, orgA, runA, n);
          }
          expect(await count(orgA, table)).toBe(beforeA + k);
          expect(await count(orgB, table)).toBe(beforeB);
        },
      ),
      { numRuns: 20 },
    );
  });

  it.each(TABLES)('%s: cross-org insert is rejected by RLS (42501)', async (table) => {
    const code = await expectPgError(() =>
      withTenant(db, orgA, (tx) => insertEvidence[table](tx, orgB, runB, 9000)),
    );
    expect(code).toBe('42501');
  });

  it.each(TABLES)('%s: rows of another org are invisible', async (table) => {
    await addEvidence(table, orgB, runB, 8000);
    const seen = await withTenant(db, orgA, async (tx) => {
      const res = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${orgB}`,
      );
      return must(res.rows[0]).n;
    });
    expect(seen).toBe(0);
  });

  it('direct UPDATE and DELETE are refused (42501) and rows are unchanged (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...TABLES), fc.boolean(), async (table, isUpdate) => {
        await addEvidence(table, orgA, runA, 7000 + Math.floor(Math.random() * 1e6));
        const before = await count(orgA, table);
        const code = await expectPgError(() =>
          withTenant(db, orgA, (tx) =>
            tx.execute(
              isUpdate
                ? sql`UPDATE ${sql.identifier(table)} SET org_id = org_id`
                : sql`DELETE FROM ${sql.identifier(table)}`,
            ),
          ),
        );
        expect(code).toBe('42501');
        expect(await count(orgA, table)).toBe(before);
      }),
      { numRuns: 20 },
    );
  });
});
