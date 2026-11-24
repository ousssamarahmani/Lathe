import { ActionError, defineAction } from '@lathe/application-foundation';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { authz } from './authz';
import { notes, type NoteRow } from './schema';

/**
 * The example resource: notes CRUD. Extension point: each action is
 * `defineAction(authz, { permission, input, resourceType, handler })`; the
 * handler runs inside `withTenant(activeOrg)`, so RLS scopes every query.
 * Queries also filter on `ctx.orgId` as a second line of defense.
 */

export interface Note {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The org id is deliberately not part of the response. */
const toNote = (r: NoteRow): Note => ({
  id: r.id,
  title: r.title,
  body: r.body,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const Title = z.string().trim().min(1).max(200);
const Body = z.string().max(10_000);
const NoteRef = z.strictObject({ id: z.uuid() });

const PAGE_MAX = 100;
const Cursor = z.strictObject({ t: z.iso.datetime(), id: z.uuid() });

export function encodeCursor(note: Pick<Note, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ t: note.createdAt, id: note.id })).toString('base64url');
}

function decodeCursor(value: string): z.infer<typeof Cursor> {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new ActionError('validation_failed', 'invalid input: cursor');
  }
}

const notFound = (): never => {
  // Same answer for "does not exist" and "belongs to another org".
  throw new ActionError('not_found', 'not found');
};

export const listNotes = defineAction(authz, {
  permission: 'notes.list',
  resourceType: 'note',
  input: z.strictObject({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_MAX).optional(),
  }),
  handler: async ({ tx, orgId }, input) => {
    const limit = input.limit ?? 50;
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const rows = await tx
      .select()
      .from(notes)
      .where(
        and(
          eq(notes.orgId, orgId),
          after
            ? sql`(${notes.createdAt}, ${notes.id}) < (${after.t}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(notes.createdAt), desc(notes.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit).map(toNote);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  },
});

export const getNote = defineAction(authz, {
  permission: 'notes.read',
  resourceType: 'note',
  input: NoteRef,
  handler: async ({ tx, orgId }, input) => {
    const [row] = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, input.id), eq(notes.orgId, orgId)));
    return row ? toNote(row) : notFound();
  },
  resourceId: (note) => note.id,
});

export const createNote = defineAction(authz, {
  permission: 'notes.create',
  resourceType: 'note',
  input: z.strictObject({ title: Title, body: Body.optional() }),
  handler: async ({ tx, orgId, principal }, input) => {
    const [row] = await tx
      .insert(notes)
      .values({ orgId, title: input.title, body: input.body ?? '', createdBy: principal.userId })
      .returning();
    if (!row) throw new Error('insert into notes returned no row');
    return toNote(row);
  },
  resourceId: (note) => note.id,
});

export const updateNote = defineAction(authz, {
  permission: 'notes.update',
  resourceType: 'note',
  input: NoteRef.extend({ title: Title.optional(), body: Body.optional() }).refine(
    (v) => v.title !== undefined || v.body !== undefined,
    'nothing to update',
  ),
  handler: async ({ tx, orgId }, input) => {
    const [row] = await tx
      .update(notes)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        updatedAt: sql`now()`,
      })
      .where(and(eq(notes.id, input.id), eq(notes.orgId, orgId)))
      .returning();
    return row ? toNote(row) : notFound();
  },
  resourceId: (note) => note.id,
});

export const deleteNote = defineAction(authz, {
  permission: 'notes.delete',
  resourceType: 'note',
  input: NoteRef,
  handler: async ({ tx, orgId }, input) => {
    const [row] = await tx
      .delete(notes)
      .where(and(eq(notes.id, input.id), eq(notes.orgId, orgId)))
      .returning({ id: notes.id });
    return row ? { id: row.id } : notFound();
  },
  resourceId: (r) => r.id,
});
