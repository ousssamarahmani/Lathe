import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizations, parseOrgId, withTenant } from '@lathe/application-foundation';
import { projects, runEvents, runs, specs } from '../db/schema.js';
import { createPool } from '../db/test-db.js';
import {
  PgRunStore,
  transitionRun,
  type RunSnapshot,
  type RunState,
  type TransitionDecision,
} from '../index.js';

/**
 * Bug condition exploration for #20 against PgRunStore (Postgres twin).
 * MUST FAIL on unfixed code: the store writes whatever `decide` returns.
 *
 * **Validates: Requirements 1.2, 2.2**
 */
let pool: pg.Pool;
let db: NodePgDatabase;
const org = parseOrgId(randomUUID());

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a row');
  return value;
}

async function newRun(slug: string): Promise<string> {
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

function tamper(state: RunState, repairAttempts: number) {
  return (c: RunSnapshot): TransitionDecision => ({
    next: { runId: c.runId, state, repairAttempts },
  });
}

async function snapshot(runId: string) {
  return withTenant(db, org, async (tx) => {
    const [r] = await tx.select().from(runs).where(eq(runs.id, runId));
    const ev = await tx.select().from(runEvents).where(eq(runEvents.runId, runId));
    return { state: must(r).state, repairAttempts: must(r).repairAttempts, events: ev.length };
  });
}

async function toVerifying(runId: string, store: PgRunStore): Promise<void> {
  for (const to of ['PLANNED', 'BUILDING', 'VERIFYING'] as const)
    await transitionRun(store, runId, to);
}

beforeAll(async () => {
  pool = createPool('app', 3);
  db = drizzle({ client: pool });
  await withTenant(db, org, (tx) =>
    tx.insert(organizations).values({ id: org, name: `F20 ${org.slice(0, 8)}` }),
  );
});

// No org delete: org/user deletes are RESTRICT since #19, and evidence is append-only.
afterAll(async () => {
  await pool.end();
});

describe('PgRunStore re-validates transitions (#20)', () => {
  it('rejects a passing state without capability and writes nothing', async () => {
    const runId = await newRun('f20-a');
    const store = new PgRunStore(db, org);
    await toVerifying(runId, store);
    const before = await snapshot(runId);
    await expect(store.transition(runId, tamper('AWAITING_APPROVAL', 0))).rejects.toMatchObject({
      code: 'passing_state_forbidden',
    });
    expect(await snapshot(runId)).toEqual(before);
  });

  it('rejects an illegal edge to DELIVERED and writes nothing', async () => {
    const runId = await newRun('f20-b');
    const store = new PgRunStore(db, org);
    await toVerifying(runId, store);
    const before = await snapshot(runId);
    await expect(store.transition(runId, tamper('DELIVERED', 0))).rejects.toThrow();
    expect(await snapshot(runId)).toEqual(before);
  });

  it('rejects a repairAttempts reset and writes nothing', async () => {
    const runId = await newRun('f20-c');
    const store = new PgRunStore(db, org);
    await toVerifying(runId, store);
    await transitionRun(store, runId, 'REPAIRING');
    await transitionRun(store, runId, 'BUILDING');
    await transitionRun(store, runId, 'VERIFYING');
    const before = await snapshot(runId);
    expect(before.repairAttempts).toBe(1);
    await expect(store.transition(runId, tamper('REPAIRING', 0))).rejects.toThrow();
    expect(await snapshot(runId)).toEqual(before);
  });
});
