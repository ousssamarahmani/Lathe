/**
 * HTTP-level tests of Support Desk against real PostgreSQL (task P6-01).
 * Requests go through the real route handlers, Better Auth sign-in, `defineAction`,
 * RLS and audit. Only the Next.js server itself is not involved.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  auditEvents,
  createAuth,
  parseOrgId,
  seedDemo,
  withTenant,
} from '@lathe/application-foundation';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authRoute from '../app/auth/[...all]/route';
import * as acceptRoute from '../app/v1/invitations/accept/route';
import * as invitationsRoute from '../app/v1/invitations/route';
import * as meRoute from '../app/v1/me/route';
import * as memberRoute from '../app/v1/members/[membershipId]/route';
import * as membersRoute from '../app/v1/members/route';
import * as activeOrgRoute from '../app/v1/session/active-org/route';
import * as assignRoute from '../app/v1/tickets/[id]/assign/route';
import * as commentsRoute from '../app/v1/tickets/[id]/comments/route';
import * as ticketRoute from '../app/v1/tickets/[id]/route';
import * as ticketsRoute from '../app/v1/tickets/route';
import { closeDeps, getDeps } from './deps';
import type { RouteHandler } from './http';

const run = randomUUID().slice(0, 8);
const password = randomBytes(18).toString('base64url');
const orgA = randomUUID();
const orgB = randomUUID();
const email = (role: string, org: string) => `${role}-${run}@support-desk-org-${org}.test`;

let base: string;
const cookies = new Map<string, string>();

async function signIn(who: string): Promise<string> {
  const res = await authRoute.POST(
    new Request(`${base}/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        // A random client address per sign-in, so repeated runs never hit the sign-in rate limit.
        'x-forwarded-for': `10.${randomBytes(3).join('.')}`,
      },
      body: JSON.stringify({ email: who, password }),
    }),
  );
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((c) => c.length > 0)
    .join('; ');
  expect(cookie).toContain('session_token');
  return cookie;
}

interface Call {
  readonly status: number;
  readonly json: unknown;
  readonly requestId: string | null;
}

async function call(
  handler: RouteHandler,
  method: string,
  path: string,
  options: {
    who?: string | null;
    body?: unknown;
    params?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Promise<Call> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.who) headers['cookie'] = cookies.get(options.who) ?? '';
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers['content-type'] ??= 'application/json';
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  // Like Next.js: dynamic routes get params, static routes get a context without params.
  const context = options.params
    ? { params: Promise.resolve(options.params) }
    : { params: Promise.resolve(undefined) };
  const res = await handler(new Request(`${base}${path}`, init), context);
  const text = await res.text();
  return {
    status: res.status,
    json: text === '' ? undefined : JSON.parse(text),
    requestId: res.headers.get('x-request-id'),
  };
}

const field = (json: unknown, key: string): unknown =>
  typeof json === 'object' && json !== null ? (json as Record<string, unknown>)[key] : undefined;

async function auditOutcome(orgId: string, requestId: string | null): Promise<string[]> {
  if (!requestId) return [];
  const rows = await withTenant(getDeps().db, parseOrgId(orgId), (tx) =>
    tx
      .select({ outcome: auditEvents.outcome })
      .from(auditEvents)
      .where(eq(auditEvents.requestId, requestId)),
  );
  return rows.map((r) => r.outcome);
}

/** Who is in which org with which role. Keys are `<org>-<label>`. */
const PEOPLE = [
  ['owner', 'a', 'owner'],
  ['admin', 'a', 'admin'],
  ['agent', 'a', 'agent'],
  ['agent2', 'a', 'agent'],
  ['req', 'a', 'requester'],
  ['req2', 'a', 'requester'],
  ['owner', 'b', 'owner'],
  ['agent', 'b', 'agent'],
  ['req', 'b', 'requester'],
] as const;
const membershipOf = new Map<string, string>();

beforeAll(async () => {
  base = getDeps().baseUrl;
  const { db } = getDeps();
  // A separate auth instance with sign-up open, used only to create the test users.
  const seeder = createAuth({
    db,
    secret: randomBytes(32).toString('base64url'),
    baseURL: base,
    trustedOrigins: [base],
    allowSignUp: true,
  });
  await seedDemo(seeder, db, {
    orgs: { a: { id: orgA, name: `Org A ${run}` }, b: { id: orgB, name: `Org B ${run}` } },
    users: PEOPLE.map(([label, org, role]) => ({
      name: `${label} ${org}`,
      email: email(label, org),
      memberOf: [{ org, role }],
    })),
    password,
  });
  for (const [label, org] of PEOPLE) {
    const who = `${org}-${label}`;
    cookies.set(who, await signIn(email(label, org)));
    const me = await call(meRoute.GET, 'GET', '/v1/me', { who });
    const memberships = field(me.json, 'memberships') as { membershipId: string }[];
    expect(memberships).toHaveLength(1);
    const membershipId = memberships[0]?.membershipId ?? '';
    membershipOf.set(who, membershipId);
    const set = await call(activeOrgRoute.POST, 'POST', '/v1/session/active-org', {
      who,
      body: { membershipId },
    });
    expect(set.status).toBe(200);
  }
});

afterAll(async () => {
  await closeDeps();
});

const open = async (who: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await call(ticketsRoute.POST, 'POST', '/v1/tickets', {
    who,
    body: { title, body: 'details', ...extra },
  });
  expect(r.status, `${who} opens ${title}`).toBe(201);
  return String(field(r.json, 'id'));
};
const get = (who: string, id: string) =>
  call(ticketRoute.GET, 'GET', `/v1/tickets/${id}`, { who, params: { id } });
const patch = (who: string, id: string, body: Record<string, unknown>) =>
  call(ticketRoute.PATCH, 'PATCH', `/v1/tickets/${id}`, { who, params: { id }, body });
const assign = (who: string, id: string, membershipId: string | null) =>
  call(assignRoute.POST, 'POST', `/v1/tickets/${id}/assign`, {
    who,
    params: { id },
    body: { membershipId },
  });
const comments = (who: string, id: string) =>
  call(commentsRoute.GET, 'GET', `/v1/tickets/${id}/comments`, { who, params: { id } });
const comment = (who: string, id: string, body: Record<string, unknown>) =>
  call(commentsRoute.POST, 'POST', `/v1/tickets/${id}/comments`, { who, params: { id }, body });
const list = async (who: string, query = '?limit=100') => {
  const r = await call(ticketsRoute.GET, 'GET', `/v1/tickets${query}`, { who });
  expect(r.status).toBe(200);
  return (field(r.json, 'items') as { id: string }[]).map((t) => t.id);
};
const strip = (j: unknown) => ({ ...(j as object), requestId: '<id>' });

describe('tenant isolation between orgs', () => {
  let ticket: string;
  beforeAll(async () => {
    ticket = await open('a-req', `printer ${run}`);
  });

  it('a ticket answers without any org id', async () => {
    const r = await get('a-agent', ticket);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain(orgA);
  });

  it("org b staff get exactly the 'does not exist' answer for org a's ticket, on every route", async () => {
    const missing = randomUUID();
    const foreign = await get('b-owner', ticket);
    const absent = await get('b-owner', missing);
    expect([foreign.status, absent.status]).toEqual([404, 404]);
    expect(strip(foreign.json)).toEqual(strip(absent.json));
    const statuses = [
      (await patch('b-agent', ticket, { title: 'tampered' })).status,
      (await assign('b-agent', ticket, membershipOf.get('b-agent') ?? null)).status,
      (await comments('b-agent', ticket)).status,
      (await comment('b-agent', ticket, { body: 'from b' })).status,
    ];
    expect(statuses).toEqual([404, 404, 404, 404]);
    expect(await list('b-owner')).not.toContain(ticket);
    const after = await get('a-agent', ticket);
    expect(field(after.json, 'title')).toBe(`printer ${run}`);
  });

  it('an org id in the body is rejected, never used', async () => {
    for (const key of ['orgId', 'org_id']) {
      const r = await call(ticketsRoute.POST, 'POST', '/v1/tickets', {
        who: 'b-req',
        body: { title: 'forged', [key]: orgA },
      });
      expect(r.status).toBe(400);
    }
  });

  it("a ticket cannot be assigned to another org's member", async () => {
    const r = await assign('a-agent', ticket, membershipOf.get('b-agent') ?? null);
    expect(r.status).toBe(404);
  });

  it('without a session every ticket route answers 401', async () => {
    const id = randomUUID();
    const p = { params: { id } };
    const results = await Promise.all([
      call(ticketsRoute.GET, 'GET', '/v1/tickets'),
      call(ticketsRoute.POST, 'POST', '/v1/tickets', { body: { title: 'anon' } }),
      call(ticketRoute.GET, 'GET', `/v1/tickets/${id}`, p),
      call(ticketRoute.PATCH, 'PATCH', `/v1/tickets/${id}`, { ...p, body: { title: 'x' } }),
      call(assignRoute.POST, 'POST', `/v1/tickets/${id}/assign`, {
        ...p,
        body: { membershipId: null },
      }),
      call(commentsRoute.GET, 'GET', `/v1/tickets/${id}/comments`, p),
      call(commentsRoute.POST, 'POST', `/v1/tickets/${id}/comments`, { ...p, body: { body: 'x' } }),
    ]);
    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401]);
  });
});

describe('requesters see only their own tickets', () => {
  let mine: string;
  let theirs: string;
  beforeAll(async () => {
    mine = await open('a-req', `mine ${run}`);
    theirs = await open('a-req2', `theirs ${run}`);
  });

  it("another requester's ticket in the same org is 404 on every route, like a missing one", async () => {
    expect((await get('a-req', theirs)).status).toBe(404);
    expect((await patch('a-req', theirs, { title: 'x' })).status).toBe(404);
    expect((await comments('a-req', theirs)).status).toBe(404);
    expect((await comment('a-req', theirs, { body: 'x' })).status).toBe(404);
    const ids = await list('a-req');
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it('staff see every ticket of the org', async () => {
    for (const who of ['a-agent', 'a-admin', 'a-owner']) {
      const ids = await list(who);
      expect(ids, who).toEqual(expect.arrayContaining([mine, theirs]));
    }
  });

  it('a requester edits the text of their ticket, but not status or priority', async () => {
    expect((await patch('a-req', mine, { title: `mine edited ${run}` })).status).toBe(200);
    expect((await patch('a-req', mine, { status: 'resolved' })).status).toBe(403);
    expect((await patch('a-req', mine, { priority: 'urgent' })).status).toBe(403);
    const r = await call(ticketsRoute.POST, 'POST', '/v1/tickets', {
      who: 'a-req',
      body: { title: 'urgent!!', priority: 'urgent' },
    });
    expect(r.status).toBe(403);
    expect(field((await get('a-req', mine)).json, 'status')).toBe('open');
  });
});

describe('triage, assignment and the ticket life cycle', () => {
  let ticket: string;
  beforeAll(async () => {
    ticket = await open('a-req', `vpn ${run}`);
  });

  it('a requester cannot assign, and the denial is audited', async () => {
    const r = await assign('a-req', ticket, membershipOf.get('a-agent') ?? null);
    expect(r.status).toBe(403);
    expect(await auditOutcome(orgA, r.requestId)).toEqual(['denied']);
  });

  it('staff assign to staff only, and can unassign', async () => {
    const ok = await assign('a-agent', ticket, membershipOf.get('a-agent2') ?? null);
    expect(ok.status).toBe(200);
    expect(field(ok.json, 'assigneeMembershipId')).toBe(membershipOf.get('a-agent2'));
    const toRequester = await assign('a-agent', ticket, membershipOf.get('a-req2') ?? null);
    expect(toRequester.status).toBe(400);
    const unknown = await assign('a-agent', ticket, randomUUID());
    expect(unknown.status).toBe(404);
    expect(await list('a-agent2', '?assignee=me&limit=100')).toContain(ticket);
    expect(await list('a-agent', '?assignee=me&limit=100')).not.toContain(ticket);
    const none = await assign('a-admin', ticket, null);
    expect(field(none.json, 'assigneeMembershipId')).toBeNull();
  });

  it('closing sets closedAt; a closed ticket takes no replies or edits until reopened', async () => {
    const closed = await patch('a-agent', ticket, { status: 'closed' });
    expect(closed.status).toBe(200);
    expect(field(closed.json, 'closedAt')).toEqual(expect.any(String));
    expect((await comment('a-req', ticket, { body: 'still broken' })).status).toBe(409);
    expect((await patch('a-req', ticket, { title: 'x' })).status).toBe(409);
    expect((await patch('a-agent', ticket, { priority: 'high' })).status).toBe(409);
    const reopened = await patch('a-agent', ticket, { status: 'open' });
    expect(reopened.status).toBe(200);
    expect(field(reopened.json, 'closedAt')).toBeNull();
  });

  it('rejects unknown status and priority values', async () => {
    expect((await patch('a-agent', ticket, { status: 'deleted' })).status).toBe(400);
    expect((await patch('a-agent', ticket, { priority: 'p0' })).status).toBe(400);
  });
});

describe('comments and internal notes', () => {
  let ticket: string;
  beforeAll(async () => {
    ticket = await open('a-req', `mail ${run}`);
  });

  it('requester and staff reply; internal notes are hidden from the requester', async () => {
    expect((await comment('a-req', ticket, { body: 'any news?' })).status).toBe(201);
    expect((await comment('a-agent', ticket, { body: 'on it' })).status).toBe(201);
    const note = await comment('a-agent', ticket, { body: `secret note ${run}`, internal: true });
    expect(note.status).toBe(201);

    const forRequester = await comments('a-req', ticket);
    const forAgent = await comments('a-agent', ticket);
    expect((forRequester.json as unknown[]).length).toBe(2);
    expect(JSON.stringify(forRequester.json)).not.toContain(`secret note ${run}`);
    expect((forAgent.json as unknown[]).length).toBe(3);
  });

  it('a requester cannot write an internal note', async () => {
    const r = await comment('a-req', ticket, { body: 'sneaky', internal: true });
    expect(r.status).toBe(403);
    expect(JSON.stringify((await comments('a-agent', ticket)).json)).not.toContain('sneaky');
  });
});

describe('members', () => {
  it('admin and owner invite; agents and requesters cannot', async () => {
    const codes = [];
    for (const who of ['a-owner', 'a-admin', 'a-agent', 'a-req']) {
      codes.push(
        (
          await call(invitationsRoute.POST, 'POST', '/v1/invitations', {
            who,
            body: { role: 'requester' },
          })
        ).status,
      );
    }
    expect(codes).toEqual([201, 201, 403, 403]);
  });

  it('an admin cannot invite an owner, and only the owner changes roles', async () => {
    const owner = await call(invitationsRoute.POST, 'POST', '/v1/invitations', {
      who: 'a-admin',
      body: { role: 'owner' },
    });
    expect(owner.status).toBe(403);
    const target = membershipOf.get('a-req2') ?? '';
    const byAdmin = await call(memberRoute.PATCH, 'PATCH', `/v1/members/${target}`, {
      who: 'a-admin',
      params: { membershipId: target },
      body: { role: 'agent' },
    });
    expect(byAdmin.status).toBe(403);
  });

  it('an invited requester joins with that role and sees no other tickets', async () => {
    const inv = await call(invitationsRoute.POST, 'POST', '/v1/invitations', {
      who: 'a-admin',
      body: { role: 'requester' },
    });
    const token = String(field(inv.json, 'token'));
    const joined = await call(acceptRoute.POST, 'POST', '/v1/invitations/accept', {
      who: 'b-req',
      body: { token },
    });
    expect(joined.status).toBe(200);
    const membershipId = String(field(joined.json, 'membershipId'));
    await call(activeOrgRoute.POST, 'POST', '/v1/session/active-org', {
      who: 'b-req',
      body: { membershipId },
    });
    expect(await list('b-req')).toEqual([]);
    const members = await call(membersRoute.GET, 'GET', '/v1/members', { who: 'b-req' });
    expect(members.status).toBe(403);
  });
});

describe('database guarantees (hold even if application code is wrong)', () => {
  it('the app role can neither delete tickets nor edit or delete comments', async () => {
    const id = await open('a-req', `db ${run}`);
    await comment('a-req', id, { body: 'record' });
    const { db } = getDeps();
    const tryAs = async (statement: ReturnType<typeof sql>) => {
      try {
        await withTenant(db, parseOrgId(orgA), (tx) => tx.execute(statement));
        return 'allowed';
      } catch (error) {
        for (let e: unknown = error; e instanceof Error; e = e.cause) {
          const code = (e as { code?: unknown }).code;
          if (typeof code === 'string') return code;
        }
        throw error;
      }
    };
    expect(await tryAs(sql`DELETE FROM tickets WHERE id = ${id}`)).toBe('42501');
    expect(await tryAs(sql`UPDATE ticket_comments SET body = 'x' WHERE ticket_id = ${id}`)).toBe(
      '42501',
    );
    expect(await tryAs(sql`DELETE FROM ticket_comments WHERE ticket_id = ${id}`)).toBe('42501');
  });

  it("a comment cannot point at another org's ticket", async () => {
    const id = await open('a-req', `fk ${run}`);
    const { db } = getDeps();
    let code = 'allowed';
    try {
      await withTenant(db, parseOrgId(orgB), (tx) =>
        tx.execute(
          sql`INSERT INTO ticket_comments (org_id, ticket_id, author_id, body)
              SELECT ${orgB}, ${id}, id, 'x' FROM users LIMIT 1`,
        ),
      );
    } catch (error) {
      for (let e: unknown = error; e instanceof Error; e = e.cause) {
        const c = (e as { code?: unknown }).code;
        if (typeof c === 'string') code = c;
      }
    }
    expect(code).toBe('23503');
  });
});
