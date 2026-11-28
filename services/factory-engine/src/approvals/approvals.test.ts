import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ApprovalError, InMemoryApprovals, hashContent } from './approvals.js';

const clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };

describe('approvals', () => {
  it('records approver, content hash and time', () => {
    const a = new InMemoryApprovals(clock);
    const r = a.approve('plan:1', 'alice', 'plan v1');
    expect(r).toEqual({
      subject: 'plan:1',
      approver: 'alice',
      contentHash: hashContent('plan v1'),
      approvedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts unchanged content, rejects changed content as stale', () => {
    const a = new InMemoryApprovals(clock);
    a.approve('plan:1', 'alice', { tasks: [1, 2] });
    expect(a.check('plan:1', { tasks: [1, 2] }).ok).toBe(true);
    expect(a.check('plan:1', { tasks: [1, 2, 3] })).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('rejects subjects never approved', () => {
    expect(new InMemoryApprovals(clock).check('x', 'c')).toMatchObject({
      ok: false,
      reason: 'not_approved',
    });
  });

  it('a new approval of new content supersedes; history is kept', () => {
    const a = new InMemoryApprovals(clock);
    a.approve('s', 'alice', 'v1');
    a.approve('s', 'bob', 'v2');
    expect(a.check('s', 'v1')).toMatchObject({ ok: false, reason: 'stale' });
    expect(a.check('s', 'v2').ok).toBe(true);
    expect(a.history('s')).toHaveLength(2);
  });

  it('requires subject and approver', () => {
    expect(() => new InMemoryApprovals(clock).approve('', 'a', 'c')).toThrow(ApprovalError);
    expect(() => new InMemoryApprovals(clock).approve('s', '', 'c')).toThrow(ApprovalError);
  });

  it('property: check passes iff content hash is equal', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (c1, c2) => {
        const a = new InMemoryApprovals(clock);
        a.approve('s', 'u', c1);
        expect(a.check('s', c2).ok).toBe(c1 === c2);
      }),
    );
  });
});
