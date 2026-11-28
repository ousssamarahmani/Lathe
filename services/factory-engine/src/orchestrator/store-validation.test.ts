import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  RUN_STATES,
  nextSnapshot,
  type RunSnapshot,
  type RunState,
  type TransitionDecision,
} from '../index.js';
// MemoryRunStore is not exported from the package index, so it comes from its module.
import { MemoryRunStore } from './memory-run-store.js';

/**
 * Bug condition exploration for #20. Property 2: the store re-validates the
 * snapshot returned by `decide`. MUST FAIL on unfixed code (the store writes
 * whatever `decide` returns).
 *
 * **Validates: Requirements 1.2, 2.2**
 */
const RUN_ID = 'run-1';

const arbState = fc.constantFrom<RunState>(...RUN_STATES);
const arbCurrent = fc.record({
  runId: fc.constant(RUN_ID),
  state: arbState,
  repairAttempts: fc.integer({ min: 0, max: 3 }),
});
const arbNext = fc.record({ state: arbState, repairAttempts: fc.integer({ min: 0, max: 4 }) });

function decision(current: RunSnapshot, next: Pick<RunSnapshot, 'state' | 'repairAttempts'>) {
  const d: TransitionDecision = {
    next: { runId: current.runId, ...next },
  };
  return d;
}

/** What a correct store may write for a caller without the Engine capability. */
function oracle(current: RunSnapshot, to: RunState): RunSnapshot | undefined {
  try {
    return nextSnapshot(current, to);
  } catch {
    return undefined;
  }
}

describe('MemoryRunStore re-validates transitions (#20)', () => {
  it('property: stores only nextSnapshot(current, next.state); otherwise rejects and writes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(arbCurrent, arbNext, async (current, next) => {
        const store = new MemoryRunStore([current]);
        const expected = oracle(current, next.state);
        const outcome = await store
          .transition(RUN_ID, (c) => decision(c, next))
          .then(
            (stored) => ({ ok: true as const, stored }),
            () => ({ ok: false as const }),
          );
        if (expected !== undefined && expected.repairAttempts === next.repairAttempts) {
          expect(outcome.ok).toBe(true);
          expect(store.get(RUN_ID)).toEqual(expected);
        } else {
          expect(outcome.ok).toBe(false);
          expect(store.get(RUN_ID)).toEqual(current);
          expect(store.events).toHaveLength(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('rejects DELIVERED without capability and leaves the run unchanged', async () => {
    const current = { runId: RUN_ID, state: 'AWAITING_APPROVAL', repairAttempts: 0 } as const;
    const store = new MemoryRunStore([current]);
    await expect(
      store.transition(RUN_ID, (c) => decision(c, { state: 'DELIVERED', repairAttempts: 0 })),
    ).rejects.toMatchObject({ code: 'passing_state_forbidden' });
    expect(store.get(RUN_ID)).toEqual(current);
  });

  it('rejects an illegal edge and a repairAttempts reset from 3 to 0', async () => {
    const a = { runId: RUN_ID, state: 'DEFINED', repairAttempts: 0 } as const;
    const s1 = new MemoryRunStore([a]);
    await expect(
      s1.transition(RUN_ID, (c) => decision(c, { state: 'VERIFYING', repairAttempts: 0 })),
    ).rejects.toThrow();
    expect(s1.get(RUN_ID)).toEqual(a);

    const b = { runId: RUN_ID, state: 'REPAIRING', repairAttempts: 3 } as const;
    const s2 = new MemoryRunStore([b]);
    await expect(
      s2.transition(RUN_ID, (c) => decision(c, { state: 'BUILDING', repairAttempts: 0 })),
    ).rejects.toThrow();
    expect(s2.get(RUN_ID)).toEqual(b);
  });
});
