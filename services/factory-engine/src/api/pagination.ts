import { ActionError } from '@lathe/application-foundation';
import type { ListQuery } from '@lathe/shared-contracts';
import type { PageQuery, PageResult } from './store.js';

export const DEFAULT_PAGE_SIZE = 25;

const CURSOR = /^(0|[1-9][0-9]{0,8})$/;

/** Parses the validated `ListQuery` strings. A cursor is an opaque offset; a bad one is a validation error. */
export function toPageQuery(query: ListQuery): PageQuery {
  if (query.cursor !== undefined && !CURSOR.test(query.cursor)) {
    throw new ActionError('validation_failed', 'invalid input: cursor');
  }
  return {
    cursor: query.cursor,
    limit: query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(query.limit),
  };
}

/** Offset pagination over an ordered array (used by the in-memory store). */
export function paginate<T>(items: readonly T[], query: PageQuery): PageResult<T> {
  const start = query.cursor === undefined ? 0 : Number(query.cursor);
  const slice = items.slice(start, start + query.limit);
  const end = start + slice.length;
  return { items: slice, nextCursor: end < items.length ? String(end) : null };
}
