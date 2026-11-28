import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizations, parseOrgId, withTenant, type OrgId } from '@lathe/application-foundation';
import { projects, runEvents, runs, specs } from '../db/schema.js';
import { createPool } from '../db/test-db.js';
import { issueEngineCapability } from './capability.js';
import { PgRunStore } from './pg-run-store.js';
import { resumeRuns, transitionRun } from './run-store.js';

const cap = issueEngineCapability();
let pool: pg.Pool;
let db: NodePgDatabase;
const orgA = parseOrgId(randomUUID());
const orgB = parseOrgId(randomUUID());

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a row');
  return value;
}

async function newRun(org: OrgId, slug: string): Promise<string> {
  return withTenant(db, org, async (tx) => {
    const [p] = await tx
      .insert(projects)
      .values({ orgId: org, name: slug, slug, targetApp: 'support-desk' })
      .returning();
    const [s] = await tx
      .insert(specs)
      .values({
        orgId: org,
        projectId: must(p).id,
        version: 1,
        title: 'KB',
        body: 'Knowledge base',
        contentSha256: 'a'.repeat(64),
        status: 'submitted',
      })
      .returning();
    const [r] = await tx
      .insert(runs)
      .values({ orgId: org, projectId: must(p).id, specId: must(s).id, state: 'DEFINED' })
      .returning();
    return must(r).id;
  });
}

beforeAll(async () => {
  pool = createPool('app', 3);
  db = drizzle({ client: pool });
  for (const [id, n] of [
    [orgA, 'A'],
    [orgB, 'B'],
  ] as const)
    await withTenant(db, id, (tx) =>
      tx.insert(organizations).values({ id, name: `P3-02 ${n} ${id.slice(0, 8)}` }),
    );
});

afterAll(async () => {
  // No organization cleanup: runs/projects now reference the org with RESTRICT
  // (append-only evidence must survive deletes, #19), so the org rows are left
  // behind. Test orgs use fresh UUIDs and are removed with the test database.
  await pool.end();
});

describe('PgRunStore', () => {
  it('persists transitions with one run_events row each, and resumes after a "restart"', async () => {
    const runId = await newRun(orgA, 'p-a');
    const store = new PgRunStore(db, orgA);
    for (const to of ['PLANNED', 'BUILDING', 'VERIFYING', 'REPAIRING'] as const)
      await transitionRun(store, runId, to);

    const restarted = new PgRunStore(db, orgA); // fresh object, same database
    const items = await resumeRuns(restarted);
    expect(items.find((i) => i.runId === runId)).toMatchObject({
      state: 'REPAIRING',
      repairAttempts: 1,
      action: 'run_repair',
    });

    const events = await withTenant(db, orgA, (tx) =>
      tx.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(runEvents.seq),
    );
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(events[3]?.payload).toMatchObject({
      from: 'VERIFYING',
      to: 'REPAIRING',
      repairAttempts: 1,
    });
  });

  it('rolls back on an illegal transition and enforces the passing-state capability', async () => {
    const runId = await newRun(orgA, 'p-b');
    const store = new PgRunStore(db, orgA);
    await expect(transitionRun(store, runId, 'VERIFYING')).rejects.toMatchObject({
      code: 'illegal_transition',
    });
    for (const to of ['PLANNED', 'BUILDING', 'VERIFYING'] as const)
      await transitionRun(store, runId, to);
    await expect(transitionRun(store, runId, 'AWAITING_APPROVAL')).rejects.toMatchObject({
      code: 'passing_state_forbidden',
    });
    await transitionRun(store, runId, 'AWAITING_APPROVAL', { capability: cap });
    const events = await withTenant(db, orgA, (tx) =>
      tx.select().from(runEvents).where(eq(runEvents.runId, runId)),
    );
    expect(events).toHaveLength(4);
  });

  it('bounds repairs at 3 and fails the fourth', async () => {
    const runId = await newRun(orgA, 'p-c');
    const store = new PgRunStore(db, orgA);
    for (const to of ['PLANNED', 'BUILDING', 'VERIFYING'] as const)
      await transitionRun(store, runId, to);
    for (let i = 0; i < 3; i++)
      for (const to of ['REPAIRING', 'BUILDING', 'VERIFYING'] as const)
        await transitionRun(store, runId, to);
    await expect(transitionRun(store, runId, 'REPAIRING')).rejects.toMatchObject({
      code: 'repair_limit_exceeded',
    });
  });

  it('a run in another org is not found', async () => {
    const runId = await newRun(orgA, 'p-d');
    await expect(transitionRun(new PgRunStore(db, orgB), runId, 'PLANNED')).rejects.toMatchObject({
      code: 'run_not_found',
    });
  });
});
