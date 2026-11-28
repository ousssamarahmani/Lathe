import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RUN_STATES,
  allowedTransitions,
  type RunSnapshot,
  type TransitionDecision,
} from '../index.js';
import { transitionRun } from './run-store.js';
import { MemoryRunStore } from './memory-run-store.js';

/** Regression for #20 review point 2: the stored event is derived from the transition. */
const run: RunSnapshot = { runId: 'r1', state: 'BUILDING', repairAttempts: 0 };

describe('run event integrity', () => {
  it('a forged event payload from the caller is never stored', async () => {
    const store = new MemoryRunStore([run]);
    await store.transition('r1', (c) => {
      const forged = {
        next: { runId: c.runId, state: 'FAILED', repairAttempts: 0 },
        reason: 'x',
        event: {
          type: 'state_changed',
          payload: { from: 'BUILDING', to: 'DELIVERED', reason: 'all gates passed' },
        },
      };
      return forged as unknown as TransitionDecision;
    });
    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.payload).toEqual({
      from: 'BUILDING',
      to: 'FAILED',
      repairAttempts: 0,
      reason: 'x',
    });
  });

  it('rejects an over-long or non-string reason and writes nothing', async () => {
    for (const reason of ['r'.repeat(201), 42 as unknown as string]) {
      const store = new MemoryRunStore([run]);
      await expect(
        store.transition('r1', (c) => ({
          next: { runId: c.runId, state: 'FAILED', repairAttempts: 0 },
          reason,
        })),
      ).rejects.toMatchObject({ code: 'illegal_transition' });
      expect(store.events).toHaveLength(0);
      expect(store.get('r1')?.state).toBe('BUILDING');
    }
  });

  it('transitionRun events equal the transition', async () => {
    const store = new MemoryRunStore([run]);
    await transitionRun(store, 'r1', 'VERIFYING', { reason: 'built' });
    expect(store.events[0]?.payload).toEqual({
      from: 'BUILDING',
      to: 'VERIFYING',
      repairAttempts: 0,
      reason: 'built',
    });
  });
});

describe('SQL guard edge table matches the TypeScript table', () => {
  it('1001_run_state_guard.sql lists exactly the allowed edges', () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../../migrations/1001_run_state_guard.sql', import.meta.url)),
      'utf8',
    );
    const block = /-- edges:begin([\s\S]*?)-- edges:end/.exec(sql)?.[1] ?? '';
    const sqlEdges = [...block.matchAll(/\('([A-Z_]+)',\s*'([A-Z_]+)'\)/g)]
      .map((m) => `${m[1]}>${m[2]}`)
      .sort();
    const tsEdges = RUN_STATES.flatMap((from) =>
      allowedTransitions(from).map((to) => `${from}>${to}`),
    ).sort();
    expect(tsEdges.length).toBeGreaterThan(0);
    expect(sqlEdges).toEqual(tsEdges);
  });
});
