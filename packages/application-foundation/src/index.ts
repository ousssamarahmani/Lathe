export { auditEvents, memberships, organizations } from './db/schema.js';
export type {
  AuditEvent,
  Membership,
  NewAuditEvent,
  NewMembership,
  NewOrganization,
  Organization,
} from './db/schema.js';
export { runMigrations, type MigrateOptions } from './db/migrate.js';
export {
  accounts,
  createAuth,
  getPrincipal,
  rateLimits,
  seedDemo,
  sessions,
  users,
  verifications,
  type Auth,
  type AuthConfig,
  type DemoSeed,
  type DemoUser,
  type Principal,
  type SeededUser,
  type Session,
  type User,
} from './auth/index.js';
export {
  parseOrgId,
  parseUserId,
  registeredTenantTables,
  tenantTable,
  withTenant,
  withUser,
  type OrgId,
  type TenantTx,
  type UserId,
} from './tenancy/index.js';

export {
  OWNER_ROLE,
  OrgError,
  acceptInvitation,
  changeRole,
  createInvitation,
  createOrganization,
  hashInviteToken,
  invitations,
  isInviteToken,
  listMyMemberships,
  newInviteToken,
  removeMember,
  setActiveOrg,
  type Caller,
  type Invitation,
  type MembershipSummary,
  type OrgDeps,
  type OrgErrorCode,
} from './orgs/index.js';

export {
  ActionError,
  USER_PERMISSIONS,
  can,
  defineAction,
  defineAuthz,
  defineOrgActions,
  defineUserAction,
  isWithin,
  type Action,
  type ActionDeps,
  type ActionErrorCode,
  type ActionRequest,
  type ActionResult,
  type Authz,
  type OrgActionContext,
  type UserActionContext,
  type UserPermission,
} from './authz/index.js';
export { writeAudit, type AuditOutcome, type AuditRecord } from './audit/index.js';

export const PACKAGE_NAME = '@lathe/application-foundation';

export function packageName(): string {
  return PACKAGE_NAME;
}
