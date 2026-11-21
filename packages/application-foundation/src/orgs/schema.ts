import { index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from '../auth/schema.js';
import { timestamps } from '../db/columns.js';
import { tenantTable } from '../tenancy/tenant-table.js';

/** Tenant table (migration 0004). Holds the sha256 of the invite token, never the token. */
export const invitations = tenantTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('invitations_token_hash_unique').on(table.tokenHash),
    index('invitations_org_id_idx').on(table.orgId),
  ],
);

export type Invitation = typeof invitations.$inferSelect;
