import { randomUUID } from 'node:crypto';
import type { Action, ActionResult } from '@lathe/application-foundation';
import { headers } from 'next/headers';
import { getDeps } from './deps';

/**
 * Runs an action for a server component, with the visitor's own cookies. Pages
 * read data only this way, so a page gets exactly the checks a route gets:
 * session, membership, permission, tenant transaction and audit.
 */
export async function load<T>(action: Action<T>, input: unknown = {}): Promise<ActionResult<T>> {
  return action(getDeps(), {
    headers: new Headers(await headers()),
    input,
    requestId: randomUUID(),
  });
}
