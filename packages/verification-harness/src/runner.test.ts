import { describe, expect, it } from 'vitest';
import { VerificationReport, type GateId } from '@lathe/shared-contracts';
import type { Gate } from './gate.js';
import { runVerification, type RunInput } from './runner.js';
import { COMMIT, HASH, fakeClock, gatesWith, outcome } from './test-helpers.js';

const input = (gates: Record<GateId, Gate>, extra: Partial<RunInput> = {}): RunInput => ({
  app: 'support-desk',
  worktree: '/workspace/app',
  commit: COMMIT,
  faultInjection: null,
  gates,
  harnessSha256: HASH,
  policySha256: HASH,
  now: fakeClock(),
  ...extra,
});
const statuses = (r: { gates: readonly { status: string }[] }) => r.gates.map((g) => g.status);

describe('runVerification', () => {
  it('passes only when every gate passes, and emits a valid C3 report', async () => {
    const r = await runVerification(input(gatesWith()));
    expect(r.overall).toBe('passed');
    expect(statuses(r)).toEqual(Array(7).fill('passed'));
    expect(VerificationReport.safeParse(r).success).toBe(true);
    expect(r.gates.every((g) => g.durationMs > 0)).toBe(true);
  });

  it('stops at the first failure and marks the rest not_run', async () => {
    const r = await runVerification(
      input(gatesWith({ 'tenant-isolation': () => Promise.resolve(outcome('failed')) })),
    );
    expect(r.overall).toBe('failed');
    expect(statuses(r)).toEqual([
      'passed',
      'passed',
      'passed',
      'failed',
      'not_run',
      'not_run',
      'not_run',
    ]);
  });

  it('turns a throwing gate into error, never a pass', async () => {
    const r = await runVerification(
      input(gatesWith({ static: () => Promise.reject(new Error('tsc crashed')) })),
    );
    expect(r.overall).toBe('error');
    expect(statuses(r).slice(0, 3)).toEqual(['passed', 'error', 'not_run']);
    expect(r.gates[1]?.summary).toContain('tsc crashed');
  });

  it('turns a failure without findings into error', async () => {
    const r = await runVerification(
      input(gatesWith({ rbac: () => Promise.resolve(outcome('failed', false)) })),
    );
    expect(r.gates[4]?.status).toBe('error');
  });

  it('rejects a gate registered under the wrong id', async () => {
    const gates = gatesWith();
    gates.tests = { id: 'static', run: () => Promise.resolve(outcome('passed')) };
    const r = await runVerification(input(gates));
    expect(r.gates[2]?.status).toBe('error');
  });

  it('gives the same result hash for the same inputs, and a different one when anything changes', async () => {
    const a = await runVerification(input(gatesWith()));
    const b = await runVerification(input(gatesWith(), { now: fakeClock(50) }));
    expect(a.resultHash).toBe(b.resultHash);
    const otherCommit = await runVerification(input(gatesWith(), { commit: 'b'.repeat(40) }));
    const otherPolicy = await runVerification(input(gatesWith(), { policySha256: 'c'.repeat(64) }));
    const otherOutcome = await runVerification(
      input(gatesWith({ security: () => Promise.resolve(outcome('failed')) })),
    );
    expect(
      new Set([
        a.resultHash,
        otherCommit.resultHash,
        otherPolicy.resultHash,
        otherOutcome.resultHash,
      ]).size,
    ).toBe(4);
  });

  it('carries the injected-fault label', async () => {
    const faultInjection = { name: 'drop-tenant-filter', label: 'injected by Lathe' } as const;
    const r = await runVerification(input(gatesWith(), { faultInjection }));
    expect(r.faultInjection).toEqual(faultInjection);
  });
});
