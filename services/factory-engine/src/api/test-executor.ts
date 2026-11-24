import { ActionError, can, type ActionResult, type Authz } from '@lathe/application-foundation';
import type { z } from 'zod';
import type { Executor, ExecutorRequest, RouteDefinition } from './executor.js';

/** TEST FIXTURE. Never wired in `main`. Sessions are looked up by `authorization: Bearer <token>`. */
export interface TestSession {
  readonly userId: string;
  /** Org the membership belongs to, or `null` when no org is active. */
  readonly orgId: string | null;
  readonly role: string | null;
}

export interface TestAuditEvent {
  readonly action: string;
  readonly outcome: 'success' | 'denied' | 'failure';
  readonly orgId: string | null;
  readonly requestId: string;
}

/**
 * Mirrors the order of the foundation's `defineAction` (authenticate, active org,
 * membership, `can`, parse input, handler, audit) over an in-memory session table.
 * Real-Postgres behavior of the foundation executor is covered by its own
 * integration tests, not here.
 */
export class TestExecutor implements Executor {
  readonly audit: TestAuditEvent[] = [];
  readonly sessions = new Map<string, TestSession>();

  constructor(private readonly authz: Authz) {}

  register<S extends z.ZodType, T>(definition: RouteDefinition<S, T>) {
    if (!this.authz.permissions.includes(definition.permission)) {
      throw new Error(`permission ${definition.permission} is not declared`);
    }
    return async (request: ExecutorRequest): Promise<ActionResult<T>> => {
      const record = (outcome: TestAuditEvent['outcome'], orgId: string | null) => {
        this.audit.push({
          action: definition.name,
          outcome,
          orgId,
          requestId: request.requestId,
        });
      };
      const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      const session = token === undefined ? undefined : this.sessions.get(token);
      if (!session) {
        record('denied', null);
        return { ok: false, code: 'unauthenticated', message: 'sign in required' };
      }
      if (session.orgId === null || session.role === null) {
        record('denied', null);
        return { ok: false, code: 'forbidden', message: 'no active organization' };
      }
      if (!can(this.authz, session.role, definition.permission)) {
        record('denied', session.orgId);
        return { ok: false, code: 'forbidden', message: 'not allowed' };
      }
      const parsed = definition.input.safeParse(request.input);
      if (!parsed.success) {
        return { ok: false, code: 'validation_failed', message: 'invalid input' };
      }
      try {
        const value = await definition.handler(
          { orgId: session.orgId, userId: session.userId, role: session.role, tx: null },
          parsed.data,
        );
        record('success', session.orgId);
        return { ok: true, value };
      } catch (error) {
        if (error instanceof ActionError) {
          record(error.code === 'forbidden' ? 'denied' : 'failure', session.orgId);
          return { ok: false, code: error.code, message: error.message };
        }
        record('failure', session.orgId);
        throw error;
      }
    };
  }
}
