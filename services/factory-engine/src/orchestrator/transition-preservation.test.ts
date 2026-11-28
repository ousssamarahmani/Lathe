import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { issueEngineCapability } from './capability.js';
import { RunStateError } from './errors.js';
import { MemoryRunStore } from './memory-run-store.js';
import { transitionRun } from './run-store.js';
import {
  MAX_REPAIR_ATTEMPTS,
  PASSING_STATES,
  RUN_STATES,
  allowedTransitions,
  nextSnapshot,
  type RunSnapshot,
  type RunState,
} from './state-machine.js';

/**
 * Preservation (bugfix 3.2, 3.6): behavior of legal and illegal transitions that
 * must not change when the store becomes the enforcement point.
 * Passes on unfixed code.
 */

const cap = issueEngineCapability();
const stateArb = fc.constantFrom(...RUN_STATES);
const start: RunSnapshot = { runId: 'r1', state: 'DEFINED', repairAttempts: 0 };

// Independent copy of the current table. Any change to it must be deliberate.
const EXPECTED_TABLE: Record<RunState, readonly RunState[]> = {
  DEFINED: ['PLANNED', 'FAILED', 'CANCELLED'],
  PLANNED: ['BUILDING', 'FAILED', 'CANCELLED'],
  BUILDING: ['VERIFYING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['REPAIRING', 'AWAITING_APPROVAL', 'FAILED', 'CANCELLED'],
  REPAIRING: ['BUILDING', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['DELIVERED', 'FAILED', 'CANCELLED'],
  DELIVERED: [],
  FAILED: [],
  CANCELLED: [],
};

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RunStateError) return e.code;
    throw e;
  }
  return 'none';
}

describe('transition table preservation', () => {
  it('allowed transitions equal the current table', () => {
    const actual = Object.fromEntries(RUN_STATES.map((s) => [s, [...allowedTransitions(s)]]));
    expect(actual).toEqual(EXPECTED_TABLE);
    expect(MAX_REPAIR_ATTEMPTS).toBe(3);
    expect([...PASSING_STATES]).toEqual(['AWAITING_APPROVAL', 'DELIVERED']);
  });

  it('nextSnapshot over every (from, to) pair matches the table and repair accounting', () => {
    fc.assert(
      fc.property(
        stateArb,
        stateArb,
        fc.integer({ min: 0, max: MAX_REPAIR_ATTEMPTS }),
        (from, to, n) => {
          const cur: RunSnapshot = { runId: 'r', state: from, repairAttempts: n };
          const legal = EXPECTED_TABLE[from].includes(to);
          const passing = to === 'AWAITING_APPROVAL' || to === 'DELIVERED';
          if (!legal) {
            expect(() => nextSnapshot(cur, to, cap)).toThrowError(RunStateError);
            return;
          }
          if (passing) {
            expect(() => nextSnapshot(cur, to)).toThrowError(RunStateError);
          }
          if (to === 'REPAIRING' && n >= MAX_REPAIR_ATTEMPTS) {
            expect(() => nextSnapshot(cur, to, cap)).toThrowError(RunStateError);
            return;
          }
          const next = nextSnapshot(cur, to, cap);
          expect(next).toEqual({
            runId: 'r',
            state: to,
            repairAttempts: n + (to === 'REPAIRING' ? 1 : 0),
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('transitionRun over random legal edge sequences (MemoryRunStore)', () => {
  it('applies every legal edge with the capability, including passing states and repair loops', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat({ max: 20 }), { minLength: 1, maxLength: 40 }),
        async (picks) => {
          const store = new MemoryRunStore([start]);
          let model: RunSnapshot = start;
          let applied = 0;
          for (const pick of picks) {
            const options = EXPECTED_TABLE[model.state].filter(
              (t) => !(t === 'REPAIRING' && model.repairAttempts >= MAX_REPAIR_ATTEMPTS),
            );
            if (options.length === 0) break;
            const to = options[pick % options.length] as RunState;
            const expected: RunSnapshot = {
              ...model,
              state: to,
              repairAttempts: model.repairAttempts + (to === 'REPAIRING' ? 1 : 0),
            };
            const got = await transitionRun(store, 'r1', to, { capability: cap });
            expect(got).toEqual(expected);
            expect(store.get('r1')).toEqual(expected);
            model = expected;
            applied += 1;
            expect(store.events.filter((e) => e.runId === 'r1')).toHaveLength(applied);
          }
          expect(model.repairAttempts).toBeLessThanOrEqual(MAX_REPAIR_ATTEMPTS);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a repair loop reaches the bound, then rejects a further repair without changing the run', async () => {
    const store = new MemoryRunStore([start]);
    for (const to of ['PLANNED', 'BUILDING', 'VERIFYING'] as const)
      await transitionRun(store, 'r1', to);
    for (let i = 1; i <= MAX_REPAIR_ATTEMPTS; i++) {
      await transitionRun(store, 'r1', 'REPAIRING');
      expect(store.get('r1')?.repairAttempts).toBe(i);
      await transitionRun(store, 'r1', 'BUILDING');
      await transitionRun(store, 'r1', 'VERIFYING');
    }
    const before = store.get('r1');
    expect(await codeOf(transitionRun(store, 'r1', 'REPAIRING', { capability: cap }))).toBe(
      'repair_limit_exceeded',
    );
    expect(store.get('r1')).toEqual(before);
    const after = await transitionRun(store, 'r1', 'AWAITING_APPROVAL', { capability: cap });
    expect(after.state).toBe('AWAITING_APPROVAL');
    expect((await transitionRun(store, 'r1', 'DELIVERED', { capability: cap })).state).toBe(
      'DELIVERED',
    );
  });

  it('rejects every illegal edge and leaves the run and its events untouched', async () => {
    await fc.assert(
      fc.asyncProperty(
        stateArb,
        stateArb,
        fc.integer({ min: 0, max: MAX_REPAIR_ATTEMPTS }),
        async (from, to, n) => {
          fc.pre(!EXPECTED_TABLE[from].includes(to));
          const init: RunSnapshot = { runId: 'r1', state: from, repairAttempts: n };
          const store = new MemoryRunStore([init]);
          expect(await codeOf(transitionRun(store, 'r1', to, { capability: cap }))).toBe(
            'illegal_transition',
          );
          expect(store.get('r1')).toEqual(init);
          expect(store.events).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('rejects passing states without the capability on a legal edge', async () => {
    for (const [from, to] of [
      ['VERIFYING', 'AWAITING_APPROVAL'],
      ['AWAITING_APPROVAL', 'DELIVERED'],
    ] as const) {
      const init: RunSnapshot = { runId: 'r1', state: from, repairAttempts: 0 };
      const store = new MemoryRunStore([init]);
      expect(await codeOf(transitionRun(store, 'r1', to))).toBe('passing_state_forbidden');
      expect(store.get('r1')).toEqual(init);
    }
  });

  it('unknown run is rejected', async () => {
    expect(await codeOf(transitionRun(new MemoryRunStore(), 'nope', 'PLANNED'))).toBe(
      'run_not_found',
    );
  });
});
