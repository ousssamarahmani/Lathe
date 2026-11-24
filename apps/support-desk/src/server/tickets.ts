import {
  ActionError,
  can,
  defineAction,
  memberships,
  users,
  type OrgActionContext,
} from '@lathe/application-foundation';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { authz, canWorkTickets } from './authz';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  ticketComments,
  tickets,
  type TicketCommentRow,
  type TicketRow,
} from './schema';

/**
 * Support Desk ticket actions (task P6-01). Every action is `defineAction`, so the
 * handler runs inside `withTenant(activeOrg)` and RLS limits it to the org; queries
 * also filter on `ctx.orgId`.
 *
 * Visibility inside the org: a member without `tickets.read_all` (a requester) sees
 * only tickets they opened, and never internal notes. A ticket they cannot see answers
 * 404, exactly like a ticket that does not exist or belongs to another org.
 */

export interface Ticket {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: (typeof TICKET_STATUSES)[number];
  readonly priority: (typeof TICKET_PRIORITIES)[number];
  readonly requesterId: string;
  readonly assigneeMembershipId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface Comment {
  readonly id: string;
  readonly ticketId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly body: string;
  readonly internal: boolean;
  readonly createdAt: string;
}

/** The org id is deliberately not part of any response. */
const toTicket = (r: TicketRow): Ticket => ({
  id: r.id,
  title: r.title,
  body: r.body,
  status: r.status,
  priority: r.priority,
  requesterId: r.requesterId,
  assigneeMembershipId: r.assigneeMembershipId,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  closedAt: r.closedAt ? r.closedAt.toISOString() : null,
});

const notFound = (): never => {
  throw new ActionError('not_found', 'not found');
};

const seesAll = (ctx: OrgActionContext): boolean =>
  can(authz, ctx.membership.role, 'tickets.read_all');

/** The visibility rule as a SQL condition: all of the org, or only the caller's own. */
function visible(ctx: OrgActionContext): SQL | undefined {
  return and(
    eq(tickets.orgId, ctx.orgId),
    seesAll(ctx) ? undefined : eq(tickets.requesterId, ctx.principal.userId),
  );
}

/** Loads one ticket the caller may see, locked for update when `forUpdate`. */
async function findTicket(ctx: OrgActionContext, id: string, forUpdate = false) {
  const q = ctx.tx
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, id), visible(ctx)));
  const [row] = forUpdate ? await q.for('update') : await q;
  return row ?? notFound();
}

const Title = z.string().trim().min(1).max(200);
const Body = z.string().max(20_000);
const Status = z.enum(TICKET_STATUSES);
const Priority = z.enum(TICKET_PRIORITIES);
const TicketRef = z.strictObject({ id: z.uuid() });

const PAGE_MAX = 100;
const Cursor = z.strictObject({ t: z.iso.datetime(), id: z.uuid() });

export function encodeCursor(t: Pick<Ticket, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ t: t.createdAt, id: t.id })).toString('base64url');
}

function decodeCursor(value: string): z.infer<typeof Cursor> {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new ActionError('validation_failed', 'invalid input: cursor');
  }
}

export const listTickets = defineAction(authz, {
  permission: 'tickets.list',
  resourceType: 'ticket',
  input: z.strictObject({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_MAX).optional(),
    status: Status.optional(),
    /** `me`: only tickets assigned to the caller. */
    assignee: z.literal('me').optional(),
  }),
  handler: async (ctx, input) => {
    const limit = input.limit ?? 50;
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const rows = await ctx.tx
      .select()
      .from(tickets)
      .where(
        and(
          visible(ctx),
          input.status ? eq(tickets.status, input.status) : undefined,
          input.assignee === 'me' ? eq(tickets.assigneeMembershipId, ctx.membership.id) : undefined,
          after
            ? sql`(${tickets.createdAt}, ${tickets.id}) < (${after.t}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(tickets.createdAt), desc(tickets.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit).map(toTicket);
    const last = page.at(-1);
    return { items: page, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  },
});

export const getTicket = defineAction(authz, {
  permission: 'tickets.read',
  resourceType: 'ticket',
  input: TicketRef,
  handler: async (ctx, input) => toTicket(await findTicket(ctx, input.id)),
  resourceId: (t) => t.id,
});

export const createTicket = defineAction(authz, {
  permission: 'tickets.create',
  resourceType: 'ticket',
  input: z.strictObject({
    title: Title,
    body: Body.optional(),
    // Only staff choose a priority; a requester's ticket starts as normal.
    priority: Priority.optional(),
  }),
  handler: async (ctx, input) => {
    if (input.priority !== undefined && !can(authz, ctx.membership.role, 'tickets.triage')) {
      throw new ActionError('forbidden', 'only staff set the priority');
    }
    const [row] = await ctx.tx
      .insert(tickets)
      .values({
        orgId: ctx.orgId,
        title: input.title,
        body: input.body ?? '',
        priority: input.priority ?? 'normal',
        requesterId: ctx.principal.userId,
      })
      .returning();
    if (!row) throw new Error('insert into tickets returned no row');
    return toTicket(row);
  },
  resourceId: (t) => t.id,
});

/**
 * Edits a ticket. Title and body: the requester of the ticket or staff. Status and
 * priority: staff only (`tickets.triage`). A closed ticket can only be reopened.
 */
export const updateTicket = defineAction(authz, {
  permission: 'tickets.update',
  resourceType: 'ticket',
  input: TicketRef.extend({
    title: Title.optional(),
    body: Body.optional(),
    status: Status.optional(),
    priority: Priority.optional(),
  }).refine(
    (v) =>
      v.title !== undefined ||
      v.body !== undefined ||
      v.status !== undefined ||
      v.priority !== undefined,
    'nothing to update',
  ),
  handler: async (ctx, input) => {
    const current = await findTicket(ctx, input.id, true);
    const triage = input.status !== undefined || input.priority !== undefined;
    if (triage && !can(authz, ctx.membership.role, 'tickets.triage')) {
      throw new ActionError('forbidden', 'only staff change status or priority');
    }
    const editsText = input.title !== undefined || input.body !== undefined;
    if (current.status === 'closed' && (editsText || (input.status ?? 'closed') === 'closed')) {
      throw new ActionError('conflict', 'a closed ticket can only be reopened');
    }
    const status = input.status ?? current.status;
    const [row] = await ctx.tx
      .update(tickets)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        status,
        closedAt: status === 'closed' ? (current.closedAt ?? sql`now()`) : null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(tickets.id, current.id), eq(tickets.orgId, ctx.orgId)))
      .returning();
    return row ? toTicket(row) : notFound();
  },
  resourceId: (t) => t.id,
});

/** Assigns a ticket to a staff member of the org, or unassigns it (`membershipId: null`). */
export const assignTicket = defineAction(authz, {
  permission: 'tickets.assign',
  action: 'ticket.assign',
  resourceType: 'ticket',
  input: TicketRef.extend({ membershipId: z.uuid().nullable() }),
  handler: async (ctx, input) => {
    const current = await findTicket(ctx, input.id, true);
    if (input.membershipId !== null) {
      const [target] = await ctx.tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.id, input.membershipId), eq(memberships.orgId, ctx.orgId)));
      // A membership of another org looks like one that does not exist.
      if (!target) notFound();
      else if (!canWorkTickets(target.role)) {
        throw new ActionError('validation_failed', 'tickets can only be assigned to staff');
      }
    }
    const [row] = await ctx.tx
      .update(tickets)
      .set({ assigneeMembershipId: input.membershipId, updatedAt: sql`now()` })
      .where(and(eq(tickets.id, current.id), eq(tickets.orgId, ctx.orgId)))
      .returning();
    return row ? toTicket(row) : notFound();
  },
  resourceId: (t) => t.id,
});

const toComment = (r: TicketCommentRow & { authorName: string }): Comment => ({
  id: r.id,
  ticketId: r.ticketId,
  authorId: r.authorId,
  authorName: r.authorName,
  body: r.body,
  internal: r.internal,
  createdAt: r.createdAt.toISOString(),
});

export const listComments = defineAction(authz, {
  permission: 'comments.list',
  resourceType: 'ticket_comment',
  input: TicketRef,
  handler: async (ctx, input) => {
    const ticket = await findTicket(ctx, input.id);
    const internal = can(authz, ctx.membership.role, 'comments.internal');
    const rows = await ctx.tx
      .select({
        id: ticketComments.id,
        orgId: ticketComments.orgId,
        ticketId: ticketComments.ticketId,
        authorId: ticketComments.authorId,
        body: ticketComments.body,
        internal: ticketComments.internal,
        createdAt: ticketComments.createdAt,
        authorName: users.name,
      })
      .from(ticketComments)
      .innerJoin(users, eq(users.id, ticketComments.authorId))
      .where(
        and(
          eq(ticketComments.orgId, ctx.orgId),
          eq(ticketComments.ticketId, ticket.id),
          internal ? undefined : eq(ticketComments.internal, false),
        ),
      )
      .orderBy(asc(ticketComments.createdAt), asc(ticketComments.id));
    return rows.map(toComment);
  },
  resourceId: (_r, input) => input.id,
});

export const addComment = defineAction(authz, {
  permission: 'comments.create',
  resourceType: 'ticket_comment',
  input: TicketRef.extend({
    body: z.string().trim().min(1).max(10_000),
    internal: z.boolean().optional(),
  }),
  handler: async (ctx, input) => {
    const ticket = await findTicket(ctx, input.id);
    if (input.internal && !can(authz, ctx.membership.role, 'comments.internal')) {
      throw new ActionError('forbidden', 'only staff write internal notes');
    }
    if (ticket.status === 'closed') throw new ActionError('conflict', 'the ticket is closed');
    const [row] = await ctx.tx
      .insert(ticketComments)
      .values({
        orgId: ctx.orgId,
        ticketId: ticket.id,
        authorId: ctx.principal.userId,
        body: input.body,
        internal: input.internal ?? false,
      })
      .returning();
    if (!row) throw new Error('insert into ticket_comments returned no row');
    const [author] = await ctx.tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, ctx.principal.userId));
    return toComment({ ...row, authorName: author?.name ?? '' });
  },
  resourceId: (c) => c.id,
});
