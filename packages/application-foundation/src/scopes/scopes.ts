import { and, eq, inArray } from 'drizzle-orm';
import pg from 'pg';
import type { ScopeContext, ScopeKind } from '../authz/hierarchy.js';
import { OrgError } from '../orgs/errors.js';
import type { OrgId, UserId } from '../tenancy/ids.js';
import type { TenantTx } from '../tenancy/with-tenant.js';
import { scopeDenies, scopeGrants, scopes } from './schema.js';

/**
 * Database side of hierarchical scopes (task P7-01). Every function runs inside an
 * already-checked tenant transaction (`withTenant`), so RLS limits it to `orgId`;
 * the queries also filter on `orgId` as a second line of defense.
 *
 * A scope of another org, an unknown scope and an unknown membership all give
 * `not_found`: callers cannot tell them apart.
 */

export interface ResolvedScope {
  readonly id: string;
  readonly kind: ScopeKind;
  /** Scope ids from the team down to this scope: `[team]` or `[team, project]`. */
  readonly chain: readonly string[];
}

const notFound = (): never => {
  throw new OrgError('not_found', 'not found');
};

/** Postgres error code of `error` or of one of its causes (Drizzle wraps driver errors). */
function pgCode(error: unknown): string | undefined {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e instanceof pg.DatabaseError && e.code) return e.code;
  }
  return undefined;
}

/** Runs a write; unique violations become `conflict`, broken references `not_found`. */
async function write<T>(op: () => Promise<T>, what: string): Promise<T> {
  try {
    return await op();
  } catch (error) {
    const code = pgCode(error);
    if (code === '23505')
      throw new OrgError('conflict', `${what} already exists`, { cause: error });
    if (code === '23503') throw new OrgError('not_found', 'not found', { cause: error });
    throw error;
  }
}

/** The scope and its chain. `null` means the org itself (chain `[]`). */
export async function resolveScopeInTx(
  tx: TenantTx,
  orgId: OrgId,
  scopeId: string | null,
): Promise<ResolvedScope | null> {
  if (scopeId === null) return null;
  const [scope] = await tx
    .select({ id: scopes.id, kind: scopes.kind, parentId: scopes.parentId })
    .from(scopes)
    .where(and(eq(scopes.id, scopeId), eq(scopes.orgId, orgId)));
  if (!scope) return notFound();
  if (scope.kind === 'team') return { id: scope.id, kind: 'team', chain: [scope.id] };
  if (scope.kind !== 'project' || scope.parentId === null) return notFound();
  const [parent] = await tx
    .select({ id: scopes.id, kind: scopes.kind })
    .from(scopes)
    .where(and(eq(scopes.id, scope.parentId), eq(scopes.orgId, orgId)));
  // The database guarantees a team parent in the same org; anything else is refused.
  if (!parent || parent.kind !== 'team') return notFound();
  return { id: scope.id, kind: 'project', chain: [parent.id, scope.id] };
}

/** The membership's grants and denies on `chain`, as the input of `canInScope`. */
export async function loadScopeContextInTx(
  tx: TenantTx,
  orgId: OrgId,
  membership: { readonly id: string; readonly role: string },
  chain: readonly string[],
): Promise<ScopeContext> {
  if (chain.length === 0) return { orgRole: membership.role, chain, grants: [], denies: [] };
  const ids = [...chain];
  const [grants, denies] = await Promise.all([
    tx
      .select({ scopeId: scopeGrants.scopeId, role: scopeGrants.role })
      .from(scopeGrants)
      .where(
        and(
          eq(scopeGrants.orgId, orgId),
          eq(scopeGrants.membershipId, membership.id),
          inArray(scopeGrants.scopeId, ids),
        ),
      ),
    tx
      .select({ scopeId: scopeDenies.scopeId, permission: scopeDenies.permission })
      .from(scopeDenies)
      .where(
        and(
          eq(scopeDenies.orgId, orgId),
          eq(scopeDenies.membershipId, membership.id),
          inArray(scopeDenies.scopeId, ids),
        ),
      ),
  ]);
  return { orgRole: membership.role, chain, grants, denies };
}

/** Creates a team (no parent) or a project (parent: a team of this org). */
export async function createScopeInTx(
  tx: TenantTx,
  orgId: OrgId,
  input: { readonly kind: ScopeKind; readonly parentId: string | null },
): Promise<{ id: string; kind: ScopeKind; parentId: string | null }> {
  if (input.kind === 'team' && input.parentId !== null) {
    throw new OrgError('validation_failed', 'a team has no parent scope');
  }
  if (input.kind === 'project') {
    if (input.parentId === null) throw new OrgError('validation_failed', 'a project needs a team');
    const parent = await resolveScopeInTx(tx, orgId, input.parentId);
    if (parent?.kind !== 'team') throw new OrgError('validation_failed', 'a project needs a team');
  }
  const [row] = await write(
    () =>
      tx
        .insert(scopes)
        .values({
          orgId,
          kind: input.kind,
          parentId: input.parentId,
          parentKind: input.kind === 'project' ? 'team' : null,
        })
        .returning({ id: scopes.id }),
    'scope',
  );
  if (!row) throw new Error('insert into scopes returned no row');
  return { id: row.id, kind: input.kind, parentId: input.parentId };
}

export interface ScopeRuleInput {
  readonly scopeId: string;
  readonly membershipId: string;
}

export async function grantScopeRoleInTx(
  tx: TenantTx,
  orgId: OrgId,
  by: UserId,
  input: ScopeRuleInput & { readonly role: string },
): Promise<{ grantId: string }> {
  const [row] = await write(
    () =>
      tx
        .insert(scopeGrants)
        .values({ orgId, ...input, createdBy: by })
        .returning({ id: scopeGrants.id }),
    'grant',
  );
  if (!row) throw new Error('insert into scope_grants returned no row');
  return { grantId: row.id };
}

export async function revokeScopeRoleInTx(
  tx: TenantTx,
  orgId: OrgId,
  input: ScopeRuleInput & { readonly role: string },
): Promise<{ grantId: string }> {
  const [row] = await tx
    .delete(scopeGrants)
    .where(
      and(
        eq(scopeGrants.orgId, orgId),
        eq(scopeGrants.scopeId, input.scopeId),
        eq(scopeGrants.membershipId, input.membershipId),
        eq(scopeGrants.role, input.role),
      ),
    )
    .returning({ id: scopeGrants.id });
  return row ? { grantId: row.id } : notFound();
}

export async function denyScopePermissionInTx(
  tx: TenantTx,
  orgId: OrgId,
  by: UserId,
  input: ScopeRuleInput & { readonly permission: string },
): Promise<{ denyId: string }> {
  const [row] = await write(
    () =>
      tx
        .insert(scopeDenies)
        .values({ orgId, ...input, createdBy: by })
        .returning({ id: scopeDenies.id }),
    'deny',
  );
  if (!row) throw new Error('insert into scope_denies returned no row');
  return { denyId: row.id };
}

export async function removeScopeDenyInTx(
  tx: TenantTx,
  orgId: OrgId,
  input: ScopeRuleInput & { readonly permission: string },
): Promise<{ denyId: string }> {
  const [row] = await tx
    .delete(scopeDenies)
    .where(
      and(
        eq(scopeDenies.orgId, orgId),
        eq(scopeDenies.scopeId, input.scopeId),
        eq(scopeDenies.membershipId, input.membershipId),
        eq(scopeDenies.permission, input.permission),
      ),
    )
    .returning({ id: scopeDenies.id });
  return row ? { denyId: row.id } : notFound();
}

/** Grants and denies set directly on one scope (not inherited ones). */
export async function listScopeRulesInTx(
  tx: TenantTx,
  orgId: OrgId,
  scopeId: string,
): Promise<{
  grants: { membershipId: string; role: string }[];
  denies: { membershipId: string; permission: string }[];
}> {
  const [grants, denies] = await Promise.all([
    tx
      .select({ membershipId: scopeGrants.membershipId, role: scopeGrants.role })
      .from(scopeGrants)
      .where(and(eq(scopeGrants.orgId, orgId), eq(scopeGrants.scopeId, scopeId))),
    tx
      .select({ membershipId: scopeDenies.membershipId, permission: scopeDenies.permission })
      .from(scopeDenies)
      .where(and(eq(scopeDenies.orgId, orgId), eq(scopeDenies.scopeId, scopeId))),
  ]);
  return { grants, denies };
}
