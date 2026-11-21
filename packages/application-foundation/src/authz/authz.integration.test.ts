import { randomBytes, randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAuth, type Auth } from '../auth/auth.js';
import { createDb, createPool, deleteTestUsers } from '../db/test-db.js';
import { invitations } from '../orgs/schema.js';
import type { OrgId, UserId } from '../tenancy/ids.js';
import { ActionError, defineAction, type ActionDeps, type ActionResult } from './action.js';
import { defineOrgActions } from './org-actions.js';
import { defineAuthz } from './policy.js';

const BASE_URL = 'http://localhost:3000';
const PASSWORD = `pw-${randomBytes(12).toString('hex')}`;
const RUN = randomUUID().slice(0, 8);

const authz = defineAuthz({
  permissions: [
    'notes.read',
    'notes.write',
    'members.invite',
    'members.manage',
    'membership.leave',
    'org.transfer',
  ],
  roles: {
    owner: [
      'notes.read',
      'notes.write',
      'members.invite',
      'members.manage',
      'membership.leave',
      'org.transfer',
    ],
    admin: ['notes.read', 'notes.write', 'members.invite', 'members.manage', 'membership.leave'],
    member: ['notes.read', 'notes.write', 'membership.leave'],
    viewer: ['notes.read', 'membership.leave'],
  },
});
const actions = defineOrgActions(authz, {
  invite: 'members.invite',
  manage: 'members.manage',
  leave: 'membership.leave',
});

let pool: pg.Pool;
let db: NodePgDatabase;
let auth: Auth;
let deps: ActionDeps;
const userIds: string[] = [];
const orgIds: string[] = [];

/** Records whether a handler ran, so denial tests can prove it did not. */
let handlerCalls = 0;
const writeNote = defineAction(authz, {
  permission: 'notes.write',
  action: 'note.write',
  resourceType: 'note',
  input: z.strictObject({ text: z.string().min(1).max(100) }),
  handler: async (ctx, input) => {
    handlerCalls++;
    return { orgId: ctx.orgId, role: ctx.membership.role, text: input.text };
  },
});

interface Person {
  userId: UserId;
  email: string;
  headers: Headers;
}

async function signUp(label: string): Promise<Person> {
  const email = `${label}-${RUN}@example.test`;
  const created = await auth.api.signUpEmail({ body: { name: label, email, password: PASSWORD } });
  userIds.push(created.user.id);
  const response = await auth.handler(
    new Request(`${BASE_URL}/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE_URL,
        // A fresh client IP per sign-in, so repeated runs never hit the sign-in rate limit.
        'x-forwarded-for': `10.${randomBytes(3).join('.')}`,
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { userId: created.user.id as UserId, email, headers: new Headers({ cookie }) };
}

const req = (p: Person | null, input: unknown = {}) => ({
  headers: p?.headers ?? new Headers(),
  input,
  requestId: randomUUID(),
});

function value<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.value;
}

/** Creates an org owned by `owner` and makes it the owner's active org. */
async function orgOf(owner: Person, name: string): Promise<OrgId> {
  const { orgId, membershipId } = value(
    await actions.createOrganization(deps, req(owner, { name })),
  );
  orgIds.push(orgId);
  value(await actions.setActiveOrg(deps, req(owner, { membershipId })));
  return orgId;
}

/** Invites `who` into `owner`'s active org as `role`, then makes it `who`'s active org. */
async function join(owner: Person, who: Person, role: string): Promise<string> {
  const { token } = value(await actions.inviteMember(deps, req(owner, { role })));
  const { membershipId } = value(await actions.acceptInvitation(deps, req(who, { token })));
  value(await actions.setActiveOrg(deps, req(who, { membershipId })));
  return membershipId;
}

async function auditInOrg(orgId: string, requestId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const r = await client.query<{
      action: string;
      outcome: string;
      actor_id: string | null;
      resource_id: string | null;
    }>(
      'SELECT action, outcome, actor_id, resource_id FROM audit_events WHERE request_id = $1 ORDER BY created_at',
      [requestId],
    );
    await client.query('COMMIT');
    return r.rows;
  } finally {
    client.release();
  }
}

async function auditOfUser(userId: string, requestId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const r = await client.query<{ action: string; outcome: string }>(
      'SELECT action, outcome FROM audit_events WHERE request_id = $1',
      [requestId],
    );
    await client.query('COMMIT');
    return r.rows;
  } finally {
    client.release();
  }
}

beforeAll(() => {
  pool = createPool('app', 6);
  db = createDb(pool);
  auth = createAuth({
    db,
    secret: randomBytes(32).toString('hex'),
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    allowSignUp: true,
    log: () => undefined,
  });
  deps = { db, auth };
});

afterAll(async () => {
  for (const orgId of orgIds) {
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    await client.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await client.query('COMMIT');
    client.release();
  }
  await deleteTestUsers(pool, userIds);
  await pool?.end();
});

describe('defineAction pipeline', () => {
  it('without a session: unauthenticated, handler not run', async () => {
    const before = handlerCalls;
    const r = await writeNote(deps, req(null, { text: 'x' }));
    expect(r).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(handlerCalls).toBe(before);
  });

  it('with a forged cookie: unauthenticated', async () => {
    const forged = {
      headers: new Headers({
        cookie: `__Secure-lathe.session_token=${randomBytes(20).toString('hex')}`,
      }),
      input: { text: 'x' },
      requestId: randomUUID(),
    };
    expect(await writeNote(deps, forged)).toMatchObject({ ok: false, code: 'unauthenticated' });
  });

  it('signed in without an active org: forbidden and audited, handler not run', async () => {
    const ann = await signUp('noorg-ann');
    const before = handlerCalls;
    const r = req(ann, { text: 'x' });
    expect(await writeNote(deps, r)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(handlerCalls).toBe(before);
    expect(await auditOfUser(ann.userId, r.requestId)).toEqual([
      { action: 'note.write', outcome: 'denied' },
    ]);
  });

  it('member with the permission: runs in the active org and audits success', async () => {
    const ann = await signUp('ok-ann');
    const orgId = await orgOf(ann, 'OK');
    const r = req(ann, { text: 'hello' });
    expect(value(await writeNote(deps, r))).toEqual({ orgId, role: 'owner', text: 'hello' });
    expect(await auditInOrg(orgId, r.requestId)).toEqual([
      { action: 'note.write', outcome: 'success', actor_id: ann.userId, resource_id: null },
    ]);
  });

  it('role without the permission: forbidden and audited, handler not run', async () => {
    const ann = await signUp('deny-ann');
    const vic = await signUp('deny-vic');
    const orgId = await orgOf(ann, 'Deny');
    await join(ann, vic, 'viewer');
    const before = handlerCalls;
    const r = req(vic, { text: 'x' });
    expect(await writeNote(deps, r)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(handlerCalls).toBe(before);
    expect(await auditInOrg(orgId, r.requestId)).toEqual([
      { action: 'note.write', outcome: 'denied', actor_id: vic.userId, resource_id: null },
    ]);
  });

  it('a role the app does not know is denied everything', async () => {
    const ann = await signUp('ghost-ann');
    const gus = await signUp('ghost-gus');
    const orgId = await orgOf(ann, 'Ghost');
    const membershipId = await join(ann, gus, 'member');
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    await client.query("UPDATE memberships SET role = 'ghost' WHERE id = $1", [membershipId]);
    await client.query('COMMIT');
    client.release();
    expect(await writeNote(deps, req(gus, { text: 'x' }))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('a session pointing at an org the user left: not_found and audited', async () => {
    const ann = await signUp('stale-ann');
    const sam = await signUp('stale-sam');
    const orgId = await orgOf(ann, 'Stale');
    const samA = await orgOf(sam, 'Sam own');
    // Point Sam's session at Ann's org directly, as a stale or tampered row would.
    await pool.query('UPDATE sessions SET active_org_id = $1 WHERE user_id = $2', [
      orgId,
      sam.userId,
    ]);
    const before = handlerCalls;
    const r = req(sam, { text: 'x' });
    expect(await writeNote(deps, r)).toMatchObject({ ok: false, code: 'not_found' });
    expect(handlerCalls).toBe(before);
    expect(await auditInOrg(orgId, r.requestId)).toEqual([
      { action: 'note.write', outcome: 'denied', actor_id: sam.userId, resource_id: null },
    ]);
    expect(samA).not.toBe(orgId);
  });

  it('an orgId in the input is rejected, never used', async () => {
    const ann = await signUp('input-ann');
    const ben = await signUp('input-ben');
    await orgOf(ann, 'Input A');
    const other = await orgOf(ben, 'Input B');
    const before = handlerCalls;
    const r = await writeNote(deps, req(ann, { text: 'x', orgId: other }));
    expect(r).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(handlerCalls).toBe(before);
  });

  it('invalid input: validation_failed, handler not run', async () => {
    const ann = await signUp('val-ann');
    await orgOf(ann, 'Val');
    const before = handlerCalls;
    expect(await writeNote(deps, req(ann, { text: '' }))).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(handlerCalls).toBe(before);
  });

  it('a handler error rolls back its writes and is audited as a failure', async () => {
    const ann = await signUp('rb-ann');
    const orgId = await orgOf(ann, 'Rollback');
    const failing = defineAction(authz, {
      permission: 'members.invite',
      action: 'test.rollback',
      resourceType: 'invitation',
      input: z.strictObject({ kind: z.enum(['expected', 'bug']) }),
      handler: async (ctx, input) => {
        await ctx.tx.insert(invitations).values({
          orgId: ctx.orgId,
          role: 'member',
          tokenHash: 'a'.repeat(64),
          invitedBy: ctx.caller.userId,
          expiresAt: new Date(Date.now() + 60_000),
        });
        if (input.kind === 'expected') throw new ActionError('conflict', 'nope');
        throw new Error('bug');
      },
    });
    const r1 = req(ann, { kind: 'expected' });
    expect(await failing(deps, r1)).toMatchObject({ ok: false, code: 'conflict', message: 'nope' });
    const r2 = req(ann, { kind: 'bug' });
    await expect(failing(deps, r2)).rejects.toThrow('bug');
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const left = await client.query('SELECT 1 FROM invitations WHERE token_hash = $1', [
      'a'.repeat(64),
    ]);
    await client.query('COMMIT');
    client.release();
    expect(left.rows).toEqual([]);
    expect(await auditInOrg(orgId, r1.requestId)).toMatchObject([
      { action: 'test.rollback', outcome: 'failure' },
    ]);
    expect(await auditInOrg(orgId, r2.requestId)).toMatchObject([
      { action: 'test.rollback', outcome: 'failure' },
    ]);
  });

  it('refuses a request id that is not a UUID', async () => {
    await expect(
      writeNote(deps, { headers: new Headers(), input: {}, requestId: 'client-chosen' }),
    ).rejects.toThrow('requestId');
  });
});

describe('org actions', () => {
  it('end to end: create org, invite, accept, switch, me', async () => {
    const ann = await signUp('e2e-ann');
    const ben = await signUp('e2e-ben');
    const orgId = await orgOf(ann, 'E2E');
    await join(ann, ben, 'member');
    const me = value(await actions.getMe(deps, req(ben)));
    expect(me.activeOrgId).toBe(orgId);
    expect(me.permissions).toEqual(['notes.read', 'notes.write', 'membership.leave']);
    expect(me.memberships.map((m) => m.role)).toEqual(['member']);
    expect(me.user.email).toBe(ben.email);
  });

  it('getMe has no permissions without an active org', async () => {
    const zoe = await signUp('me-zoe');
    const me = value(await actions.getMe(deps, req(zoe)));
    expect(me).toMatchObject({ activeOrgId: null, permissions: [], memberships: [] });
  });

  it('a viewer cannot invite', async () => {
    const ann = await signUp('vinv-ann');
    const vic = await signUp('vinv-vic');
    await orgOf(ann, 'VInv');
    await join(ann, vic, 'viewer');
    expect(await actions.inviteMember(deps, req(vic, { role: 'viewer' }))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('an admin cannot invite an owner, promote anyone to owner, or touch the owner', async () => {
    const ann = await signUp('esc-ann');
    const adi = await signUp('esc-adi');
    const orgId = await orgOf(ann, 'Esc');
    const adiMembership = await join(ann, adi, 'admin');
    const annMembership = value(await actions.getMe(deps, req(ann))).memberships[0]?.membershipId;

    expect(await actions.inviteMember(deps, req(adi, { role: 'owner' }))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    const self = req(adi, { membershipId: adiMembership, role: 'owner' });
    expect(await actions.changeMemberRole(deps, self)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(
      await actions.changeMemberRole(
        deps,
        req(adi, { membershipId: annMembership, role: 'viewer' }),
      ),
    ).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(
      await actions.removeMember(deps, req(adi, { membershipId: annMembership })),
    ).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(await auditInOrg(orgId, self.requestId)).toMatchObject([{ outcome: 'denied' }]);
    // The admin can still manage roles at or below their own.
    expect(
      value(await actions.inviteMember(deps, req(adi, { role: 'member' }))).token,
    ).toHaveLength(43);
  });

  it('an unknown role cannot be invited', async () => {
    const ann = await signUp('unk-ann');
    await orgOf(ann, 'Unk');
    expect(await actions.inviteMember(deps, req(ann, { role: 'superuser' }))).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
  });

  it('cannot change a membership of another org by id', async () => {
    const ann = await signUp('xo-ann');
    const ben = await signUp('xo-ben');
    const cat = await signUp('xo-cat');
    await orgOf(ann, 'XO A');
    await orgOf(ben, 'XO B');
    const catInB = await join(ben, cat, 'member');
    expect(
      await actions.changeMemberRole(deps, req(ann, { membershipId: catInB, role: 'viewer' })),
    ).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('a member can leave; the last owner cannot', async () => {
    const ann = await signUp('leave-ann');
    const ben = await signUp('leave-ben');
    await orgOf(ann, 'Leave');
    await join(ann, ben, 'member');
    value(await actions.leaveOrganization(deps, req(ben)));
    expect(value(await actions.getMe(deps, req(ben)))).toMatchObject({
      activeOrgId: null,
      memberships: [],
    });
    expect(await actions.leaveOrganization(deps, req(ann))).toMatchObject({
      ok: false,
      code: 'conflict',
    });
  });

  it('a removed member loses access on the next request', async () => {
    const ann = await signUp('rm-ann');
    const ben = await signUp('rm-ben');
    await orgOf(ann, 'Rm');
    const benMembership = await join(ann, ben, 'member');
    value(await writeNote(deps, req(ben, { text: 'before' })));
    value(await actions.removeMember(deps, req(ann, { membershipId: benMembership })));
    expect(await writeNote(deps, req(ben, { text: 'after' }))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('setActiveOrg refuses someone else\u2019s membership', async () => {
    const ann = await signUp('sw-ann');
    const ben = await signUp('sw-ben');
    await orgOf(ann, 'Sw');
    const annMembership = value(await actions.getMe(deps, req(ann))).memberships[0]?.membershipId;
    expect(
      await actions.setActiveOrg(deps, req(ben, { membershipId: annMembership })),
    ).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});
