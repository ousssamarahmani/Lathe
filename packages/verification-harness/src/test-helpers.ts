import { GATE_ORDER, type GateId } from '@lathe/shared-contracts';
import type { Gate, GateOutcome } from './gate.js';

export const COMMIT = '132716f225555e6462c02bf22a2daf738dbac075';
export const HASH = 'a'.repeat(64);
const finding = {
  ruleId: 'fixture.planted',
  message: 'planted failure',
  severity: 'high',
} as const;

export const outcome = (
  status: GateOutcome['status'],
  withFinding = status === 'failed',
): GateOutcome => ({
  status,
  summary: status,
  findings: withFinding ? [finding] : [],
  artifacts: [],
});

/** Every gate passes unless overridden. */
export function gatesWith(over: Partial<Record<GateId, Gate['run']>> = {}): Record<GateId, Gate> {
  return Object.fromEntries(
    GATE_ORDER.map((id) => [
      id,
      { id, run: over[id] ?? (() => Promise.resolve(outcome('passed'))) },
    ]),
  ) as Record<GateId, Gate>;
}

/** Clock that advances `stepMs` on every call. */
export function fakeClock(stepMs = 5): () => Date {
  let t = Date.parse('2026-11-18T10:00:00Z');
  return () => new Date((t += stepMs));
}
