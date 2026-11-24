import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canInScope,
  effectivePermissions,
  mayAssignInScope,
  type ScopeContext,
} from './hierarchy.js';
import { can, defineAuthz } from './policy.js';

const authz = defineAuthz({
  permissions: ['tasks.read', 'tasks.update', 'tasks.delete', 'scopes.manage'],
  roles: {
    owner: ['tasks.read', 'tasks.update', 'tasks.delete', 'scopes.manage'],
    lead: ['tasks.read', 'tasks.update', 'scopes.manage'],
    member: ['tasks.read', 'tasks.update'],
    guest: ['tasks.read'],
    none: [],
  },
});

// Two teams with two projects each: chains [] | [t] | [t, p].
const TEAMS = ['t1', 't2'];
const PROJECTS: Record<string, string[]> = { t1: ['p1', 'p2'], t2: ['p3', 'p4'] };
const SCOPES = ['t1', 't2', 'p1', 'p2', 'p3', 'p4'];
const PERMS = [...authz.permissions, 'tasks.unknown'];
const ROLES = [...authz.roles, 'ghost'];

const chainArb = fc.oneof(
  fc.constant<string[]>([]),
  fc.constantFrom(...TEAMS).map((t) => [t]),
  fc
    .constantFrom(...TEAMS)
    .chain((t) => fc.constantFrom(...(PROJECTS[t] ?? [])).map((p) => [t, p])),
);
const grantArb = fc.record({
  scopeId: fc.constantFrom(...SCOPES),
  role: fc.constantFrom(...ROLES),
});
const denyArb = fc.record({
  scopeId: fc.constantFrom(...SCOPES),
  permission: fc.constantFrom(...PERMS),
});
const ctxArb: fc.Arbitrary<ScopeContext> = fc.record({
  orgRole: fc.constantFrom(...ROLES),
  chain: chainArb,
  grants: fc.array(grantArb, { maxLength: 6 }),
  denies: fc.array(denyArb, { maxLength: 4 }),
});
const permArb = fc.constantFrom(...PERMS);
// Seeds are printed by fast-check on failure; turn each into an example test below.
const RUNS = { numRuns: 2000 };

describe('canInScope properties', () => {
  it('an explicit deny anywhere on the chain wins over every allow', () => {
    fc.assert(
      fc.property(ctxArb, permArb, (ctx, p) => {
        const denied = ctx.denies.some((d) => d.permission === p && ctx.chain.includes(d.scopeId));
        if (denied) expect(canInScope(authz, ctx, p)).toBe(false);
      }),
      RUNS,
    );
  });

  it('never grants without an explicit permission from the org role or a grant on the chain', () => {
    fc.assert(
      fc.property(ctxArb, permArb, (ctx, p) => {
        if (!canInScope(authz, ctx, p)) return;
        const source =
          can(authz, ctx.orgRole, p) ||
          ctx.grants.some((g) => ctx.chain.includes(g.scopeId) && can(authz, g.role, p));
        expect(source).toBe(true);
      }),
      RUNS,
    );
  });

  it('nesting never escalates: grants and denies off the chain change nothing', () => {
    fc.assert(
      fc.property(ctxArb, permArb, fc.array(grantArb), fc.array(denyArb), (ctx, p, gs, ds) => {
        const onlyChain: ScopeContext = {
          ...ctx,
          grants: ctx.grants.filter((g) => ctx.chain.includes(g.scopeId)),
          denies: ctx.denies.filter((d) => ctx.chain.includes(d.scopeId)),
        };
        const offChain: ScopeContext = {
          ...onlyChain,
          grants: [...onlyChain.grants, ...gs.filter((g) => !ctx.chain.includes(g.scopeId))],
          denies: [...onlyChain.denies, ...ds.filter((d) => !ctx.chain.includes(d.scopeId))],
        };
        expect(canInScope(authz, offChain, p)).toBe(canInScope(authz, onlyChain, p));
        expect(canInScope(authz, ctx, p)).toBe(canInScope(authz, onlyChain, p));
      }),
      RUNS,
    );
  });

  it('inheritance flows down: what is allowed on a scope is allowed below it unless denied there', () => {
    fc.assert(
      fc.property(ctxArb, permArb, (ctx, p) => {
        if (ctx.chain.length === 2) return;
        const parent = ctx.chain;
        const team = parent[0] ?? 't1';
        for (const child of parent.length === 0
          ? [[team]]
          : (PROJECTS[team] ?? []).map((x) => [team, x])) {
          const below: ScopeContext = { ...ctx, chain: child };
          const deniedHere = ctx.denies.some(
            (d) => d.permission === p && d.scopeId === child.at(-1),
          );
          if (canInScope(authz, { ...ctx, chain: parent }, p) && !deniedHere) {
            expect(canInScope(authz, below, p)).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  it('is monotonic: a deny never adds a permission, a grant never removes one', () => {
    fc.assert(
      fc.property(ctxArb, permArb, grantArb, denyArb, (ctx, p, g, d) => {
        const before = canInScope(authz, ctx, p);
        if (canInScope(authz, { ...ctx, denies: [...ctx.denies, d] }, p)) expect(before).toBe(true);
        if (before) expect(canInScope(authz, { ...ctx, grants: [...ctx.grants, g] }, p)).toBe(true);
      }),
      RUNS,
    );
  });

  it('an unknown permission or an unknown role never grants', () => {
    fc.assert(
      fc.property(ctxArb, (ctx) => {
        expect(canInScope(authz, ctx, 'tasks.unknown')).toBe(false);
        const ghostOnly: ScopeContext = {
          ...ctx,
          orgRole: 'ghost',
          grants: ctx.grants.map((g) => ({ ...g, role: 'ghost' })),
        };
        for (const p of authz.permissions) expect(canInScope(authz, ghostOnly, p)).toBe(false);
      }),
      RUNS,
    );
  });

  it('mayAssignInScope only allows roles whose every permission the caller holds there', () => {
    fc.assert(
      fc.property(ctxArb, fc.constantFrom(...ROLES), (ctx, role) => {
        if (!mayAssignInScope(authz, ctx, role)) return;
        expect(authz.hasRole(role)).toBe(true);
        for (const p of authz.permissionsOf(role)) expect(canInScope(authz, ctx, p)).toBe(true);
      }),
      RUNS,
    );
  });

  it('effectivePermissions is exactly the set canInScope allows', () => {
    fc.assert(
      fc.property(ctxArb, (ctx) => {
        expect(effectivePermissions(authz, ctx)).toEqual(
          authz.permissions.filter((p) => canInScope(authz, ctx, p)),
        );
      }),
      RUNS,
    );
  });
});

describe('canInScope examples', () => {
  const base: ScopeContext = { orgRole: 'guest', chain: ['t1', 'p1'], grants: [], denies: [] };

  it('a team grant reaches the team and its projects, not the sibling team', () => {
    const ctx = { ...base, grants: [{ scopeId: 't1', role: 'member' }] };
    expect(canInScope(authz, { ...ctx, chain: ['t1'] }, 'tasks.update')).toBe(true);
    expect(canInScope(authz, { ...ctx, chain: ['t1', 'p2'] }, 'tasks.update')).toBe(true);
    expect(canInScope(authz, { ...ctx, chain: ['t2', 'p3'] }, 'tasks.update')).toBe(false);
    expect(canInScope(authz, { ...ctx, chain: [] }, 'tasks.update')).toBe(false);
  });

  it('a project grant does not reach the team above it', () => {
    const ctx = { ...base, grants: [{ scopeId: 'p1', role: 'member' }] };
    expect(canInScope(authz, ctx, 'tasks.update')).toBe(true);
    expect(canInScope(authz, { ...ctx, chain: ['t1'] }, 'tasks.update')).toBe(false);
  });

  it('a deny on a project blocks even the org owner there, and only there', () => {
    const ctx = {
      ...base,
      orgRole: 'owner',
      denies: [{ scopeId: 'p1', permission: 'tasks.delete' }],
    };
    expect(canInScope(authz, ctx, 'tasks.delete')).toBe(false);
    expect(canInScope(authz, ctx, 'tasks.update')).toBe(true);
    expect(canInScope(authz, { ...ctx, chain: ['t1', 'p2'] }, 'tasks.delete')).toBe(true);
    expect(canInScope(authz, { ...ctx, chain: ['t1'] }, 'tasks.delete')).toBe(true);
  });

  it('a deny on a team wins over a grant on its project', () => {
    const ctx = {
      ...base,
      grants: [{ scopeId: 'p1', role: 'member' }],
      denies: [{ scopeId: 't1', permission: 'tasks.update' }],
    };
    expect(canInScope(authz, ctx, 'tasks.update')).toBe(false);
  });

  it('a malformed chain denies everything', () => {
    for (const chain of [
      ['t1', 't1'],
      ['t1', 'p1', 'p2'],
    ]) {
      expect(canInScope(authz, { ...base, orgRole: 'owner', chain }, 'tasks.read')).toBe(false);
    }
  });

  it('an error while deciding is a denial', () => {
    const broken = { ...base, orgRole: 'owner', grants: null } as unknown as ScopeContext;
    const throwing = {
      ...base,
      get denies(): never {
        throw new Error('boom');
      },
    } as ScopeContext;
    expect(canInScope(authz, broken, 'tasks.read')).toBe(true); // org role alone suffices
    expect(canInScope(authz, throwing, 'tasks.read')).toBe(false);
    expect(canInScope(authz, base, 42)).toBe(false);
  });

  it('a lead cannot assign the owner role in a scope, but can assign member', () => {
    const lead: ScopeContext = { ...base, grants: [{ scopeId: 't1', role: 'lead' }] };
    expect(mayAssignInScope(authz, lead, 'owner')).toBe(false);
    expect(mayAssignInScope(authz, lead, 'member')).toBe(true);
    const denied = { ...lead, denies: [{ scopeId: 'p1', permission: 'tasks.update' }] };
    expect(mayAssignInScope(authz, denied, 'member')).toBe(false);
    expect(mayAssignInScope(authz, lead, 'ghost')).toBe(false);
  });
});
