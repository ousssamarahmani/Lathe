export {
  ActionError,
  defineAction,
  defineScopedAction,
  defineUserAction,
  type Action,
  type ActionDeps,
  type ActionErrorCode,
  type ActionRequest,
  type ActionResult,
  type OrgActionContext,
  type ScopedActionContext,
  type UserActionContext,
} from './action.js';
export {
  MAX_SCOPE_DEPTH,
  canInScope,
  effectivePermissions,
  mayAssignInScope,
  type ScopeContext,
  type ScopeDeny,
  type ScopeGrant,
  type ScopeKind,
} from './hierarchy.js';
export { defineOrgActions } from './org-actions.js';
export { defineScopeActions } from './scope-actions.js';
export {
  USER_PERMISSIONS,
  can,
  defineAuthz,
  isWithin,
  type Authz,
  type UserPermission,
} from './policy.js';
