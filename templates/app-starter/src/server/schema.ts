import { tenantTable, users } from '@lathe/application-foundation';
import { index, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Example tenant resource. Extension point: define every tenant table with
 * `tenantTable()` (it adds `org_id`), and give it RLS in a migration under
 * `migrations/` (see the notes migration for the pattern).
 */
export const notes = tenantTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notes_org_id_created_at_idx').on(t.orgId, t.createdAt, t.id)],
);

export type NoteRow = typeof notes.$inferSelect;
