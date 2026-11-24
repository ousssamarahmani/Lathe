import { describe, expect, it } from 'vitest';
import { ROUTES, type RouteName, type RunEvent } from '@lathe/shared-contracts';
import { hashContent } from '../approvals/index.js';
import { MemoryRunStore } from '../orchestrator/memory-run-store.js';
import { ENGINE_PERMISSIONS, engineAuthz } from './authz.js';
import { MemoryApiStore } from './memory-store.js';
import { buildApiServer } from './server.js';
import { TestExecutor } from './test-executor.js';

const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b1';
const USER_OP = '00000000-0000-4000-8000-000000000001';
const USER_APPROVER = '00000000-0000-4000-8000-000000000002';
const USER_VIEWER = '00000000-0000-4000-8000-000000000003';
const USER_B = '00000000-0000-4000-8000-000000000004';

const OP = { authorization: 'Bearer op' };
const APPROVER = { authorization: 'Bearer approver' };
const VIEWER = { authorization: 'Bearer viewer' };
const OTHER_ORG = { authorization: 'Bearer other' };

function setup() {
  let n = 0;
  const newId = () => `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const runStore = new MemoryRunStore();
  const store = new MemoryApiStore({
    now: () => new Date('2026-11-20T10:00:00.000Z'),
    newId,
    runStore,
  });
  const executor = new TestExecutor(engineAuthz);
  executor.sessions.set('op', { userId: USER_OP, orgId: ORG_A, role: 'operator' });
  executor.sessions.set('approver', { userId: USER_APPROVER, orgId: ORG_A, role: 'approver' });
  executor.sessions.set('viewer', { userId: USER_VIEWER, orgId: ORG_A, role: 'viewer' });
  executor.sessions.set('other', { userId: USER_B, orgId: ORG_B, role: 'owner' });
  const server = buildApiServer({
    executor,
    store,
    runStore,
    newRequestId: () => `20000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    pollMs: 1,
    sleep: async () => {},
  });
  return { ...server, store, executor, runStore, newId };
}

async function createProject(s: ReturnType<typeof setup>) {
  const res = await s.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: OP,
    payload: { name: 'Support Desk', slug: 'support-desk', targetApp: 'support-desk' },
  });
  return { res, project: res.json() as { id: string } };
}

async function submitSpec(s: ReturnType<typeof setup>, projectId: string) {
  const res = await s.app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/specs`,
    headers: OP,
    payload: { title: 'KB', body: '# Knowledge base' },
  });
  return res.json() as { id: string; contentSha256: string; status: string };
}

describe('deny by default', () => {
  it('every implemented route declares a permission that exists in C4 and in the authz map', () => {
    const { routes } = setup();
    expect(routes.length).toBeGreaterThan(0);
    const c4 = new Map(
      Object.values(ROUTES).map((r) => [`${r.method} ${r.path}`, r.permission as string]),
    );
    for (const route of routes) {
      expect(c4.get(`${route.method} ${route.url}`), `${route.method} ${route.url}`).toBe(
        route.permission,
      );
      expect(engineAuthz.permissions).toContain(route.permission);
    }
  });

  it('declares every non-user C4 permission in the authz map', () => {
    const needed = new Set(
      Object.values(ROUTES)
        .map((r) => r.permission as string)
        .filter((p) => !p.startsWith('session.')),
    );
    expect(new Set<string>(ENGINE_PERMISSIONS)).toEqual(needed);
  });

  it('answers 401 to every registered route without a session, with the error shape', async () => {
    const s = setup();
    for (const route of s.routes) {
      const url = route.url.replace(/:[A-Za-z]+/g, '30000000-0000-4000-8000-000000000001');
      const res = await s.app.inject({
        method: route.method as 'GET' | 'POST',
        url,
        ...(route.method === 'POST' ? { payload: {} } : {}),
      });
      expect(res.statusCode, `${route.method} ${url}`).toBe(401);
      expect(res.json()).toMatchObject({ code: 'unauthenticated' });
      expect((res.json() as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('answers 401 to an unknown token', async () => {
    const s = setup();
    const res = await s.app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses to start when a route has no permission', () => {
    const s = setup();
    expect(() =>
      s.app.route({ method: 'GET', url: '/v1/open', handler: async () => ({}) }),
    ).toThrow(/declares no valid permission/);
    expect(() =>
      s.app.route({
        method: 'GET',
        url: '/v1/undeclared',
        config: { permission: 'made.up' },
        handler: async () => ({}),
      }),
    ).toThrow(/declares no valid permission/);
  });

  it('implements only routes that exist in C4, and lists the ones not implemented yet', () => {
    const { routes } = setup();
    const implemented = new Set(routes.map((r) => `${r.method} ${r.url}`));
    const missing = (Object.keys(ROUTES) as RouteName[])
      .filter((n) => !implemented.has(`${ROUTES[n].method} ${ROUTES[n].path}`))
      .sort();
    expect(missing).toEqual([
      'getDelivery',
      'getMe',
      'getOverview',
      'getPatch',
      'listAgents',
      'listEvidence',
      'listVerificationReports',
      'setActiveOrg',
    ]);
  });

  it('denies a role that lacks the permission, and audits the denial', async () => {
    const s = setup();
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: VIEWER,
      payload: { name: 'x', slug: 'x', targetApp: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
    expect(s.executor.audit).toContainEqual(
      expect.objectContaining({ action: 'createProject', outcome: 'denied', orgId: ORG_A }),
    );
  });

  it('denies a session with no active org', async () => {
    const s = setup();
    s.executor.sessions.set('noorg', { userId: USER_OP, orgId: null, role: null });
    const res = await s.app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { authorization: 'Bearer noorg' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('org scoping', () => {
  it('ignores an org id supplied by the client and rejects it in the body', async () => {
    const s = setup();
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: OP,
      payload: { name: 'x', slug: 'x', targetApp: 'x', orgId: ORG_B },
    });
    expect(res.statusCode).toBe(400);
    const viaHeader = await s.app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { ...OTHER_ORG, 'x-org-id': ORG_A },
    });
    expect(viaHeader.json()).toMatchObject({ items: [] });
    const viaQuery = await s.app.inject({
      method: 'GET',
      url: `/v1/projects?orgId=${ORG_A}`,
      headers: OTHER_ORG,
    });
    expect(viaQuery.statusCode).toBe(400);
  });

  it('returns 404, same as a missing id, for resources of another org on every id route', async () => {
    const s = setup();
    const { project } = await createProject(s);
    const spec = await submitSpec(s, project.id);
    const runId = '40000000-0000-4000-8000-000000000001';
    const planId = '40000000-0000-4000-8000-000000000002';
    s.store.seedRun(ORG_A, {
      id: runId,
      projectId: project.id,
      specId: spec.id,
      planId: null,
      state: 'BUILDING',
      demo: false,
      faultInjection: null,
      repairAttempts: 0,
      createdAt: '2026-11-20T10:00:00.000Z',
      updatedAt: '2026-11-20T10:00:00.000Z',
    } as never);
    const hash = hashContent('x');
    const decision = { decision: 'approved', contentSha256: hash };
    const probes: Array<[string, string, unknown?]> = [
      ['GET', `/v1/projects/${project.id}`],
      ['GET', `/v1/projects/${project.id}/specs`],
      ['POST', `/v1/projects/${project.id}/specs`, { title: 't', body: 'b' }],
      ['GET', `/v1/specs/${spec.id}`],
      ['POST', `/v1/specs/${spec.id}/decision`, decision],
      ['GET', `/v1/plans/${planId}`],
      ['POST', `/v1/plans/${planId}/decision`, decision],
      ['GET', `/v1/projects/${project.id}/runs`],
      [
        'POST',
        `/v1/projects/${project.id}/runs`,
        { specId: spec.id, demo: false, faultInjection: null },
      ],
      ['GET', `/v1/runs/${runId}`],
      ['POST', `/v1/runs/${runId}/cancel`],
      ['GET', `/v1/runs/${runId}/events`],
      ['POST', `/v1/runs/${runId}/delivery/decision`, decision],
    ];
    for (const [method, url, payload] of probes) {
      const foreign = await s.app.inject({
        method: method as 'GET' | 'POST',
        url,
        headers: OTHER_ORG,
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      expect(foreign.statusCode, `${method} ${url}`).toBe(404);
      const missing = await s.app.inject({
        method: method as 'GET' | 'POST',
        url: url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '50000000-0000-4000-8000-000000000009'),
        headers: OTHER_ORG,
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      expect(missing.statusCode, `${method} ${url}`).toBe(404);
      const a = foreign.json() as { code: string; message: string };
      const b = missing.json() as { code: string; message: string };
      expect({ code: a.code, message: a.message }).toEqual({ code: b.code, message: b.message });
    }
    // Listing in another org shows nothing of org A.
    const list = await s.app.inject({ method: 'GET', url: '/v1/projects', headers: OTHER_ORG });
    expect(list.json()).toEqual({ items: [], nextCursor: null });
  });

  it('treats a malformed id as not found', async () => {
    const s = setup();
    const res = await s.app.inject({ method: 'GET', url: '/v1/runs/not-a-uuid', headers: OP });
    expect(res.statusCode).toBe(404);
  });
});

describe('projects, specs and runs', () => {
  it('creates, reads and paginates projects, rejecting a duplicate slug', async () => {
    const s = setup();
    const { res, project } = await createProject(s);
    expect(res.statusCode).toBe(201);
    const dup = await s.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: OP,
      payload: { name: 'again', slug: 'support-desk', targetApp: 'support-desk' },
    });
    expect(dup.statusCode).toBe(409);
    for (const slug of ['a', 'b']) {
      await s.app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: OP,
        payload: { name: slug, slug, targetApp: 'support-desk' },
      });
    }
    const page1 = await s.app.inject({
      method: 'GET',
      url: '/v1/projects?limit=2',
      headers: VIEWER,
    });
    const body1 = page1.json() as { items: unknown[]; nextCursor: string };
    expect(body1.items).toHaveLength(2);
    const page2 = await s.app.inject({
      method: 'GET',
      url: `/v1/projects?limit=2&cursor=${body1.nextCursor}`,
      headers: VIEWER,
    });
    expect(page2.json()).toMatchObject({ nextCursor: null });
    expect((page2.json() as { items: unknown[] }).items).toHaveLength(1);
    const got = await s.app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}`,
      headers: VIEWER,
    });
    expect(got.statusCode).toBe(200);
    const badLimit = await s.app.inject({
      method: 'GET',
      url: '/v1/projects?limit=0',
      headers: VIEWER,
    });
    expect(badLimit.statusCode).toBe(400);
    const badCursor = await s.app.inject({
      method: 'GET',
      url: '/v1/projects?cursor=abc',
      headers: VIEWER,
    });
    expect(badCursor.statusCode).toBe(400);
  });

  it('hides the submitter from spec responses and versions superseded specs', async () => {
    const s = setup();
    const { project } = await createProject(s);
    const v1 = await submitSpec(s, project.id);
    const res = await s.app.inject({ method: 'GET', url: `/v1/specs/${v1.id}`, headers: VIEWER });
    expect(res.json()).not.toHaveProperty('submittedBy');
    const v2 = await s.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/specs`,
      headers: OP,
      payload: { title: 'KB v2', body: 'new', supersedes: v1.id },
    });
    expect(v2.json()).toMatchObject({ version: 2 });
    const old = await s.app.inject({ method: 'GET', url: `/v1/specs/${v1.id}`, headers: VIEWER });
    expect(old.json()).toMatchObject({ status: 'superseded' });
  });

  it('rejects unknown body fields and a verdict in the body (strict)', async () => {
    const s = setup();
    const { project } = await createProject(s);
    const res = await s.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: OP,
      payload: { specId: project.id, demo: false, faultInjection: null, state: 'DELIVERED' },
    });
    expect(res.statusCode).toBe(400);
    const demoOnly = await s.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: OP,
      payload: { specId: project.id, demo: false, faultInjection: 'missing_org_filter' },
    });
    expect(demoOnly.statusCode).toBe(400);
  });

  it('creates a run only from an approved spec, always in DEFINED', async () => {
    const s = setup();
    const { project } = await createProject(s);
    const spec = await submitSpec(s, project.id);
    const payload = { specId: spec.id, demo: false, faultInjection: null };
    const early = await s.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: OP,
      payload,
    });
    expect(early.statusCode).toBe(409);
    await s.app.inject({
      method: 'POST',
      url: `/v1/specs/${spec.id}/decision`,
      headers: APPROVER,
      payload: { decision: 'approved', contentSha256: spec.contentSha256 },
    });
    const ok = await s.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: OP,
      payload,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ state: 'DEFINED', repairAttempts: 0 });
  });

  it('cancels a run through a non-passing transition and rejects cancelling a terminal run', async () => {
    const s = setup();
    const { project } = await createProject(s);
    const runId = '40000000-0000-4000-8000-0000000000c1';
    s.store.seedRun(ORG_A, {
      id: runId,
      projectId: project.id,
      specId: '40000000-0000-4000-8000-0000000000c2',
      planId: null,
      state: 'BUILDING',
      demo: false,
      faultInjection: null,
      repairAttempts: 0,
      createdAt: '2026-11-20T10:00:00.000Z',
      updatedAt: '2026-11-20T10:00:00.000Z',
    } as never);
    const rs = new MemoryRunStore([{ runId, state: 'BUILDING', repairAttempts: 0 }]);
    // Rebuild the server around a run store that knows the run.
    const s2 = (() => {
      const executor = s.executor;
      return buildApiServer({
        executor,
        store: s.store,
        runStore: rs,
        newRequestId: () => '60000000-0000-4000-8000-000000000001',
      });
    })();
    const first = await s2.app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/cancel`,
      headers: OP,
    });
    expect(first.statusCode).toBe(200);
    expect(rs.get(runId)?.state).toBe('CANCELLED');
    const again = await s2.app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/cancel`,
      headers: OP,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'invalid_state_transition' });
    const viewer = await s2.app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/cancel`,
      headers: VIEWER,
    });
    expect(viewer.statusCode).toBe(403);
  });
});

describe('approvals', () => {
  it('records an approval bound to the content hash and marks the spec approved', async () => {
    const s = setup();
    const { project } = await createProject(s);
    const spec = await submitSpec(s, project.id);
    expect(spec.contentSha256).toBe(hashContent('# Knowledge base'));
    const res = await s.app.inject({
      method: 'POST',
      url: `/v1/specs/${spec.id}/decision`,
      headers: APPROVER,
      payload: { decision: 'approved', contentSha256: spec.contentSha256 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      subjectType: 'spec',
      subjectId: spec.id,
      contentSha256: spec.contentSha256,
      approverId: USER_APPROVER,
    });
    const after = await s.app.inject({
      method: 'GET',
      url: `/v1/specs/${spec.id}`,
      headers: VIEWER,
    });
    expect(after.json()).toMatchObject({ status: 'approved' });
    const twice = await s.app.inject({
      method: 'POST',
      url: `/v1/specs/${spec.id}/decision`,
      headers: APPROVER,
      payload: { decision: 'approved', contentSha256: spec.contentSha256 },
    });
    expect(twice.statusCode).toBe(409);
  });

  it('answers stale_approval when the hash is not the current content, and records nothing', async () => {
    const s = setup();
    const { project } = await createProject(s);
    const spec = await submitSpec(s, project.id);
    const res = await s.app.inject({
      method: 'POST',
      url: `/v1/specs/${spec.id}/decision`,
      headers: APPROVER,
      payload: { decision: 'approved', contentSha256: hashContent('older text') },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'stale_approval' });
    expect(s.store.approvals).toHaveLength(0);
  });

  it('denies self-approval and a role without the approval permission', async () => {
    const s = setup();
    s.executor.sessions.set('owner-submitter', { userId: USER_OP, orgId: ORG_A, role: 'owner' });
    const { project } = await createProject(s);
    const spec = await submitSpec(s, project.id);
    const payload = { decision: 'approved', contentSha256: spec.contentSha256 };
    const self = await s.app.inject({
      method: 'POST',
      url: `/v1/specs/${spec.id}/decision`,
      headers: { authorization: 'Bearer owner-submitter' },
      payload,
    });
    expect(self.statusCode).toBe(403);
    const operator = await s.app.inject({
      method: 'POST',
      url: `/v1/specs/${spec.id}/decision`,
      headers: OP,
      payload,
    });
    expect(operator.statusCode).toBe(403);
    expect(s.store.approvals).toHaveLength(0);
    expect(s.executor.audit.filter((e) => e.outcome === 'denied')).toHaveLength(2);
  });

  it('rejects a decision body with an extra field or a bad hash', async () => {
    const s = setup();
    const { project } = await createProject(s);
    const spec = await submitSpec(s, project.id);
    for (const payload of [
      { decision: 'approved', contentSha256: spec.contentSha256, approverId: USER_OP },
      { decision: 'approved', contentSha256: 'abc' },
      { decision: 'maybe', contentSha256: spec.contentSha256 },
    ]) {
      const res = await s.app.inject({
        method: 'POST',
        url: `/v1/specs/${spec.id}/decision`,
        headers: APPROVER,
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('decides a plan and a delivery with the same hash binding, and never moves the run state', async () => {
    const s = setup();
    const { project } = await createProject(s);
    const planId = '40000000-0000-4000-8000-0000000000d1';
    const runId = '40000000-0000-4000-8000-0000000000d2';
    const planHash = hashContent('plan');
    s.store.seedPlan(ORG_A, {
      id: planId,
      specId: '40000000-0000-4000-8000-0000000000d3',
      tasks: [
        {
          key: 't1',
          title: 't',
          paths: ['apps/support-desk/src/kb'],
          acceptanceChecks: ['c'],
          dependsOn: [],
        },
      ],
      contentSha256: planHash,
      status: 'proposed',
      createdAt: '2026-11-20T10:00:00.000Z',
    } as never);
    s.store.seedRun(ORG_A, {
      id: runId,
      projectId: project.id,
      specId: '40000000-0000-4000-8000-0000000000d3',
      planId,
      state: 'AWAITING_APPROVAL',
      demo: false,
      faultInjection: null,
      repairAttempts: 0,
      createdAt: '2026-11-20T10:00:00.000Z',
      updatedAt: '2026-11-20T10:00:00.000Z',
    } as never);
    const noDelivery = await s.app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/delivery/decision`,
      headers: APPROVER,
      payload: { decision: 'approved', contentSha256: hashContent('d') },
    });
    expect(noDelivery.json()).toMatchObject({ code: 'invalid_state_transition' });
    s.store.seedDeliveryHash(runId, hashContent('d'));
    const stale = await s.app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/delivery/decision`,
      headers: APPROVER,
      payload: { decision: 'approved', contentSha256: planHash },
    });
    expect(stale.json()).toMatchObject({ code: 'stale_approval' });
    const delivery = await s.app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/delivery/decision`,
      headers: APPROVER,
      payload: { decision: 'approved', contentSha256: hashContent('d') },
    });
    expect(delivery.statusCode).toBe(201);
    const plan = await s.app.inject({
      method: 'POST',
      url: `/v1/plans/${planId}/decision`,
      headers: APPROVER,
      payload: { decision: 'approved', contentSha256: planHash },
    });
    expect(plan.statusCode).toBe(201);
    const run = await s.app.inject({ method: 'GET', url: `/v1/runs/${runId}`, headers: VIEWER });
    expect(run.json()).toMatchObject({ state: 'AWAITING_APPROVAL' });
  });
});

describe('error responses', () => {
  it('returns the C4 error shape for malformed JSON and unknown routes, without internals', async () => {
    const s = setup();
    const bad = await s.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...OP, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'bad_request' });
    const unknown = await s.app.inject({ method: 'GET', url: '/v1/merge', headers: OP });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'not_found' });
  });

  it('reports an unexpected handler failure as a bare internal error', async () => {
    const s = setup();
    s.store.listProjects = async () => {
      throw new Error('select * from secret_table failed at /srv/app/db.ts');
    };
    const res = await s.app.inject({ method: 'GET', url: '/v1/projects', headers: OP });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret_table');
    expect(res.json()).toMatchObject({ code: 'internal', message: 'internal error' });
  });
});

describe('SSE run events', () => {
  function event(runId: string, seq: number): RunEvent {
    return {
      runId,
      seq,
      at: '2026-11-20T10:00:00.000Z',
      type: 'state_changed',
      from: seq === 0 ? null : 'DEFINED',
      to: 'DEFINED',
    } as RunEvent;
  }

  async function withRun(state: 'DELIVERED' | 'BUILDING') {
    const s = setup();
    const { project } = await createProject(s);
    const runId = '70000000-0000-4000-8000-000000000001';
    s.store.seedRun(ORG_A, {
      id: runId,
      projectId: project.id,
      specId: '70000000-0000-4000-8000-000000000002',
      planId: null,
      state,
      demo: false,
      faultInjection: null,
      repairAttempts: 0,
      createdAt: '2026-11-20T10:00:00.000Z',
      updatedAt: '2026-11-20T10:00:00.000Z',
    } as never);
    s.store.seedEvents(
      runId,
      [0, 1, 2, 3].map((n) => event(runId, n)),
    );
    return { s, runId };
  }

  const ids = (body: string) => [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));

  it('streams text/event-stream with ids and ends when the run is terminal', async () => {
    const { s, runId } = await withRun('DELIVERED');
    const res = await s.app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/events`,
      headers: VIEWER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(ids(res.body)).toEqual([0, 1, 2, 3]);
    expect(res.body).toContain('event: state_changed');
    const first = /^data: (.*)$/m.exec(res.body)?.[1] ?? '';
    expect(JSON.parse(first)).toMatchObject({ runId, seq: 0, type: 'state_changed' });
  });

  it('replays only events after Last-Event-ID', async () => {
    const { s, runId } = await withRun('DELIVERED');
    const res = await s.app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/events`,
      headers: { ...VIEWER, 'last-event-id': '1' },
    });
    expect(ids(res.body)).toEqual([2, 3]);
  });

  it('prefers the `after` query over the header and rejects malformed resume ids', async () => {
    const { s, runId } = await withRun('DELIVERED');
    const res = await s.app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/events?after=2`,
      headers: { ...VIEWER, 'last-event-id': '0' },
    });
    expect(ids(res.body)).toEqual([3]);
    const bad = await s.app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/events`,
      headers: { ...VIEWER, 'last-event-id': 'x1' },
    });
    expect(bad.statusCode).toBe(400);
    const badQuery = await s.app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/events?after=-1`,
      headers: VIEWER,
    });
    expect(badQuery.statusCode).toBe(400);
  });

  it('keeps polling a live run and sends events appended later, then stops at the terminal state', async () => {
    const s = setup();
    const { project } = await createProject(s);
    const runId = '70000000-0000-4000-8000-000000000011';
    s.store.seedRun(ORG_A, {
      id: runId,
      projectId: project.id,
      specId: '70000000-0000-4000-8000-000000000012',
      planId: null,
      state: 'BUILDING',
      demo: false,
      faultInjection: null,
      repairAttempts: 0,
      createdAt: '2026-11-20T10:00:00.000Z',
      updatedAt: '2026-11-20T10:00:00.000Z',
    } as never);
    s.store.seedEvents(runId, [event(runId, 0)]);
    let polls = 0;
    const live = buildApiServer({
      executor: s.executor,
      store: s.store,
      runStore: s.runStore,
      newRequestId: () => '70000000-0000-4000-8000-0000000000ff',
      sleep: async () => {
        polls += 1;
        if (polls === 1) s.store.seedEvents(runId, [event(runId, 0), event(runId, 1)]);
        if (polls === 3) {
          s.store.seedEvents(runId, [event(runId, 0), event(runId, 1), event(runId, 2)]);
          s.store.seedRun(ORG_A, {
            id: runId,
            projectId: project.id,
            specId: '70000000-0000-4000-8000-000000000012',
            planId: null,
            state: 'DELIVERED',
            demo: false,
            faultInjection: null,
            repairAttempts: 0,
            createdAt: '2026-11-20T10:00:00.000Z',
            updatedAt: '2026-11-20T10:00:00.000Z',
          } as never);
        }
      },
    });
    const res = await live.app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/events`,
      headers: VIEWER,
    });
    expect(ids(res.body)).toEqual([0, 1, 2]);
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it('does not start a stream for another org, a viewer without runs.read, or no session', async () => {
    const { s, runId } = await withRun('DELIVERED');
    s.executor.sessions.set('nobody', { userId: USER_B, orgId: ORG_A, role: 'unknown-role' });
    const url = `/v1/runs/${runId}/events`;
    const foreign = await s.app.inject({ method: 'GET', url, headers: OTHER_ORG });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.headers['content-type']).not.toBe('text/event-stream');
    const unknownRole = await s.app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer nobody' },
    });
    expect(unknownRole.statusCode).toBe(403);
    const anon = await s.app.inject({ method: 'GET', url });
    expect(anon.statusCode).toBe(401);
  });
});
