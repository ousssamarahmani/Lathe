import { randomBytes, randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, createTestUser, deleteTestUsers } from '../db/test-db.js';
import type { OrgId, UserId } from '../tenancy/ids.js';
import { OrgError, type OrgErrorCode } from './errors.js';
import { hashInviteToken } from './invite-token.js';
import {
  acceptInvitation,
  changeRole,
  createInvitation,
  createOrganization,
  listMyMemberships,
  removeMember,
  setActiveOrg,
  type Caller,
  type OrgDeps,
} from './orgs.js';

let pool: pg.Pool;
let db: NodePgDatabase;
let deps: OrgDeps;
const userIds: UserId[] = [];
const orgIds: OrgId[] = [];

const caller = (userId: UserId): Caller => ({ userId, requestId: randomUUID() });

async function newUser(label: string): Promise<UserId> {
  const id = await createTestUser(pool, `p1-04-${label}`);
  userIds.push(id);
  return id;
}

async function newOrg(
  owner: UserId,
  name = 'Org',
): Promise<{ orgId: OrgId; membershipId: string }> {
  const result = await createOrganization(deps, caller(owner), { name });
  orgIds.push(result.orgId);
  return result;
}

/** Runs `sql` as the app role inside `orgId`'s tenant context. */
async function inOrg<T extends pg.QueryResultRow>(
  orgId: string,
  text: string,
  values: unknown[] = [],
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await client.query<T>(text, values);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function newSession(userId: UserId): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, now() + interval '1 hour') RETURNING id",
    [userId, randomBytes(24).toString('hex')],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('no session id');
  return id;
}

async function activeOrgOf(sessionId: string): Promise<string | null> {
  const result = await pool.query<{ active_org_id: string | null }>(
    'SELECT active_org_id FROM sessions WHERE id = $1',
    [sessionId],
  );
  return result.rows[0]?.active_org_id ?? null;
}

async function expectOrgError(fn: () => Promise<unknown>, code: OrgErrorCode): Promise<void> {
  await expect(fn()).rejects.toSatisfy(
    (e: unknown) => e instanceof OrgError && e.code === code,
    `expected OrgError ${code}`,
  );
}

async function membershipOf(orgId: OrgId, userId: UserId) {
  const rows = await inOrg<{ id: string; role: string }>(
    orgId,
    'SELECT id, role FROM memberships WHERE org_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  return rows[0];
}

async function auditFor(orgId: OrgId, requestId: string) {
  return inOrg<{ action: string; outcome: string; actor_id: string }>(
    orgId,
    'SELECT action, outcome, actor_id FROM audit_events WHERE request_id = $1',
    [requestId],
  );
}

beforeAll(() => {
  pool = createPool('app', 6);
  db = createDb(pool);
  deps = { db };
});

afterAll(async () => {
  for (const orgId of orgIds) {
    await inOrg(orgId, 'DELETE FROM organizations WHERE id = $1', [orgId]);
  }
  await deleteTestUsers(pool, userIds);
  await pool?.end();
});

describe('createOrganization', () => {
  it('makes the creator the owner and writes an audit event', async () => {
    const ann = await newUser('ann');
    const c = caller(ann);
    const { orgId } = await createOrganization(deps, c, { name: '  Acme  ' });
    orgIds.push(orgId);
    expect((await membershipOf(orgId, ann))?.role).toBe('owner');
    const [org] = await inOrg<{ name: string }>(
      orgId,
      'SELECT name FROM organizations WHERE id = $1',
      [orgId],
    );
    expect(org?.name).toBe('Acme');
    expect(await auditFor(orgId, c.requestId)).toEqual([
      { action: 'organization.create', outcome: 'success', actor_id: ann },
    ]);
  });

  it('rejects an empty name', async () => {
    const ann = await newUser('ann-empty');
    await expectOrgError(
      () => createOrganization(deps, caller(ann), { name: '   ' }),
      'validation_failed',
    );
  });
});

describe('listMyMemberships', () => {
  it('lists only the caller\u2019s own orgs', async () => {
    const ann = await newUser('list-ann');
    const ben = await newUser('list-ben');
    const a = await newOrg(ann, 'List A');
    await newOrg(ben, 'List B');
    const mine = await listMyMemberships(deps, caller(ann));
    expect(mine).toEqual([
      { membershipId: a.membershipId, orgId: a.orgId, orgName: 'List A', role: 'owner' },
    ]);
  });
});

describe('invitations', () => {
  it('invite then accept makes a member with the invited role, once', async () => {
    const ann = await newUser('inv-ann');
    const ben = await newUser('inv-ben');
    const { orgId } = await newOrg(ann);
    const { token, invitationId } = await createInvitation(deps, caller(ann), orgId, {
      role: 'agent',
    });

    const c = caller(ben);
    const accepted = await acceptInvitation(deps, c, token);
    expect(accepted).toMatchObject({ orgId, role: 'agent' });
    expect((await membershipOf(orgId, ben))?.role).toBe('agent');
    expect(await auditFor(orgId, c.requestId)).toEqual([
      { action: 'invitation.accept', outcome: 'success', actor_id: ben },
    ]);

    const carl = await newUser('inv-carl');
    await expectOrgError(() => acceptInvitation(deps, caller(carl), token), 'not_found');
    const [row] = await inOrg<{ accepted_by: string }>(
      orgId,
      'SELECT accepted_by FROM invitations WHERE id = $1',
      [invitationId],
    );
    expect(row?.accepted_by).toBe(ben);
  });

  it('stores only the token hash, and the token is never in the audit log', async () => {
    const ann = await newUser('hash-ann');
    const { orgId } = await newOrg(ann);
    const c = caller(ann);
    const { token, invitationId } = await createInvitation(deps, c, orgId, { role: 'member' });
    const [row] = await inOrg<{ token_hash: string }>(
      orgId,
      'SELECT token_hash FROM invitations WHERE id = $1',
      [invitationId],
    );
    expect(row?.token_hash).toBe(hashInviteToken(token));
    const auditText = JSON.stringify(
      await inOrg(orgId, 'SELECT * FROM audit_events WHERE request_id = $1', [c.requestId]),
    );
    expect(auditText).not.toContain(token);
  });

  it('rejects an expired invitation', async () => {
    const ann = await newUser('exp-ann');
    const ben = await newUser('exp-ben');
    const { orgId } = await newOrg(ann);
    const { token, invitationId } = await createInvitation(deps, caller(ann), orgId, {
      role: 'member',
    });
    await inOrg(
      orgId,
      "UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1",
      [invitationId],
    );
    await expectOrgError(() => acceptInvitation(deps, caller(ben), token), 'not_found');
    expect(await membershipOf(orgId, ben)).toBeUndefined();
  });

  it('rejects an unknown, a changed and a malformed token', async () => {
    const ann = await newUser('bad-ann');
    const ben = await newUser('bad-ben');
    const { orgId } = await newOrg(ann);
    const { token } = await createInvitation(deps, caller(ann), orgId, { role: 'member' });
    const changed = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    for (const t of [randomBytes(32).toString('base64url'), changed, 'not-a-token', `${token}x`]) {
      await expectOrgError(() => acceptInvitation(deps, caller(ben), t), 'not_found');
    }
    expect(await membershipOf(orgId, ben)).toBeUndefined();
  });

  it('gives conflict to an existing member and leaves the invitation usable', async () => {
    const ann = await newUser('dup-ann');
    const ben = await newUser('dup-ben');
    const { orgId } = await newOrg(ann);
    const { token } = await createInvitation(deps, caller(ann), orgId, { role: 'member' });
    await expectOrgError(() => acceptInvitation(deps, caller(ann), token), 'conflict');
    expect((await acceptInvitation(deps, caller(ben), token)).role).toBe('member');
  });

  it('lets only one of two parallel accepts of the same token win', async () => {
    const ann = await newUser('race-ann');
    const ben = await newUser('race-ben');
    const carl = await newUser('race-carl');
    const { orgId } = await newOrg(ann);
    const { token } = await createInvitation(deps, caller(ann), orgId, { role: 'member' });
    const results = await Promise.allSettled([
      acceptInvitation(deps, caller(ben), token),
      acceptInvitation(deps, caller(carl), token),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(
      rejected?.status === 'rejected' &&
        rejected.reason instanceof OrgError &&
        rejected.reason.code,
    ).toBe('not_found');
    const members = await inOrg(
      orgId,
      "SELECT 1 FROM memberships WHERE org_id = $1 AND role = 'member'",
      [orgId],
    );
    expect(members).toHaveLength(1);
  });

  it('is invisible from another org, and a non-member cannot create one', async () => {
    const ann = await newUser('iso-ann');
    const ben = await newUser('iso-ben');
    const a = await newOrg(ann);
    const b = await newOrg(ben);
    const { invitationId } = await createInvitation(deps, caller(ann), a.orgId, { role: 'member' });
    expect(await inOrg(b.orgId, 'SELECT 1 FROM invitations WHERE id = $1', [invitationId])).toEqual(
      [],
    );
    await expectOrgError(
      () => createInvitation(deps, caller(ben), a.orgId, { role: 'member' }),
      'not_found',
    );
  });

  it('rejects a bad role and a bad lifetime', async () => {
    const ann = await newUser('val-ann');
    const { orgId } = await newOrg(ann);
    await expectOrgError(
      () => createInvitation(deps, caller(ann), orgId, { role: 'Admin!' }),
      'validation_failed',
    );
    await expectOrgError(
      () => createInvitation(deps, caller(ann), orgId, { role: 'member', ttlSeconds: 10 }),
      'validation_failed',
    );
  });
});

describe('roles and removal', () => {
  async function orgWith(label: string) {
    const ann = await newUser(`${label}-ann`);
    const ben = await newUser(`${label}-ben`);
    const { orgId } = await newOrg(ann);
    const { token } = await createInvitation(deps, caller(ann), orgId, { role: 'member' });
    const { membershipId: benMembership } = await acceptInvitation(deps, caller(ben), token);
    const annMembership = (await membershipOf(orgId, ann))?.id ?? '';
    return { ann, ben, orgId, annMembership, benMembership };
  }

  it('changes a role and audits it', async () => {
    const { ann, ben, orgId, benMembership } = await orgWith('role');
    const c = caller(ann);
    await changeRole(deps, c, orgId, { membershipId: benMembership, role: 'admin' });
    expect((await membershipOf(orgId, ben))?.role).toBe('admin');
    expect(await auditFor(orgId, c.requestId)).toEqual([
      { action: 'membership.change_role', outcome: 'success', actor_id: ann },
    ]);
  });

  it('the last owner cannot be demoted, removed or leave', async () => {
    const { ann, orgId, annMembership } = await orgWith('last');
    await expectOrgError(
      () => changeRole(deps, caller(ann), orgId, { membershipId: annMembership, role: 'member' }),
      'last_owner',
    );
    await expectOrgError(
      () => removeMember(deps, caller(ann), orgId, { membershipId: annMembership }),
      'last_owner',
    );
    expect((await membershipOf(orgId, ann))?.role).toBe('owner');
  });

  it('an owner can leave once there is another owner', async () => {
    const { ann, ben, orgId, annMembership, benMembership } = await orgWith('handover');
    await changeRole(deps, caller(ann), orgId, { membershipId: benMembership, role: 'owner' });
    await removeMember(deps, caller(ann), orgId, { membershipId: annMembership });
    expect(await membershipOf(orgId, ann)).toBeUndefined();
    expect((await membershipOf(orgId, ben))?.role).toBe('owner');
  });

  it('two owners demoting each other at the same time cannot leave the org without an owner', async () => {
    const { ann, orgId, annMembership, benMembership } = await orgWith('race-owner');
    await changeRole(deps, caller(ann), orgId, { membershipId: benMembership, role: 'owner' });
    const results = await Promise.allSettled([
      changeRole(deps, caller(ann), orgId, { membershipId: benMembership, role: 'member' }),
      changeRole(deps, caller(ann), orgId, { membershipId: annMembership, role: 'member' }),
    ]);
    const owners = await inOrg(
      orgId,
      "SELECT 1 FROM memberships WHERE org_id = $1 AND role = 'owner'",
      [orgId],
    );
    expect(owners).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('removing a member clears that org from their sessions, and audits it', async () => {
    const { ann, ben, orgId, benMembership } = await orgWith('remove');
    const benSession = await newSession(ben);
    await setActiveOrg(
      deps,
      { ...caller(ben), sessionId: benSession },
      { membershipId: benMembership },
    );
    expect(await activeOrgOf(benSession)).toBe(orgId);
    const c = caller(ann);
    await removeMember(deps, c, orgId, { membershipId: benMembership });
    expect(await membershipOf(orgId, ben)).toBeUndefined();
    expect(await activeOrgOf(benSession)).toBeNull();
    expect(await auditFor(orgId, c.requestId)).toEqual([
      { action: 'membership.remove', outcome: 'success', actor_id: ann },
    ]);
  });

  it('cannot change or remove a membership of another org', async () => {
    const x = await orgWith('cross-x');
    const y = await orgWith('cross-y');
    await expectOrgError(
      () =>
        changeRole(deps, caller(x.ann), x.orgId, { membershipId: y.benMembership, role: 'admin' }),
      'not_found',
    );
    await expectOrgError(
      () => removeMember(deps, caller(x.ann), x.orgId, { membershipId: y.benMembership }),
      'not_found',
    );
    expect((await membershipOf(y.orgId, y.ben))?.role).toBe('member');
  });

  it('a non-member cannot act on an org even with a real membership id', async () => {
    const x = await orgWith('outsider');
    const eve = await newUser('outsider-eve');
    await expectOrgError(
      () =>
        changeRole(deps, caller(eve), x.orgId, { membershipId: x.benMembership, role: 'owner' }),
      'not_found',
    );
    await expectOrgError(
      () => removeMember(deps, caller(eve), x.orgId, { membershipId: x.benMembership }),
      'not_found',
    );
  });
});

describe('setActiveOrg', () => {
  it('sets the org of one of the caller\u2019s memberships on the caller\u2019s session', async () => {
    const ann = await newUser('active-ann');
    const a = await newOrg(ann);
    const session = await newSession(ann);
    expect(
      await setActiveOrg(
        deps,
        { ...caller(ann), sessionId: session },
        { membershipId: a.membershipId },
      ),
    ).toEqual({
      orgId: a.orgId,
    });
    expect(await activeOrgOf(session)).toBe(a.orgId);
  });

  it('refuses someone else\u2019s membership id and audits the denial', async () => {
    const ann = await newUser('deny-ann');
    const ben = await newUser('deny-ben');
    const b = await newOrg(ben);
    const session = await newSession(ann);
    const c = { ...caller(ann), sessionId: session };
    await expectOrgError(
      () => setActiveOrg(deps, c, { membershipId: b.membershipId }),
      'not_found',
    );
    expect(await activeOrgOf(session)).toBeNull();
    // Audit rows without an org are readable only by their actor, inside a user context.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [ann]);
      const rows = await client.query(
        'SELECT action, outcome, org_id, resource_id FROM audit_events WHERE request_id = $1',
        [c.requestId],
      );
      await client.query('COMMIT');
      expect(rows.rows).toEqual([
        { action: 'session.set_active_org', outcome: 'denied', org_id: null, resource_id: null },
      ]);
    } finally {
      client.release();
    }
  });

  it('refuses another user\u2019s session', async () => {
    const ann = await newUser('sess-ann');
    const ben = await newUser('sess-ben');
    const a = await newOrg(ann);
    const benSession = await newSession(ben);
    await expectOrgError(
      () =>
        setActiveOrg(
          deps,
          { ...caller(ann), sessionId: benSession },
          { membershipId: a.membershipId },
        ),
      'not_found',
    );
    expect(await activeOrgOf(benSession)).toBeNull();
  });
});
