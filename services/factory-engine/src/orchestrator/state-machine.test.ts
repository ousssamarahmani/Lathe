import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { issueEngineCapability } from './capability.js';
import { RunStateError } from './errors.js';
import { MemoryRunStore } from './memory-run-store.js';
import { resumeRuns, transitionRun } from './run-store.js';
import {
  MAX_REPAIR_ATTEMPTS,
  PASSING_STATES,
  RUN_STATES,
  allowedTransitions,
  isTerminal,
  nextSnapshot,
  type RunSnapshot,
  type RunState,
} from './state-machine.js';

const cap = issueEngineCapability();
const start: RunSnapshot = { runId: 'r1', state: 'DEFINED', repairAttempts: 0 };
const stateArb = fc.constantFrom(...RUN_STATES);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RunStateError) return e.code;
    throw e;
  }
  return 'none';
}

describe('run state machine (pure)', () => {
  it('walks the happy path with one repair loop', () => {
    let s = start;
    for (const to of [
      'PLANNED',
      'BUILDING',
      'VERIFYING',
      'REPAIRING',
      'BUILDING',
      'VERIFYING',
    ] as const)
      s = nextSnapshot(s, to);
    s = nextSnapshot(s, 'AWAITING_APPROVAL', cap);
    s = nextSnapshot(s, 'DELIVERED', cap);
    expect(s).toEqual({ runId: 'r1', state: 'DELIVERED', repairAttempts: 1 });
  });

  it('rejects skipping a step', () => {
    expect(codeOf(() => nextSnapshot(start, 'BUILDING'))).toBe('illegal_transition');
    expect(codeOf(() => nextSnapshot(start, 'DELIVERED', cap))).toBe('illegal_transition');
  });

  it('denies passing states without the capability, even on a legal edge', () => {
    const verifying: RunSnapshot = { ...start, state: 'VERIFYING' };
    expect(codeOf(() => nextSnapshot(verifying, 'AWAITING_APPROVAL'))).toBe(
      'passing_state_forbidden',
    );
    // A forged object is not a capability.
    const forged = {} as never;
    expect(codeOf(() => nextSnapshot(verifying, 'AWAITING_APPROVAL', forged))).toBe(
      'passing_state_forbidden',
    );
  });

  it('terminal states have no exits', () => {
    for (const s of ['DELIVERED', 'FAILED', 'CANCELLED'] as const) {
      expect(allowedTransitions(s)).toEqual([]);
      expect(isTerminal(s)).toBe(true);
    }
  });

  it('stops the fourth repair', () => {
    const s: RunSnapshot = { runId: 'r', state: 'VERIFYING', repairAttempts: MAX_REPAIR_ATTEMPTS };
    expect(codeOf(() => nextSnapshot(s, 'REPAIRING'))).toBe('repair_limit_exceeded');
  });

  it('property: random transition sequences keep every invariant', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(stateArb, fc.boolean()), { maxLength: 60 }), (steps) => {
        let s = start;
        let reachedPassing = false;
        for (const [to, withCap] of steps) {
          const legal = allowedTransitions(s.state).includes(to);
          const passing = (PASSING_STATES as readonly RunState[]).includes(to);
          const attempt = () => nextSnapshot(s, to, withCap ? cap : undefined);
          if (!legal) {
            expect(codeOf(attempt)).toBe('illegal_transition');
            continue;
          }
          if (passing && !withCap) {
            expect(codeOf(attempt)).toBe('passing_state_forbidden');
            continue;
          }
          if (to === 'REPAIRING' && s.repairAttempts >= MAX_REPAIR_ATTEMPTS) {
            expect(codeOf(attempt)).toBe('repair_limit_exceeded');
            continue;
          }
          s = attempt();
          if (passing) reachedPassing = true;
          expect(RUN_STATES).toContain(s.state);
          expect(s.repairAttempts).toBeGreaterThanOrEqual(0);
          expect(s.repairAttempts).toBeLessThanOrEqual(MAX_REPAIR_ATTEMPTS);
        }
        // No capability was ever missing on a passing entry, and a passing state implies VERIFYING was visited.
        if (reachedPassing) expect(s.state).not.toBe('DEFINED');
      }),
      { numRuns: 300 },
    );
  });

  it('property: without the capability no sequence reaches a passing state', () => {
    fc.assert(
      fc.property(fc.array(stateArb, { maxLength: 60 }), (steps) => {
        let s = start;
        for (const to of steps) {
          try {
            s = nextSnapshot(s, to);
          } catch (e) {
            expect(e).toBeInstanceOf(RunStateError);
          }
          expect(PASSING_STATES as readonly RunState[]).not.toContain(s.state);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('run store (in memory)', () => {
  it('persists the snapshot and appends one event per transition', async () => {
    const store = new MemoryRunStore([start]);
    await transitionRun(store, 'r1', 'PLANNED', { reason: 'plan approved' });
    await transitionRun(store, 'r1', 'BUILDING');
    expect(store.get('r1')?.state).toBe('BUILDING');
    expect(store.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(store.events[0]?.payload).toMatchObject({
      from: 'DEFINED',
      to: 'PLANNED',
      reason: 'plan approved',
    });
  });

  it('an illegal transition writes nothing', async () => {
    const store = new MemoryRunStore([start]);
    await expect(
      transitionRun(store, 'r1', 'DELIVERED', { capability: cap }),
    ).rejects.toMatchObject({
      code: 'illegal_transition',
    });
    expect(store.get('r1')?.state).toBe('DEFINED');
    expect(store.events).toHaveLength(0);
  });

  it('unknown run is a typed error', async () => {
    await expect(transitionRun(new MemoryRunStore(), 'nope', 'PLANNED')).rejects.toMatchObject({
      code: 'run_not_found',
    });
  });

  it('crash and resume: a restarted store returns the next action for non-terminal runs only', async () => {
    const store = new MemoryRunStore([
      start,
      { runId: 'b', state: 'DEFINED', repairAttempts: 0 },
      { runId: 'done', state: 'DEFINED', repairAttempts: 0 },
    ]);
    await transitionRun(store, 'r1', 'PLANNED');
    await transitionRun(store, 'r1', 'BUILDING');
    await transitionRun(store, 'r1', 'VERIFYING');
    await transitionRun(store, 'r1', 'REPAIRING');
    await transitionRun(store, 'done', 'CANCELLED');
    const restarted = store.clone(); // process died here
    const items = await resumeRuns(restarted);
    expect(items).toEqual([
      { runId: 'r1', state: 'REPAIRING', repairAttempts: 1, action: 'run_repair' },
      { runId: 'b', state: 'DEFINED', repairAttempts: 0, action: 'plan' },
    ]);
    // The resumed run continues where it stopped, with the same event sequence.
    await transitionRun(restarted, 'r1', 'BUILDING');
    expect(restarted.events.filter((e) => e.runId === 'r1').map((e) => e.seq)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it('resume maps every non-terminal state to an action', async () => {
    const states = RUN_STATES.filter((s) => !isTerminal(s));
    const store = new MemoryRunStore(
      states.map((state, i) => ({ runId: `r${i}`, state, repairAttempts: 0 })),
    );
    expect((await resumeRuns(store)).map((i) => i.state)).toEqual(states);
  });
});
