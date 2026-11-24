import { text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from '../auth/schema.js';
import { tenantTable } from '../tenancy/tenant-table.js';

/**
 * Tables of task P7-01 (migration 0005). The composite, org-qualified foreign keys
 * and the shape check (team under the org, project under a team) live in the SQL
 * migration, which is the source of truth; Drizzle is used for typed queries only.
 */
export const scopes = tenantTable('scopes', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull().$type<'team' | 'project'>(),
  parentId: uuid('parent_id'),
  parentKind: text('parent_kind').$type<'team'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const scopeGrants = tenantTable('scope_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  scopeId: uuid('scope_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  role: text('role').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const scopeDenies = tenantTable('scope_denies', {
  id: uuid('id').primaryKey().defaultRandom(),
  scopeId: uuid('scope_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  permission: text('permission').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Scope = typeof scopes.$inferSelect;
export type ScopeGrantRow = typeof scopeGrants.$inferSelect;
export type ScopeDenyRow = typeof scopeDenies.$inferSelect;
