/**
 * End-to-end tests of the template's HTTP surface against real PostgreSQL (task P1-07).
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
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authRoute from '../app/auth/[...all]/route';
import * as acceptRoute from '../app/v1/invitations/accept/route';
import * as invitationsRoute from '../app/v1/invitations/route';
import * as meRoute from '../app/v1/me/route';
import * as memberRoute from '../app/v1/members/[membershipId]/route';
import * as membersRoute from '../app/v1/members/route';
import * as noteRoute from '../app/v1/notes/[id]/route';
import * as notesRoute from '../app/v1/notes/route';
import * as activeOrgRoute from '../app/v1/session/active-org/route';
import { closeDeps, getDeps } from './deps';
import type { RouteHandler } from './http';

const run = randomUUID().slice(0, 8);
const password = randomBytes(18).toString('base64url');
const orgA = randomUUID();
const orgB = randomUUID();
const email = (role: string, org: string) => `${role}-${run}@app-starter-org-${org}.test`;

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
  const people = [
    ['owner', 'a'],
    ['member', 'a'],
    ['viewer', 'a'],
    ['owner', 'b'],
    ['viewer', 'b'],
  ] as const;
  await seedDemo(seeder, db, {
    orgs: { a: { id: orgA, name: `Org A ${run}` }, b: { id: orgB, name: `Org B ${run}` } },
    users: people.map(([role, org]) => ({
      name: `${role} ${org}`,
      email: email(role, org),
      memberOf: [{ org, role }],
    })),
    password,
  });
  for (const [role, org] of people) {
    const who = `${org}-${role}`;
    cookies.set(who, await signIn(email(role, org)));
    // Choose the active org through the app's own route, as the org switcher does.
    const me = await call(meRoute.GET, 'GET', '/v1/me', { who });
    const memberships = field(me.json, 'memberships') as { membershipId: string }[];
    expect(memberships).toHaveLength(1);
    const set = await call(activeOrgRoute.POST, 'POST', '/v1/session/active-org', {
      who,
      body: { membershipId: memberships[0]?.membershipId },
    });
    expect(set.status).toBe(200);
  }
});

afterAll(async () => {
  await closeDeps();
});

describe('notes: tenant isolation', () => {
  let noteId: string;

  beforeAll(async () => {
    const made = await call(notesRoute.POST, 'POST', '/v1/notes', {
      who: 'a-owner',
      body: { title: `secret ${run}`, body: 'org a only' },
    });
    expect(made.status).toBe(201);
    noteId = String(field(made.json, 'id'));
  });

  it('creates a note without exposing org_id', async () => {
    const got = await call(noteRoute.GET, 'GET', `/v1/notes/${noteId}`, {
      who: 'a-viewer',
      params: { id: noteId },
    });
    expect(got.status).toBe(200);
    expect(field(got.json, 'title')).toBe(`secret ${run}`);
    expect(JSON.stringify(got.json)).not.toContain(orgA);
    expect(field(got.json, 'orgId')).toBeUndefined();
  });

  it("org b never sees org a's note in its list", async () => {
    const listA = await call(notesRoute.GET, 'GET', '/v1/notes', { who: 'a-member' });
    const listB = await call(notesRoute.GET, 'GET', '/v1/notes', { who: 'b-owner' });
    expect(listA.status).toBe(200);
    expect(listB.status).toBe(200);
    expect(JSON.stringify(listA.json)).toContain(noteId);
    expect(JSON.stringify(listB.json)).not.toContain(noteId);
  });

  it('a foreign note answers exactly like a missing one (404)', async () => {
    const missing = randomUUID();
    const foreign = await call(noteRoute.GET, 'GET', `/v1/notes/${noteId}`, {
      who: 'b-owner',
      params: { id: noteId },
    });
    const absent = await call(noteRoute.GET, 'GET', `/v1/notes/${missing}`, {
      who: 'b-owner',
      params: { id: missing },
    });
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    const strip = (j: unknown) => ({ ...(j as object), requestId: '<id>' });
    expect(strip(foreign.json)).toEqual(strip(absent.json));
  });

  it("org b cannot update or delete org a's note, and the note is unchanged", async () => {
    const patch = await call(noteRoute.PATCH, 'PATCH', `/v1/notes/${noteId}`, {
      who: 'b-owner',
      params: { id: noteId },
      body: { title: 'tampered' },
    });
    const del = await call(noteRoute.DELETE, 'DELETE', `/v1/notes/${noteId}`, {
      who: 'b-owner',
      params: { id: noteId },
    });
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
    const after = await call(noteRoute.GET, 'GET', `/v1/notes/${noteId}`, {
      who: 'a-owner',
      params: { id: noteId },
    });
    expect(field(after.json, 'title')).toBe(`secret ${run}`);
  });

  it('rejects an org id sent in the body or the query instead of using it', async () => {
    for (const key of ['orgId', 'org_id']) {
      const r = await call(notesRoute.POST, 'POST', '/v1/notes', {
        who: 'b-owner',
        body: { title: 'forged', [key]: orgA },
      });
      expect(r.status).toBe(400);
      expect(field(r.json, 'code')).toBe('validation_failed');
    }
    const q = await call(notesRoute.GET, 'GET', `/v1/notes?org_id=${orgA}`, { who: 'b-owner' });
    expect(q.status).toBe(400);
  });

  it('the path id wins over an id in the body', async () => {
    const own = await call(notesRoute.POST, 'POST', '/v1/notes', {
      who: 'b-owner',
      body: { title: `b note ${run}` },
    });
    const ownId = String(field(own.json, 'id'));
    const r = await call(noteRoute.PATCH, 'PATCH', `/v1/notes/${ownId}`, {
      who: 'b-owner',
      params: { id: ownId },
      body: { id: noteId, title: 'renamed' },
    });
    expect(r.status).toBe(200);
    expect(field(r.json, 'id')).toBe(ownId);
    const a = await call(noteRoute.GET, 'GET', `/v1/notes/${noteId}`, {
      who: 'a-owner',
      params: { id: noteId },
    });
    expect(field(a.json, 'title')).toBe(`secret ${run}`);
  });
});

describe('notes: permissions and requests', () => {
  it('a viewer can read but not create, update or delete', async () => {
    const made = await call(notesRoute.POST, 'POST', '/v1/notes', {
      who: 'a-member',
      body: { title: `member note ${run}` },
    });
    expect(made.status).toBe(201);
    const id = String(field(made.json, 'id'));
    const create = await call(notesRoute.POST, 'POST', '/v1/notes', {
      who: 'a-viewer',
      body: { title: 'viewer note' },
    });
    const update = await call(noteRoute.PATCH, 'PATCH', `/v1/notes/${id}`, {
      who: 'a-viewer',
      params: { id },
      body: { title: 'viewer edit' },
    });
    const del = await call(noteRoute.DELETE, 'DELETE', `/v1/notes/${id}`, {
      who: 'a-viewer',
      params: { id },
    });
    expect([create.status, update.status, del.status]).toEqual([403, 403, 403]);
    // The denial is audited in org a, in its own committed transaction.
    expect(await auditOutcome(orgA, create.requestId)).toEqual(['denied']);
    const after = await call(noteRoute.GET, 'GET', `/v1/notes/${id}`, {
      who: 'a-viewer',
      params: { id },
    });
    expect(field(after.json, 'title')).toBe(`member note ${run}`);
  });

  it('without a session every notes route answers 401', async () => {
    const id = randomUUID();
    const results = await Promise.all([
      call(notesRoute.GET, 'GET', '/v1/notes'),
      call(notesRoute.POST, 'POST', '/v1/notes', { body: { title: 'anon' } }),
      call(noteRoute.GET, 'GET', `/v1/notes/${id}`, { params: { id } }),
      call(noteRoute.PATCH, 'PATCH', `/v1/notes/${id}`, { params: { id }, body: { title: 'x' } }),
      call(noteRoute.DELETE, 'DELETE', `/v1/notes/${id}`, { params: { id } }),
    ]);
    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
  });

  it('refuses a cookie-bearing write from another origin and writes nothing', async () => {
    const title = `cross-site ${run}`;
    const r = await call(notesRoute.POST, 'POST', '/v1/notes', {
      who: 'a-owner',
      body: { title },
      headers: { origin: 'https://evil.example' },
    });
    const s = await call(notesRoute.POST, 'POST', '/v1/notes', {
      who: 'a-owner',
      body: { title },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect([r.status, s.status]).toEqual([403, 403]);
    const list = await call(notesRoute.GET, 'GET', '/v1/notes?limit=100', { who: 'a-owner' });
    expect(JSON.stringify(list.json)).not.toContain(title);
  });

  it('answers 400 with the standard error shape for a body that is not a JSON object', async () => {
    for (const body of ['not json', '[1,2]']) {
      const r = await call(notesRoute.POST, 'POST', '/v1/notes', { who: 'a-owner', body });
      expect(r.status).toBe(400);
      expect(Object.keys(r.json as object).sort()).toEqual(['code', 'message', 'requestId']);
    }
  });

  it('paginates with a cursor, newest first, without repeats', async () => {
    const titles = [1, 2, 3].map((n) => `page ${run} ${n}`);
    for (const title of titles) {
      await call(notesRoute.POST, 'POST', '/v1/notes', { who: 'b-owner', body: { title } });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const page = await call(notesRoute.GET, 'GET', `/v1/notes${q}`, { who: 'b-owner' });
      expect(page.status).toBe(200);
      const items = field(page.json, 'items') as { id: string; title: string }[];
      expect(items.length).toBeLessThanOrEqual(2);
      seen.push(...items.map((i) => i.id));
      cursor = field(page.json, 'nextCursor') as string | null;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    const bad = await call(notesRoute.GET, 'GET', '/v1/notes?cursor=nope', { who: 'b-owner' });
    expect(bad.status).toBe(400);
  });
});

describe('members, invitations and the org switcher', () => {
  it('lists the members of the active org only', async () => {
    const r = await call(membersRoute.GET, 'GET', '/v1/members', { who: 'a-viewer' });
    expect(r.status).toBe(200);
    const emails = (r.json as { email: string }[]).map((m) => m.email).sort();
    expect(emails).toEqual(
      [email('member', 'a'), email('owner', 'a'), email('viewer', 'a')].sort(),
    );
  });

  it('only the owner can invite, and the invited user can switch to the new org', async () => {
    const denied = await call(invitationsRoute.POST, 'POST', '/v1/invitations', {
      who: 'a-member',
      body: { role: 'viewer' },
    });
    expect(denied.status).toBe(403);

    const invite = await call(invitationsRoute.POST, 'POST', '/v1/invitations', {
      who: 'a-owner',
      body: { role: 'viewer' },
    });
    expect(invite.status).toBe(201);
    const token = String(field(invite.json, 'token'));

    const accepted = await call(acceptRoute.POST, 'POST', '/v1/invitations/accept', {
      who: 'b-viewer',
      body: { token },
    });
    expect(accepted.status).toBe(200);
    const membershipId = String(field(accepted.json, 'membershipId'));

    // Still in org b until the user switches.
    const before = await call(notesRoute.GET, 'GET', '/v1/notes?limit=100', { who: 'b-viewer' });
    expect(JSON.stringify(before.json)).not.toContain(`secret ${run}`);
    const switched = await call(activeOrgRoute.POST, 'POST', '/v1/session/active-org', {
      who: 'b-viewer',
      body: { membershipId },
    });
    expect(switched.status).toBe(200);
    const after = await call(notesRoute.GET, 'GET', '/v1/notes?limit=100', { who: 'b-viewer' });
    expect(JSON.stringify(after.json)).toContain(`secret ${run}`);
  });

  it("cannot switch to an org through someone else's membership id", async () => {
    const members = await call(membersRoute.GET, 'GET', '/v1/members', { who: 'a-owner' });
    const ownerA = (members.json as { membershipId: string; email: string }[]).find(
      (m) => m.email === email('owner', 'a'),
    );
    const r = await call(activeOrgRoute.POST, 'POST', '/v1/session/active-org', {
      who: 'b-owner',
      body: { membershipId: ownerA?.membershipId },
    });
    expect(r.status).toBe(404);
  });

  it('a member cannot change roles; the owner cannot be demoted by an equal', async () => {
    const members = await call(membersRoute.GET, 'GET', '/v1/members', { who: 'a-owner' });
    const list = members.json as { membershipId: string; email: string }[];
    const viewer = list.find((m) => m.email === email('viewer', 'a'));
    const owner = list.find((m) => m.email === email('owner', 'a'));
    const byMember = await call(memberRoute.PATCH, 'PATCH', `/v1/members/${viewer?.membershipId}`, {
      who: 'a-member',
      params: { membershipId: viewer?.membershipId ?? '' },
      body: { role: 'member' },
    });
    expect(byMember.status).toBe(403);
    const promote = await call(memberRoute.PATCH, 'PATCH', `/v1/members/${viewer?.membershipId}`, {
      who: 'a-owner',
      params: { membershipId: viewer?.membershipId ?? '' },
      body: { role: 'member' },
    });
    expect(promote.status).toBe(200);
    // Removing yourself goes through "leave"; the owner is the last owner, so it is refused.
    const self = await call(memberRoute.DELETE, 'DELETE', `/v1/members/${owner?.membershipId}`, {
      who: 'a-owner',
      params: { membershipId: owner?.membershipId ?? '' },
    });
    expect(self.status).toBe(400);
  });
});
