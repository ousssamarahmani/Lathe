import { eq, max, notInArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { withTenant, type OrgId } from '@lathe/application-foundation';
import { runEvents, runs } from '../db/schema.js';
import { RunStateError } from './errors.js';
import { RUN_STATES, TERMINAL_STATES, type RunSnapshot } from './state-machine.js';
import type { EngineCapability } from './capability.js';
import {
  assertValidDecision,
  buildTransitionEvent,
  type RunStore,
  type TransitionDecision,
} from './run-store.js';

const RunRow = z.object({
  id: z.string(),
  state: z.enum(RUN_STATES),
  repairAttempts: z.number().int().min(0).max(3),
});

function toSnapshot(row: unknown): RunSnapshot {
  const parsed = RunRow.safeParse(row);
  if (!parsed.success) {
    throw new RunStateError('invalid_run_state', 'Stored run has an unknown state', {
      cause: parsed.error,
    });
  }
  return {
    runId: parsed.data.id,
    state: parsed.data.state,
    repairAttempts: parsed.data.repairAttempts,
  };
}

/**
 * Postgres RunStore. Each transition is one `withTenant` transaction: lock the
 * run row, decide, update `runs`, append a `run_events` row. The row lock
 * serialises concurrent transitions, so `seq` has no gaps or duplicates.
 */
export class PgRunStore implements RunStore {
  constructor(
    private readonly db: NodePgDatabase,
    private readonly orgId: OrgId,
  ) {}

  async transition(
    runId: string,
    decide: (current: RunSnapshot) => TransitionDecision,
    capability?: EngineCapability,
  ): Promise<RunSnapshot> {
    return withTenant(this.db, this.orgId, async (tx) => {
      const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
      if (!row) throw new RunStateError('run_not_found', 'Run not found');
      const current = toSnapshot(row);
      const decision = decide(current);
      const next = decision.next;
      assertValidDecision(current, next, capability);
      const event = buildTransitionEvent(current, next, decision.reason);
      const [last] = await tx
        .select({ seq: max(runEvents.seq) })
        .from(runEvents)
        .where(eq(runEvents.runId, runId));
      await tx
        .update(runs)
        .set({ state: next.state, repairAttempts: next.repairAttempts, updatedAt: new Date() })
        .where(eq(runs.id, runId));
      await tx.insert(runEvents).values({
        orgId: this.orgId,
        runId,
        seq: (last?.seq ?? -1) + 1,
        type: event.type,
        payload: event.payload,
      });
      return next;
    });
  }

  async listNonTerminal(): Promise<readonly RunSnapshot[]> {
    return withTenant(this.db, this.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(runs)
        .where(notInArray(runs.state, [...TERMINAL_STATES]));
      return rows.map(toSnapshot);
    });
  }
}
