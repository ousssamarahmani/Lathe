import { describe, expect, it } from 'vitest';
import {
  AUTH_BASE_PATH,
  CONTRACT_VERSION,
  ListQuery,
  Me,
  ORG_INDEPENDENT_PERMISSIONS,
  PatchView,
  ROUTES,
  RunEventsQuery,
  SetActiveOrgRequest,
  SubmitSpecRequest,
} from './index.js';
import { GIT_SHA, SHA256, UUID_A, UUID_B } from './test-fixtures.js';

const member = { membershipId: UUID_B, orgId: UUID_A, orgName: 'Acme', role: 'agent' };
const me = {
  user: { id: UUID_B, name: 'Ada', email: 'ada@example.com' },
  memberships: [member],
  activeOrgId: UUID_A,
  permissions: ['tickets.read'],
};

describe('C4 v1.1', () => {
  it('reports version 1.1 or later', () => {
    expect(CONTRACT_VERSION).not.toBe('1.0.0');
  });

  it('R1: /v1/me returns the user, memberships and active-org permissions', () => {
    expect(ROUTES.getMe.path).toBe('/v1/me');
    expect(Me.safeParse(me).success).toBe(true);
    expect(Me.safeParse({ ...me, activeOrgId: null, permissions: [] }).success).toBe(true);
  });
  it('R1: no permissions without an active org, and the active org must be a membership', () => {
    expect(Me.safeParse({ ...me, activeOrgId: null }).success).toBe(false);
    expect(
      Me.safeParse({ ...me, activeOrgId: '8a1d2e3f-4b5c-4d6e-8f7a-000000000000' }).success,
    ).toBe(false);
  });

  it('R2: auth lives outside /v1 and the org switch takes only a membership id', () => {
    expect(AUTH_BASE_PATH.startsWith('/v1')).toBe(false);
    expect(Object.values(ROUTES).some((r) => r.path.startsWith(AUTH_BASE_PATH))).toBe(false);
    expect(SetActiveOrgRequest.safeParse({ membershipId: UUID_B }).success).toBe(true);
    expect(SetActiveOrgRequest.safeParse({ membershipId: UUID_B, orgId: UUID_A }).success).toBe(
      false,
    );
    expect(SetActiveOrgRequest.safeParse({ orgId: UUID_A }).success).toBe(false);
  });
  it('R2: only the session routes use org-independent permissions', () => {
    const independent = Object.values(ROUTES).filter((r) =>
      (ORG_INDEPENDENT_PERMISSIONS as readonly string[]).includes(r.permission),
    );
    expect(independent.map((r) => r.path).sort()).toEqual(['/v1/me', '/v1/session/active-org']);
  });

  it('R3: a patch view carries the patch of one attempt, at most 3 repairs', () => {
    const patch = {
      baseCommit: GIT_SHA,
      diff: 'diff --git a/x b/x',
      files: ['apps/support-desk/x.ts'],
      sha256: SHA256,
    };
    expect(PatchView.safeParse({ runId: UUID_A, attempt: 0, patch }).success).toBe(true);
    expect(PatchView.safeParse({ runId: UUID_A, attempt: 4, patch }).success).toBe(false);
    expect(ROUTES.getPatch.permission).toBe('evidence.read');
  });

  it('R4: the event stream resumes after a seq', () => {
    expect(ROUTES.streamRunEvents.query).toBe(RunEventsQuery);
    expect(RunEventsQuery.safeParse({ after: '41' }).success).toBe(true);
    for (const bad of ['-1', '01', 'abc', ''])
      expect(RunEventsQuery.safeParse({ after: bad }).success).toBe(false);
  });

  it('R5: every list route takes a cursor and a limit of 1 to 100', () => {
    for (const r of [ROUTES.listProjects, ROUTES.listSpecs, ROUTES.listRuns, ROUTES.listEvidence])
      expect(r.query).toBe(ListQuery);
    expect(ListQuery.safeParse({ cursor: 'abc', limit: '100' }).success).toBe(true);
    for (const bad of ['0', '101', '-5', '1.5'])
      expect(ListQuery.safeParse({ limit: bad }).success).toBe(false);
    expect(ListQuery.safeParse({ orgId: UUID_A }).success).toBe(false);
  });

  it('R6: a spec can be read alone and edited by superseding it', () => {
    expect(ROUTES.getSpec.path).toBe('/v1/specs/:specId');
    expect(SubmitSpecRequest.safeParse({ title: 't', body: 'b', supersedes: UUID_A }).success).toBe(
      true,
    );
    expect(SubmitSpecRequest.safeParse({ title: 't', body: 'b' }).success).toBe(true);
  });

  it('R7: delivery is null before it starts', () => {
    expect(ROUTES.getDelivery.response.safeParse(null).success).toBe(true);
  });

  it('R8: the Agents page has a real route', () => {
    expect(ROUTES.listAgents.path).toBe('/v1/agents');
  });
});
