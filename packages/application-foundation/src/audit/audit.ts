import { auditEvents } from '../db/schema.js';
import type { OrgId, UserId } from '../tenancy/ids.js';
import type { TenantTx } from '../tenancy/with-tenant.js';

export type AuditOutcome = 'allowed' | 'denied' | 'success' | 'failure';

/** One audit event. No secrets and no payloads: identifiers and outcome only (security.md). */
export interface AuditRecord {
  readonly actorId: UserId | null;
  /** Must be the transaction's org, or null (RLS insert policy, migration 0002). */
  readonly orgId: OrgId | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly outcome: AuditOutcome;
  readonly requestId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Writes an audit event in the caller's transaction, so it commits or rolls back
 * with the change it describes. The table is append-only (no UPDATE or DELETE
 * grant). No RETURNING: rows without an org can be inserted but not read back.
 */
export async function writeAudit(tx: TenantTx, record: AuditRecord): Promise<void> {
  await tx.insert(auditEvents).values({
    actorId: record.actorId,
    orgId: record.orgId,
    action: record.action,
    resourceType: record.resourceType,
    // Only ids go into the audit log. Anything else (a token, free text) is dropped.
    resourceId:
      record.resourceId !== null && UUID.test(record.resourceId) ? record.resourceId : null,
    outcome: record.outcome,
    requestId: record.requestId,
  });
}
