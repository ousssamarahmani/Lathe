export {
  scopeDenies,
  scopeGrants,
  scopes,
  type Scope,
  type ScopeDenyRow,
  type ScopeGrantRow,
} from './schema.js';
export {
  createScopeInTx,
  denyScopePermissionInTx,
  grantScopeRoleInTx,
  listScopeRulesInTx,
  loadScopeContextInTx,
  removeScopeDenyInTx,
  resolveScopeInTx,
  revokeScopeRoleInTx,
  type ResolvedScope,
  type ScopeRuleInput,
} from './scopes.js';
