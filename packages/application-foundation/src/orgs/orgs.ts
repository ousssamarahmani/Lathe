import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sessions } from '../auth/schema.js';
import { auditEvents, memberships, organizations } from '../db/schema.js';
import { parseOrgId, type OrgId, type UserId } from '../tenancy/ids.js';
import { withTenant, withUser, type TenantTx } from '../tenancy/with-tenant.js';
import { OrgError } from './errors.js';
import { hashInviteToken, isInviteToken, newInviteToken } from './invite-token.js';
import { invitations } from './schema.js';

type Db = NodePgDatabase<Record<string, unknown>>;

/** The owner role is the only role the foundation knows: an org always keeps one. */
export const OWNER_ROLE = 'owner';

const ROLE = /^[a-z][a-z0-9_-]{0,39}$/;
const DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface OrgDeps {
  readonly db: Db;
  /** Injected for tests. Default `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** Injected for tests. Default 32 random bytes. */
  readonly newToken?: () => string;
}

/**
 * Who is acting. `userId` must come from `getPrincipal` (P1-03), never from
 * request input. `requestId` ties the audit events to the request.
 */
export interface Caller {
  readonly userId: UserId;
  readonly requestId: string;
}

/**
 * Org-scoped operations below take `orgId` as an argument. It must be the
 * caller's active org from the session (`Principal.activeOrgId`), never a value
 * from the request. Each operation also checks that the caller is a member of
 * that org and fails with `not_found` otherwise; permission checks (who may
 * invite, change roles, remove) are added by `defineAction` in P1-05.
 */

export interface MembershipSummary {
  readonly membershipId: string;
  readonly orgId: OrgId;
  readonly orgName: string;
  readonly role: string;
}

function checkRole(role: string): string {
  if (!ROLE.test(role)) throw new OrgError('validation_failed', 'invalid role name');
  return role;
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new OrgError('validation_failed', 'organization name must be 1 to 200 characters');
  }
  return trimmed;
}

async function audit(
  tx: TenantTx,
  event: {
    caller: Caller;
    orgId: OrgId | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    outcome: 'success' | 'denied';
  },
): Promise<void> {
  // No RETURNING: rows without an org are insertable but not readable (migration 0002).
  await tx.insert(auditEvents).values({
    actorId: event.caller.userId,
    orgId: event.orgId,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    outcome: event.outcome,
    requestId: event.caller.requestId,
  });
}

/** The caller's membership in the current tenant transaction's org, or `not_found`. */
async function requireMembership(tx: TenantTx, orgId: OrgId, userId: UserId) {
  const [row] = await tx
    .select({ id: memberships.id, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  if (!row) throw new OrgError('not_found', 'organization not found');
  return row;
}

function isLastOwnerViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if ((e as { constraint?: unknown }).constraint === 'memberships_last_owner') return true;
  }
  return false;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const pgError = e as { code?: unknown; constraint?: unknown };
    if (pgError.code === '23505' && pgError.constraint === constraint) return true;
  }
  return false;
}

async function mapLastOwner<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isLastOwnerViolation(error)) {
      throw new OrgError('last_owner', 'an organization must keep at least one owner', {
        cause: error,
      });
    }
    throw error;
  }
}

/** Creates an organization with `caller` as its first owner. */
export async function createOrganization(
  deps: OrgDeps,
  caller: Caller,
  input: { readonly name: string },
): Promise<{ orgId: OrgId; membershipId: string }> {
  const name = checkName(input.name);
  // The id is chosen first: under RLS the org row can only be inserted in its own context.
  const orgId = parseOrgId((deps.newId ?? randomUUID)());
  return withTenant(deps.db, orgId, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name });
    const [m] = await tx
      .insert(memberships)
      .values({ orgId, userId: caller.userId, role: OWNER_ROLE })
      .returning({ id: memberships.id });
    if (!m) throw new Error('membership insert returned no row');
    await audit(tx, {
      caller,
      orgId,
      action: 'organization.create',
      resourceType: 'organization',
      resourceId: orgId,
      outcome: 'success',
    });
    return { orgId, membershipId: m.id };
  });
}

/** Every org the caller belongs to, for the org switcher and `GET /v1/me`. */
export async function listMyMemberships(
  deps: OrgDeps,
  caller: Caller,
): Promise<MembershipSummary[]> {
  return withUser(deps.db, caller.userId, async (tx) => {
    const rows = await tx
      .select({
        membershipId: memberships.id,
        orgId: memberships.orgId,
        orgName: organizations.name,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(eq(memberships.userId, caller.userId))
      .orderBy(organizations.name);
    return rows.map((r) => ({ ...r, orgId: parseOrgId(r.orgId) }));
  });
}

/**
 * Creates an invitation to `orgId` for `role`. Returns the token once; only its
 * hash is stored. The link the app builds from it is a secret: never log it.
 */
export async function createInvitation(
  deps: OrgDeps,
  caller: Caller,
  orgId: OrgId,
  input: { readonly role: string; readonly ttlSeconds?: number },
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const role = checkRole(input.role);
  const ttl = input.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 30 * 24 * 60 * 60) {
    throw new OrgError('validation_failed', 'invite lifetime must be 1 minute to 30 days');
  }
  const token = (deps.newToken ?? newInviteToken)();
  return withTenant(deps.db, orgId, async (tx) => {
    await requireMembership(tx, orgId, caller.userId);
    const [row] = await tx
      .insert(invitations)
      .values({
        orgId,
        role,
        tokenHash: hashInviteToken(token),
        invitedBy: caller.userId,
        expiresAt: sql`now() + make_interval(secs => ${ttl})`,
      })
      .returning({ id: invitations.id, expiresAt: invitations.expiresAt });
    if (!row) throw new Error('invitation insert returned no row');
    await audit(tx, {
      caller,
      orgId,
      action: 'invitation.create',
      resourceType: 'invitation',
      resourceId: row.id,
      outcome: 'success',
    });
    return { invitationId: row.id, token, expiresAt: row.expiresAt };
  });
}

/**
 * Accepts an invitation with its token. Unknown, used, expired and malformed
 * tokens all give `not_found`. Already being a member gives `conflict` and leaves
 * the invitation unused.
 */
export async function acceptInvitation(
  deps: OrgDeps,
  caller: Caller,
  token: string,
): Promise<{ orgId: OrgId; membershipId: string; role: string }> {
  if (!isInviteToken(token)) throw new OrgError('not_found', 'invitation not found');
  const tokenHash = hashInviteToken(token);

  // Step 1: find the invitation by its secret, with no org or user context.
  const found = await deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.invite_token_hash', ${tokenHash}, true),
                 set_config('app.org_id', '', true),
                 set_config('app.user_id', '', true)`,
    );
    const [row] = await tx
      .select({ id: invitations.id, orgId: invitations.orgId })
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash));
    return row;
  });
  if (!found) throw new OrgError('not_found', 'invitation not found');

  // Step 2: in the org the invitation itself names (from the database, not the
  // request), lock it and re-check it is unused, so two accepts cannot both win.
  const orgId = parseOrgId(found.orgId);
  return withTenant(deps.db, orgId, async (tx) => {
    const [invite] = await tx
      .select({ id: invitations.id, role: invitations.role })
      .from(invitations)
      .where(
        and(
          eq(invitations.id, found.id),
          eq(invitations.tokenHash, tokenHash),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, sql`now()`),
        ),
      )
      .for('update');
    if (!invite) throw new OrgError('not_found', 'invitation not found');

    let membershipId: string;
    try {
      const [m] = await tx
        .insert(memberships)
        .values({ orgId, userId: caller.userId, role: invite.role })
        .returning({ id: memberships.id });
      if (!m) throw new Error('membership insert returned no row');
      membershipId = m.id;
    } catch (error) {
      if (isUniqueViolation(error, 'memberships_org_id_user_id_unique')) {
        throw new OrgError('conflict', 'already a member of this organization', { cause: error });
      }
      throw error;
    }
    await tx
      .update(invitations)
      .set({ acceptedAt: sql`now()`, acceptedBy: caller.userId, updatedAt: sql`now()` })
      .where(eq(invitations.id, invite.id));
    await audit(tx, {
      caller,
      orgId,
      action: 'invitation.accept',
      resourceType: 'invitation',
      resourceId: invite.id,
      outcome: 'success',
    });
    return { orgId, membershipId, role: invite.role };
  });
}

/** Changes the role of a membership in `orgId`. Demoting the last owner gives `last_owner`. */
export async function changeRole(
  deps: OrgDeps,
  caller: Caller,
  orgId: OrgId,
  input: { readonly membershipId: string; readonly role: string },
): Promise<void> {
  const role = checkRole(input.role);
  await mapLastOwner(() =>
    withTenant(deps.db, orgId, async (tx) => {
      await requireMembership(tx, orgId, caller.userId);
      const updated = await tx
        .update(memberships)
        .set({ role, updatedAt: sql`now()` })
        .where(and(eq(memberships.id, input.membershipId), eq(memberships.orgId, orgId)))
        .returning({ id: memberships.id });
      if (updated.length === 0) throw new OrgError('not_found', 'membership not found');
      await audit(tx, {
        caller,
        orgId,
        action: 'membership.change_role',
        resourceType: 'membership',
        resourceId: input.membershipId,
        outcome: 'success',
      });
    }),
  );
}

/**
 * Removes a membership from `orgId`, or leaves the org when it is the caller's
 * own. Clears that org from the removed user's sessions. Removing the last owner
 * gives `last_owner`.
 */
export async function removeMember(
  deps: OrgDeps,
  caller: Caller,
  orgId: OrgId,
  input: { readonly membershipId: string },
): Promise<void> {
  await mapLastOwner(() =>
    withTenant(deps.db, orgId, async (tx) => {
      await requireMembership(tx, orgId, caller.userId);
      const [removed] = await tx
        .delete(memberships)
        .where(and(eq(memberships.id, input.membershipId), eq(memberships.orgId, orgId)))
        .returning({ userId: memberships.userId });
      if (!removed) throw new OrgError('not_found', 'membership not found');
      await tx
        .update(sessions)
        .set({ activeOrgId: null })
        .where(and(eq(sessions.userId, removed.userId), eq(sessions.activeOrgId, orgId)));
      await audit(tx, {
        caller,
        orgId,
        action: removed.userId === caller.userId ? 'membership.leave' : 'membership.remove',
        resourceType: 'membership',
        resourceId: input.membershipId,
        outcome: 'success',
      });
    }),
  );
}

/**
 * Sets the active org of the caller's session (C4 v1.1 `setActiveOrg`). The client
 * names one of its own memberships; a foreign or unknown id is `not_found` and is
 * audited as denied. The client never sends an org id.
 */
export async function setActiveOrg(
  deps: OrgDeps,
  caller: Caller & { readonly sessionId: string },
  input: { readonly membershipId: string },
): Promise<{ orgId: OrgId }> {
  const outcome = await withUser(deps.db, caller.userId, async (tx) => {
    // Self-read policy: only the caller's own memberships are visible here.
    const [m] = await tx
      .select({ orgId: memberships.orgId })
      .from(memberships)
      .where(and(eq(memberships.id, input.membershipId), eq(memberships.userId, caller.userId)));
    const updated = m
      ? await tx
          .update(sessions)
          .set({ activeOrgId: m.orgId, updatedAt: sql`now()` })
          .where(and(eq(sessions.id, caller.sessionId), eq(sessions.userId, caller.userId)))
          .returning({ id: sessions.id })
      : [];
    const ok = m !== undefined && updated.length === 1;
    // Audit rows written here have no org: withUser has no org context.
    await audit(tx, {
      caller,
      orgId: null,
      action: 'session.set_active_org',
      resourceType: 'membership',
      resourceId: m ? input.membershipId : null,
      outcome: ok ? 'success' : 'denied',
    });
    return ok ? parseOrgId(m.orgId) : null;
  });
  if (outcome === null) throw new OrgError('not_found', 'membership not found');
  return { orgId: outcome };
}
