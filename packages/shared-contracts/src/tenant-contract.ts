/**
 * C1 Tenant contract.
 *
 * Status: FROZEN, v1, 2026-11-22 (task P1-06). Changes need a handoff request to `architect`.
 * Owner: architect.
 * Producers: every app built on the foundation exports one contract
 *   (`apps/support-desk`, `apps/team-operations`, `templates/app-starter`).
 * Consumers:
 *   - `packages/verification-harness`: tenant isolation, RBAC matrix and
 *     deny-by-default suites learn about an app only through this contract.
 *   - apps validate their contract with `defineTenantContract` at startup and in tests.
 *
 * P1-06 answers B's questions Q1 to Q5 (docs/handoffs/architect-to-consumers-contracts-v1.md):
 *   Q1 harness login: `session` names the sign-in and active-org routes; `principals`
 *      lists one test user per role in org A and in org B. Their password comes from
 *      the environment variable named in `passwordEnv`; the contract never holds it.
 *      `passwordEnv` must match `^LATHE_TEST_[A-Z0-9_]*PASSWORD$` and the harness resolves
 *      only names matching it, so a contract cannot make the harness read GITHUB_TOKEN,
 *      KIRO_API_KEY, database URLs or other real secrets. `actions[].sample`, `markField`
 *      and `idField` describe the request bodies the suites send and the id they read back.
 *   Q2 server actions: every contract action is an HTTP route. A Next.js server action
 *      must call the same `defineAction` and is not listed separately.
 *   Q3 foundation tables: `organizations` (kind `organization`) and `audit_events`
 *      (kind `audit`, append-only) are declared and checked like tenant tables. Exactly one
 *      table of each kind is required and no update or delete action may target the audit table.
 *   Q4 hierarchy (org, team, project): not in v1. Task P7-01 adds it as v2.
 *   Q5 actions on several tables: `table` is the main target; `alsoTouches` lists the rest.
 *
 * Security rules encoded here (`.kiro/steering/security.md`):
 *   - every table has row-level security enabled and forced;
 *   - tenant tables are scoped by `org_id`; the audit table is append-only;
 *   - permissions are explicit `resource.verb` names, so `*` cannot be declared;
 *   - roles and actions may only use declared permissions and tables;
 *   - every role has a test principal in both orgs, so no role escapes the suites.
 */
import { z } from 'zod';
import { Slug, SqlIdentifier } from './common.js';

/** Permission name in `resource.verb` form, for example `tickets.read`. */
export const PermissionName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'expected a permission such as tickets.read');
export type PermissionName = z.infer<typeof PermissionName>;

/** Role name, for example `agent` or `org_admin`. */
export const RoleName = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,39}$/, 'expected a lowercase role name');
export type RoleName = z.infer<typeof RoleName>;

const Rls = z.strictObject({ enabled: z.literal(true), forced: z.literal(true) });

/** A table holding tenant data, created with `tenantTable()`. */
export const TenantTable = z.strictObject({
  kind: z.literal('tenant'),
  name: SqlIdentifier,
  orgColumn: z.literal('org_id'),
  primaryKey: SqlIdentifier,
  rls: Rls,
});
export type TenantTable = z.infer<typeof TenantTable>;

/** The foundation's `organizations` table: its `id` is the org. */
export const OrganizationTable = z.strictObject({
  kind: z.literal('organization'),
  name: z.literal('organizations'),
  primaryKey: z.literal('id'),
  rls: Rls,
});

/** The foundation's `audit_events` table: `org_id` may be null (denied before an org is known), append-only. */
export const AuditTable = z.strictObject({
  kind: z.literal('audit'),
  name: z.literal('audit_events'),
  orgColumn: z.literal('org_id'),
  appendOnly: z.literal(true),
  rls: Rls,
});

export const ContractTable = z.discriminatedUnion('kind', [
  TenantTable,
  OrganizationTable,
  AuditTable,
]);
export type ContractTable = z.infer<typeof ContractTable>;

export const ActionKind = z.enum(['read', 'list', 'create', 'update', 'delete', 'custom']);
export type ActionKind = z.infer<typeof ActionKind>;

/** An HTTP route, with `:param` segments in the path. */
export const HttpRoute = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().regex(/^\/[A-Za-z0-9/_:.-]*$/, 'expected a path template starting with /'),
});
export type HttpRoute = z.infer<typeof HttpRoute>;

/**
 * Seed script path, relative to the app root (not the repo root). The seed runs as the
 * app DB role, never the owner role. Absolute paths, backslashes, drive letters, `..`
 * segments and the `.github/`, `packages/` and `node_modules/` prefixes are rejected.
 */
export const AppRelativePath = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith('/'), 'must not start with /')
  .refine((p) => !p.includes('\\'), 'must not contain backslashes')
  .refine((p) => !/^[A-Za-z]:/.test(p), 'must not start with a drive letter')
  .refine((p) => !p.split('/').includes('..'), 'must not contain .. segments')
  .refine(
    (p) => !['.github/', 'packages/', 'node_modules/'].some((x) => p.startsWith(x)),
    'must not start with .github/, packages/ or node_modules/',
  );

/** A body field value the suites may send. */
export const SampleValue = z.union([z.string(), z.number(), z.boolean()]);

/** A route the harness calls to exercise a table. Every route goes through `defineAction`. */
export const TenantAction = z.strictObject({
  /** Stable id, for example `tickets.get`. */
  id: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  permission: PermissionName,
  kind: ActionKind,
  /** Main table the action reads or writes. */
  table: SqlIdentifier,
  /** Other tables it writes or reads (Q5). */
  alsoTouches: z.array(SqlIdentifier).max(10).optional(),
  http: HttpRoute,
  /** Create and update only: the request body the suites send. */
  sample: z.record(z.string(), SampleValue).optional(),
  /** Create and update only: a key of `sample` the suites may change to mark a row. */
  markField: z.string().min(1).optional(),
  /** Name of the response field carrying the resource id. Defaults to `id`. */
  idField: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
});
export type TenantAction = z.infer<typeof TenantAction>;

export const Role = z.strictObject({ name: RoleName, permissions: z.array(PermissionName) });
export type Role = z.infer<typeof Role>;

/** A test user the harness signs in as (Q1). Emails must be on a reserved test domain. */
export const Principal = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  email: z
    .email()
    .refine((e) => /@[a-z0-9.-]*\.(test|example)$/.test(e), 'use a .test or .example domain'),
  org: z.enum(['a', 'b']),
  role: RoleName,
});
export type Principal = z.infer<typeof Principal>;

/** How the harness creates the two orgs, their data and the principals. */
export const TenantFixtures = z.discriminatedUnion('strategy', [
  /** Principals and orgs exist after running this script; data is created through the actions. */
  z.strictObject({ strategy: z.literal('seed-script'), script: AppRelativePath }),
]);
export type TenantFixtures = z.infer<typeof TenantFixtures>;

export const TenantContract = z
  .strictObject({
    contractVersion: z.literal(1),
    app: Slug,
    permissions: z.array(PermissionName).min(1),
    roles: z.array(Role).min(1),
    tables: z.array(ContractTable).min(1),
    actions: z.array(TenantAction).min(1),
    /** Routes the harness uses to sign in and to choose the active org (Q1). */
    session: z.strictObject({ signIn: HttpRoute, setActiveOrg: HttpRoute }),
    principals: z.array(Principal).min(2),
    /**
     * Name of the environment variable holding the principals' password. Never the value.
     * The harness resolves only names matching this pattern.
     */
    passwordEnv: z
      .string()
      .regex(/^LATHE_TEST_[A-Z0-9_]*PASSWORD$/, 'expected LATHE_TEST_<name>PASSWORD'),
    fixtures: TenantFixtures,
  })
  .superRefine((c, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const dup = <T>(xs: readonly T[]): T[] => [
      ...new Set(xs.filter((x, i) => xs.indexOf(x) !== i)),
    ];
    const declared = new Set(c.permissions);
    const tables = new Set(c.tables.map((t) => t.name));
    const roles = new Set(c.roles.map((r) => r.name));

    for (const p of dup(c.permissions)) issue(['permissions'], `duplicate permission ${p}`);
    for (const r of dup(c.roles.map((x) => x.name))) issue(['roles'], `duplicate role ${r}`);
    for (const t of dup(c.tables.map((x) => x.name))) issue(['tables'], `duplicate table ${t}`);
    for (const a of dup(c.actions.map((x) => x.id))) issue(['actions'], `duplicate action ${a}`);
    for (const r of dup(c.actions.map((x) => `${x.http.method} ${x.http.path}`)))
      issue(['actions'], `duplicate route ${r}`);
    for (const k of dup(c.principals.map((x) => x.key)))
      issue(['principals'], `duplicate principal ${k}`);
    for (const e of dup(c.principals.map((x) => x.email.toLowerCase())))
      issue(['principals'], `duplicate email ${e}`);
    if (!c.tables.some((t) => t.kind === 'tenant'))
      issue(['tables'], 'at least one tenant table is required');

    for (const kind of ['organization', 'audit'] as const) {
      const n = c.tables.filter((t) => t.kind === kind).length;
      if (n !== 1) issue(['tables'], `exactly one ${kind} table is required, found ${n}`);
    }
    const auditName = c.tables.find((t) => t.kind === 'audit')?.name;

    c.roles.forEach((role, i) => {
      role.permissions.forEach((p, j) => {
        if (!declared.has(p))
          issue(
            ['roles', i, 'permissions', j],
            `role ${role.name} grants undeclared permission ${p}`,
          );
      });
      for (const org of ['a', 'b'] as const) {
        if (!c.principals.some((p) => p.role === role.name && p.org === org))
          issue(['principals'], `role ${role.name} has no principal in org ${org}`);
      }
    });
    c.actions.forEach((a, i) => {
      if ((a.kind === 'update' || a.kind === 'delete') && a.table === auditName)
        issue(
          ['actions', i, 'table'],
          `action ${a.id} may not ${a.kind} the append-only audit table`,
        );
      const segs = a.http.path.split('/');
      const hasParam = segs.some((s) => s.startsWith(':'));
      const endsWithParam = (segs[segs.length - 1] ?? '').startsWith(':');
      if ((a.kind === 'read' || a.kind === 'update' || a.kind === 'delete') && !hasParam)
        issue(['actions', i, 'http', 'path'], `${a.kind} action ${a.id} needs a :param segment`);
      if ((a.kind === 'list' || a.kind === 'create') && endsWithParam)
        issue(
          ['actions', i, 'http', 'path'],
          `${a.kind} action ${a.id} must not end with a :param`,
        );
      if (a.kind !== 'create' && a.kind !== 'update') {
        if (a.sample) issue(['actions', i, 'sample'], 'sample is only for create and update');
        if (a.markField)
          issue(['actions', i, 'markField'], 'markField is only for create and update');
      }
      if (a.markField !== undefined && !(a.sample && a.markField in a.sample))
        issue(['actions', i, 'markField'], 'markField must be a key of sample');
      if (!declared.has(a.permission))
        issue(
          ['actions', i, 'permission'],
          `action ${a.id} uses undeclared permission ${a.permission}`,
        );
      if (!tables.has(a.table))
        issue(['actions', i, 'table'], `action ${a.id} targets undeclared table ${a.table}`);
      (a.alsoTouches ?? []).forEach((t, j) => {
        if (!tables.has(t))
          issue(['actions', i, 'alsoTouches', j], `action ${a.id} touches undeclared table ${t}`);
      });
    });
    c.principals.forEach((p, i) => {
      if (!roles.has(p.role))
        issue(['principals', i, 'role'], `principal ${p.key} has undeclared role ${p.role}`);
    });
  });
export type TenantContract = z.infer<typeof TenantContract>;
export type TenantContractInput = z.input<typeof TenantContract>;

/**
 * Validates an app's tenant contract. Apps export `defineTenantContract({...})`
 * so an invalid contract fails at import, in tests and in CI, before any suite runs.
 */
export function defineTenantContract(input: TenantContractInput): TenantContract {
  return TenantContract.parse(input);
}
