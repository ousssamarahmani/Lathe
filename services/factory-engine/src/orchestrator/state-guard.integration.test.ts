import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizations, parseOrgId, withTenant } from '@lathe/application-foundation';
import { projects, runEvents, runs, specs } from '../db/schema.js';
import { createPool, expectPgError } from '../db/test-db.js';
import { PgRunStore, transitionRun, type TransitionDecision } from '../index.js';

/** Regression for #20 review points 1 and 2 against real Postgres, as the app role. */
let pool: pg.Pool;
let db: NodePgDatabase;
const org = parseOrgId(randomUUID());
const CHECK_VIOLATION = '23514';

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
async function rawUpdate(runId: string, set: ReturnType<typeof sql>): Promise<unknown> {
  return withTenant(db, org, (tx) => tx.execute(sql`UPDATE runs SET ${set} WHERE id = ${runId}`));
}
async function row(runId: string) {
  return withTenant(db, org, async (tx) => {
    const [r] = await tx.select().from(runs).where(eq(runs.id, runId));
    return { state: must(r).state, repairAttempts: must(r).repairAttempts };
  });
}
async function advance(
  runId: string,
  path: readonly ('PLANNED' | 'BUILDING' | 'VERIFYING' | 'REPAIRING')[],
) {
  const store = new PgRunStore(db, org);
  for (const to of path) await transitionRun(store, runId, to);
}

beforeAll(async () => {
  pool = createPool('app', 3);
  db = drizzle({ client: pool });
  await withTenant(db, org, (tx) =>
    tx.insert(organizations).values({ id: org, name: `F20D ${org.slice(0, 8)}` }),
  );
});
afterAll(async () => {
  await pool.end();
});

describe('database guards runs.state (app role, raw UPDATE)', () => {
  it('refuses BUILDING -> DELIVERED', async () => {
    const id = await newRun('g-1');
    await advance(id, ['PLANNED', 'BUILDING']);
    const code = await expectPgError(() => rawUpdate(id, sql`state = 'DELIVERED'`));
    expect(code).toBe(CHECK_VIOLATION);
    expect((await row(id)).state).toBe('BUILDING');
  });

  it('refuses FAILED -> VERIFYING and any change out of a terminal state', async () => {
    const id = await newRun('g-2');
    await advance(id, ['PLANNED']);
    await transitionRun(new PgRunStore(db, org), id, 'FAILED');
    for (const to of ['VERIFYING', 'DEFINED', 'CANCELLED', 'DELIVERED']) {
      const code = await expectPgError(() => rawUpdate(id, sql`state = ${to}`));
      expect(code).toBe(CHECK_VIOLATION);
    }
    expect((await row(id)).state).toBe('FAILED');
  });

  it('refuses resetting or tampering with repair_attempts', async () => {
    const id = await newRun('g-3');
    await advance(id, ['PLANNED', 'BUILDING', 'VERIFYING', 'REPAIRING']);
    expect((await row(id)).repairAttempts).toBe(1);
    expect(await expectPgError(() => rawUpdate(id, sql`repair_attempts = 0`))).toBe(
      CHECK_VIOLATION,
    );
    expect(await expectPgError(() => rawUpdate(id, sql`repair_attempts = 2`))).toBe(
      CHECK_VIOLATION,
    );
    // +1 is only legal on VERIFYING -> REPAIRING; other edges must keep the counter.
    expect(
      await expectPgError(() => rawUpdate(id, sql`state = 'BUILDING', repair_attempts = 2`)),
    ).toBe(CHECK_VIOLATION);
    expect(await row(id)).toEqual({ state: 'REPAIRING', repairAttempts: 1 });
  });

  it('refuses VERIFYING -> REPAIRING without exactly +1', async () => {
    const id = await newRun('g-4');
    await advance(id, ['PLANNED', 'BUILDING', 'VERIFYING']);
    expect(await expectPgError(() => rawUpdate(id, sql`state = 'REPAIRING'`))).toBe(
      CHECK_VIOLATION,
    );
    expect(
      await expectPgError(() => rawUpdate(id, sql`state = 'REPAIRING', repair_attempts = 2`)),
    ).toBe(CHECK_VIOLATION);
  });

  it('refuses changes to immutable columns', async () => {
    const id = await newRun('g-5');
    const other = randomUUID();
    expect(await expectPgError(() => rawUpdate(id, sql`project_id = ${other}`))).not.toBe('');
    expect(await expectPgError(() => rawUpdate(id, sql`org_id = ${other}`))).not.toBe('');
    expect(await expectPgError(() => rawUpdate(id, sql`demo = true`))).toBe(CHECK_VIOLATION);
  });

  it('accepts a legal raw UPDATE along an allowed edge, and a +1 repair', async () => {
    const id = await newRun('g-6');
    await rawUpdate(id, sql`state = 'PLANNED'`);
    await rawUpdate(id, sql`state = 'BUILDING'`);
    await rawUpdate(id, sql`state = 'VERIFYING'`);
    await rawUpdate(id, sql`state = 'REPAIRING', repair_attempts = 1`);
    expect(await row(id)).toEqual({ state: 'REPAIRING', repairAttempts: 1 });
    await rawUpdate(id, sql`state = 'CANCELLED'`);
    expect((await row(id)).state).toBe('CANCELLED');
  });
});

describe('PgRunStore builds the event from the transition', () => {
  it('ignores a forged event payload: BUILDING -> FAILED is stored as BUILDING -> FAILED', async () => {
    const id = await newRun('e-1');
    await advance(id, ['PLANNED', 'BUILDING']);
    const store = new PgRunStore(db, org);
    await store.transition(id, (c) => {
      const forged = {
        next: { runId: c.runId, state: 'FAILED', repairAttempts: 0 },
        reason: 'boom',
        event: {
          type: 'state_changed',
          payload: { from: 'BUILDING', to: 'DELIVERED', reason: 'all gates passed' },
        },
      };
      return forged as unknown as TransitionDecision;
    });
    const events = await withTenant(db, org, (tx) =>
      tx.select().from(runEvents).where(eq(runEvents.runId, id)).orderBy(runEvents.seq),
    );
    expect(events.at(-1)?.payload).toEqual({
      from: 'BUILDING',
      to: 'FAILED',
      repairAttempts: 0,
      reason: 'boom',
    });
  });

  it('rejects an over-long reason and writes nothing', async () => {
    const id = await newRun('e-2');
    const store = new PgRunStore(db, org);
    await expect(
      store.transition(id, (c) => ({
        next: { runId: c.runId, state: 'PLANNED', repairAttempts: 0 },
        reason: 'r'.repeat(201),
      })),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
    expect((await row(id)).state).toBe('DEFINED');
  });
});

describe('database guards the initial run row (app role, raw INSERT)', () => {
  async function ids(slug: string): Promise<{ projectId: string; specId: string }> {
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
          contentSha256: 'b'.repeat(64),
          status: 'submitted',
        })
        .returning();
      return { projectId: must(p).id, specId: must(s).id };
    });
  }
  async function rawInsert(
    slug: string,
    state: string,
    attempts: number,
    withPlan: boolean,
  ): Promise<unknown> {
    const { projectId, specId } = await ids(slug);
    return withTenant(db, org, async (tx) => {
      // A random id is enough: BEFORE INSERT triggers run before FK checks.
      const planId: string | null = withPlan ? randomUUID() : null;
      return tx.execute(
        sql`INSERT INTO runs (org_id, project_id, spec_id, state, repair_attempts, plan_id)
            VALUES (${org}, ${projectId}, ${specId}, ${state}, ${attempts}, ${planId})`,
      );
    });
  }

  it('refuses a run inserted as DELIVERED', async () => {
    expect(await expectPgError(() => rawInsert('i-1', 'DELIVERED', 0, false))).toBe(
      CHECK_VIOLATION,
    );
  });
  it('refuses a run inserted as BUILDING with repair_attempts = 3', async () => {
    expect(await expectPgError(() => rawInsert('i-2', 'BUILDING', 3, false))).toBe(CHECK_VIOLATION);
  });
  it('refuses a DEFINED run that already has a plan_id', async () => {
    expect(await expectPgError(() => rawInsert('i-3', 'DEFINED', 0, true))).toBe(CHECK_VIOLATION);
  });
  it('accepts DEFINED, 0 attempts, no plan', async () => {
    await rawInsert('i-4', 'DEFINED', 0, false);
  });
});
