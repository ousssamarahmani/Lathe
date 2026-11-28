import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizations, parseOrgId, withTenant, type OrgId } from '@lathe/application-foundation';
import {
  APPEND_ONLY_TABLES,
  approvals,
  gateResults,
  plans,
  projects,
  runEvents,
  runs,
  specs,
} from './schema.js';
import { createPool, expectPgError } from './test-db.js';

// Property 1 (bug condition): evidence survives deletes. Deleting a parent row
// (runs, specs, plans, projects) as the app role must be refused and must never
// remove run_events, gate_results or approvals rows through ON DELETE CASCADE.
// Requirements 1.1, 2.1.

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error('expected a value');
  return x;
}

const SHA = 'a'.repeat(64);
const REFUSED = ['42501', '23503'];
let pool: pg.Pool;
let db: NodePgDatabase;
let userId: string;
const org = parseOrgId(randomUUID());

type Seed = { projectId: string; specId: string; planId: string; runId: string };

async function seed(orgId: OrgId, slug: string): Promise<Seed> {
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
    await tx.insert(runEvents).values({
      orgId,
      runId: must(r).id,
      seq: 0,
      type: 'state_changed',
      payload: { to: 'VERIFYING' },
    });
    await tx.insert(gateResults).values({
      orgId,
      runId: must(r).id,
      attempt: 0,
      gate: 'tests',
      status: 'passed',
      resultHash: SHA,
      report: {},
    });
    await tx.insert(approvals).values({
      orgId,
      subjectType: 'plan',
      subjectId: must(pl).id,
      contentSha256: SHA,
      decision: 'approved',
      approverId: userId,
    });
    return { projectId: must(p).id, specId: must(s).id, planId: must(pl).id, runId: must(r).id };
  });
}

async function evidenceCounts(orgId: OrgId) {
  return withTenant(db, orgId, async (tx) => {
    const out: Record<string, number> = {};
    for (const t of APPEND_ONLY_TABLES) {
      const res = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)}`,
      );
      out[t] = must(res.rows[0]).n;
    }
    return out;
  });
}

beforeAll(async () => {
  pool = createPool('app', 3);
  db = drizzle({ client: pool });
  await withTenant(db, org, (tx) =>
    tx.insert(organizations).values({ id: org, name: `append-only ${org.slice(0, 8)}` }),
  );
  const res = await pool.query<{ id: string }>(
    `INSERT INTO users (name, email) VALUES ('append-only', $1) RETURNING id`,
    [`append-only-${org}@example.test`],
  );
  userId = must(res.rows[0]).id;
});

afterAll(async () => {
  // Evidence rows block deleting the org and the approver, by design: nothing to clean up.
  await pool.end();
});

describe('append-only evidence survives parent deletes', () => {
  const targets: Array<{
    name: string;
    remove: (tx: Parameters<Parameters<typeof withTenant>[2]>[0], s: Seed) => Promise<unknown>;
  }> = [
    { name: 'runs', remove: (tx, s) => tx.delete(runs).where(eq(runs.id, s.runId)) },
    { name: 'specs', remove: (tx, s) => tx.delete(specs).where(eq(specs.id, s.specId)) },
    { name: 'plans', remove: (tx, s) => tx.delete(plans).where(eq(plans.id, s.planId)) },
    {
      name: 'projects',
      remove: (tx, s) => tx.delete(projects).where(eq(projects.id, s.projectId)),
    },
  ];

  it.each(targets)('DELETE FROM $name is refused and keeps all evidence rows', async (target) => {
    const s = await seed(org, `del-${target.name}-${randomUUID().slice(0, 8)}`);
    const before = await evidenceCounts(org);
    expect(before['run_events']).toBeGreaterThan(0);
    expect(before['gate_results']).toBeGreaterThan(0);
    expect(before['approvals']).toBeGreaterThan(0);

    let code: string | undefined;
    let failure: unknown;
    try {
      code = await expectPgError(() => withTenant(db, org, (tx) => target.remove(tx, s)));
    } catch (error) {
      failure = error;
    }
    const after = await evidenceCounts(org);
    // Assert the evidence first so the counterexample shows lost rows.
    expect(after).toEqual(before);
    if (failure) throw failure;
    expect(REFUSED).toContain(code);
  });

  it('DELETE FROM organizations (own org) is refused and keeps all evidence rows', async () => {
    await seed(org, `del-org-${randomUUID().slice(0, 8)}`);
    const before = await evidenceCounts(org);
    expect(before['run_events']).toBeGreaterThan(0);
    expect(before['gate_results']).toBeGreaterThan(0);
    expect(before['approvals']).toBeGreaterThan(0);

    let code: string | undefined;
    let failure: unknown;
    try {
      code = await expectPgError(() =>
        withTenant(db, org, (tx) => tx.delete(organizations).where(eq(organizations.id, org))),
      );
    } catch (error) {
      failure = error;
    }
    const after = await evidenceCounts(org);
    expect(after).toEqual(before);
    if (failure) throw failure;
    expect(REFUSED).toContain(code);
  });
});
