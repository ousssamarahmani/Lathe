import { tenantTable, users } from '@lathe/application-foundation';
import { boolean, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const TICKET_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/**
 * Tenant tables of Support Desk (task P6-01). The org-qualified foreign keys, checks
 * and grants live in `migrations/support-desk_0001_tickets.sql`, the source of truth.
 */
export const tickets = tenantTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    status: text('status').notNull().default('open').$type<TicketStatus>(),
    priority: text('priority').notNull().default('normal').$type<TicketPriority>(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assigneeMembershipId: uuid('assignee_membership_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('tickets_org_id_created_at_idx').on(t.orgId, t.createdAt, t.id)],
);

export const ticketComments = tenantTable('ticket_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull(),
  authorId: uuid('author_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  internal: boolean('internal').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type TicketRow = typeof tickets.$inferSelect;
export type TicketCommentRow = typeof ticketComments.$inferSelect;
