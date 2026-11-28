import { RunStateError } from './errors.js';
import { isTerminal, type RunSnapshot } from './state-machine.js';
import type { EngineCapability } from './capability.js';
import {
  assertValidDecision,
  buildTransitionEvent,
  type RunEventDraft,
  type RunStore,
  type TransitionDecision,
} from './run-store.js';

/** In-memory RunStore for unit tests. Same atomicity contract as the Postgres store. */
export class MemoryRunStore implements RunStore {
  readonly events: Array<{ runId: string; seq: number } & RunEventDraft> = [];
  private readonly runs = new Map<string, RunSnapshot>();

  constructor(initial: readonly RunSnapshot[] = []) {
    for (const run of initial) this.runs.set(run.runId, run);
  }

  /** Simulates a process restart: keeps persisted data, drops nothing else. */
  clone(): MemoryRunStore {
    const copy = new MemoryRunStore([...this.runs.values()]);
    copy.events.push(...this.events);
    return copy;
  }

  async transition(
    runId: string,
    decide: (current: RunSnapshot) => TransitionDecision,
    capability?: EngineCapability,
  ): Promise<RunSnapshot> {
    const current = this.runs.get(runId);
    if (!current) throw new RunStateError('run_not_found', 'Run not found');
    const decision = decide(current);
    const next = decision.next;
    assertValidDecision(current, next, capability);
    const event = buildTransitionEvent(current, next, decision.reason);
    this.runs.set(runId, next);
    const seq = this.events.filter((e) => e.runId === runId).length;
    this.events.push({ runId, seq, ...event });
    return next;
  }

  async listNonTerminal(): Promise<readonly RunSnapshot[]> {
    return [...this.runs.values()].filter((r) => !isTerminal(r.state));
  }

  get(runId: string): RunSnapshot | undefined {
    return this.runs.get(runId);
  }
}
