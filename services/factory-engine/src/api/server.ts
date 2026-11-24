import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ActionError, type ActionErrorCode } from '@lathe/application-foundation';
import {
  ROUTES,
  RunEvent,
  RunEventsQuery,
  SSE_RESUME_HEADER,
  type ApiError,
  type ErrorCode,
  type RouteName,
} from '@lathe/shared-contracts';
import { z } from 'zod';
import { engineAuthz } from './authz.js';
import type { Executor, RouteContext, RouteDefinition } from './executor.js';
import { toPageQuery } from './pagination.js';
import { toSpec, type EngineApiStore } from './store.js';
import { RunStateError } from '../orchestrator/errors.js';
import { isTerminal } from '../orchestrator/state-machine.js';
import { transitionRun, type RunStore } from '../orchestrator/run-store.js';

/**
 * Handler-level conflict reasons. The foundation's `ActionError` has no code for
 * them, so they travel as a `conflict` with a fixed message that this layer maps
 * to the more specific C4 `ErrorCode`.
 */
export const STALE_APPROVAL_MESSAGE = 'the content changed after it was shown';
export const INVALID_STATE_MESSAGE = 'not allowed in the current state';

export interface ApiDeps {
  readonly executor: Executor;
  readonly store: EngineApiStore;
  /** Used only to cancel a run (a non-passing transition). The API never sets a passing state. */
  readonly runStore: RunStore;
  /** Server-generated request id (a UUID). Never read from the client. */
  readonly newRequestId: () => string;
  /** Delay between polls of a live event stream. */
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  stale_approval: 409,
  invalid_state_transition: 409,
  rate_limited: 429,
  internal: 500,
};

function refine(code: ActionErrorCode, message: string): ErrorCode {
  if (code === 'conflict' && message === STALE_APPROVAL_MESSAGE) return 'stale_approval';
  if (code === 'conflict' && message === INVALID_STATE_MESSAGE) return 'invalid_state_transition';
  return code;
}

function sendError(reply: FastifyReply, requestId: string, code: ErrorCode, message: string) {
  const body: ApiError = { code, message, requestId } as ApiError;
  return reply.status(STATUS[code]).send(body);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id can never match a row: it is the same 404 as an unknown one. */
function id(value: string): string {
  if (!UUID.test(value)) throw new ActionError('not_found', 'not found');
  return value;
}

function toHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.append(name, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
  }
  return headers;
}

function paramNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] as string);
}

function inputSchema(name: RouteName) {
  const def: { path: string; request: z.ZodType | null; query?: z.ZodType } = ROUTES[name];
  return z.strictObject({
    params: z.strictObject(
      Object.fromEntries(paramNames(def.path).map((p) => [p, z.string().min(1).max(100)])),
    ),
    query: def.query ?? z.strictObject({}),
    body: def.request ?? z.undefined(),
  });
}

interface Input {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
}

interface RouteImpl<T> {
  readonly name: RouteName;
  readonly resourceType: string;
  readonly successStatus?: 200 | 201;
  readonly handler: (ctx: RouteContext, input: Input) => Promise<T>;
}

function fastifyPath(path: string): string {
  return path; // C4 paths already use `:param` and include `/v1`.
}

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly permission: string;
}

export interface ApiServer {
  readonly app: FastifyInstance;
  /** Every route the server registered, with its declared permission. */
  readonly routes: readonly RegisteredRoute[];
}

export function buildApiServer(deps: ApiDeps): ApiServer {
  const routes: RegisteredRoute[] = [];
  const app = Fastify({
    logger: false,
    exposeHeadRoutes: false,
    genReqId: () => deps.newRequestId(),
    // Bodies are small JSON documents (specs are capped at 100k characters).
    bodyLimit: 256 * 1024,
  });

  // Deny by default: a route registered without a declared permission cannot start.
  app.addHook('onRoute', (options) => {
    const permission = (options.config as { permission?: unknown } | undefined)?.permission;
    if (
      typeof permission !== 'string' ||
      !(engineAuthz.permissions as readonly string[]).includes(permission)
    ) {
      throw new Error(
        `route ${String(options.method)} ${options.url} declares no valid permission`,
      );
    }
    routes.push({ method: String(options.method), url: options.url, permission });
  });

  app.setErrorHandler((error, request, reply) => {
    const e = error as { statusCode?: number; code?: string };
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      return sendError(reply, request.id, 'bad_request', 'malformed request');
    }
    // Never leak internals: the response carries no stack, SQL or path.
    return sendError(reply, request.id, 'internal', 'internal error');
  });
  app.setNotFoundHandler((request, reply) =>
    sendError(reply, request.id, 'not_found', 'not found'),
  );

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  function register<T>(
    impl: RouteImpl<T>,
    respond?: (
      value: T,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown> | unknown,
  ): void {
    const def = ROUTES[impl.name];
    const definition: RouteDefinition<ReturnType<typeof inputSchema>, T> = {
      name: impl.name,
      permission: def.permission,
      resourceType: impl.resourceType,
      input: inputSchema(impl.name),
      handler: (ctx, input) => impl.handler(ctx, input as Input),
    };
    const run = deps.executor.register(definition);
    app.route({
      method: def.method,
      url: fastifyPath(def.path),
      config: { permission: def.permission },
      handler: async (request, reply) => {
        const result = await run({
          headers: toHeaders(request),
          // The client supplies params, query and body only. No org, role or verdict is read from them.
          input: { params: request.params, query: request.query, body: request.body },
          requestId: request.id,
        });
        if (!result.ok) {
          return sendError(
            reply,
            request.id,
            refine(result.code, result.message),
            result.code === 'forbidden' ? 'not allowed' : result.message,
          );
        }
        if (respond) return respond(result.value, request, reply);
        return reply.status(impl.successStatus ?? 200).send(result.value);
      },
    });
  }

  const { store, runStore } = deps;

  register({
    name: 'listProjects',
    resourceType: 'project',
    handler: (ctx, i) => store.listProjects(ctx, toPageQuery(i.query)),
  });
  register({
    name: 'createProject',
    resourceType: 'project',
    successStatus: 201,
    handler: (ctx, i) => store.createProject(ctx, i.body as never),
  });
  register({
    name: 'getProject',
    resourceType: 'project',
    handler: async (ctx, i) => orNotFound(await store.getProject(ctx, id(param(i, 'projectId')))),
  });
  register({
    name: 'listSpecs',
    resourceType: 'spec',
    handler: async (ctx, i) =>
      orNotFound(await store.listSpecs(ctx, id(param(i, 'projectId')), toPageQuery(i.query))),
  });
  register({
    name: 'submitSpec',
    resourceType: 'spec',
    successStatus: 201,
    handler: async (ctx, i) => {
      const body = i.body as { supersedes?: string };
      if (body.supersedes !== undefined) id(body.supersedes);
      return orNotFound(await store.submitSpec(ctx, id(param(i, 'projectId')), i.body as never));
    },
  });
  register({
    name: 'getSpec',
    resourceType: 'spec',
    handler: async (ctx, i) => {
      return toSpec(orNotFound(await store.getSpec(ctx, id(param(i, 'specId')))));
    },
  });
  register({
    name: 'decideSpec',
    resourceType: 'approval',
    successStatus: 201,
    handler: async (ctx, i) => {
      const body = i.body as { decision: 'approved' | 'rejected'; contentSha256: string };
      const spec = orNotFound(await store.getSpec(ctx, id(param(i, 'specId'))));
      // Self-approval is denied: the submitter cannot approve their own spec.
      if (spec.submittedBy === ctx.userId) throw new ActionError('forbidden', 'not allowed');
      if (spec.status !== 'submitted') throw new ActionError('conflict', INVALID_STATE_MESSAGE);
      if (body.contentSha256 !== spec.contentSha256) {
        throw new ActionError('conflict', STALE_APPROVAL_MESSAGE);
      }
      return store.recordApproval(ctx, {
        subjectType: 'spec',
        subjectId: spec.id,
        contentSha256: spec.contentSha256,
        decision: body.decision,
        approverId: ctx.userId,
      });
    },
  });
  register({
    name: 'getPlan',
    resourceType: 'plan',
    handler: async (ctx, i) => orNotFound(await store.getPlan(ctx, id(param(i, 'planId')))),
  });
  register({
    name: 'decidePlan',
    resourceType: 'approval',
    successStatus: 201,
    handler: async (ctx, i) => {
      const body = i.body as { decision: 'approved' | 'rejected'; contentSha256: string };
      const plan = orNotFound(await store.getPlan(ctx, id(param(i, 'planId'))));
      if (plan.status !== 'proposed') throw new ActionError('conflict', INVALID_STATE_MESSAGE);
      if (body.contentSha256 !== plan.contentSha256) {
        throw new ActionError('conflict', STALE_APPROVAL_MESSAGE);
      }
      return store.recordApproval(ctx, {
        subjectType: 'plan',
        subjectId: plan.id,
        contentSha256: plan.contentSha256,
        decision: body.decision,
        approverId: ctx.userId,
      });
    },
  });
  register({
    name: 'listRuns',
    resourceType: 'run',
    handler: async (ctx, i) =>
      orNotFound(await store.listRuns(ctx, id(param(i, 'projectId')), toPageQuery(i.query))),
  });
  register({
    name: 'createRun',
    resourceType: 'run',
    successStatus: 201,
    handler: async (ctx, i) => {
      const body = i.body as { specId: string };
      id(body.specId);
      return orNotFound(await store.createRun(ctx, id(param(i, 'projectId')), i.body as never));
    },
  });
  register({
    name: 'getRun',
    resourceType: 'run',
    handler: async (ctx, i) => orNotFound(await store.getRun(ctx, id(param(i, 'runId')))),
  });
  register({
    name: 'cancelRun',
    resourceType: 'run',
    handler: async (ctx, i) => {
      const runId = id(param(i, 'runId'));
      orNotFound(await store.getRun(ctx, runId));
      try {
        // CANCELLED is a non-passing state: no EngineCapability is needed or given.
        await transitionRun(runStore, runId, 'CANCELLED', { reason: 'cancelled by operator' });
      } catch (error) {
        if (error instanceof RunStateError) {
          if (error.code === 'run_not_found') throw new ActionError('not_found', 'not found');
          throw new ActionError('conflict', INVALID_STATE_MESSAGE, { cause: error });
        }
        throw error;
      }
      return orNotFound(await store.getRun(ctx, runId));
    },
  });
  register({
    name: 'decideDelivery',
    resourceType: 'approval',
    successStatus: 201,
    handler: async (ctx, i) => {
      const body = i.body as { decision: 'approved' | 'rejected'; contentSha256: string };
      const runId = id(param(i, 'runId'));
      orNotFound(await store.getRun(ctx, runId));
      const current = await store.getDeliveryContentHash(ctx, runId);
      if (current === null) throw new ActionError('conflict', INVALID_STATE_MESSAGE);
      if (body.contentSha256 !== current) throw new ActionError('conflict', STALE_APPROVAL_MESSAGE);
      // Records the human decision only. The orchestrator, not the API, moves the run on.
      return store.recordApproval(ctx, {
        subjectType: 'delivery',
        subjectId: runId,
        contentSha256: current,
        decision: body.decision,
        approverId: ctx.userId,
      });
    },
  });

  // Server-Sent Events. The action authenticates, authorizes and checks the run's
  // org; streaming starts only after it succeeded.
  register(
    {
      name: 'streamRunEvents',
      resourceType: 'run',
      handler: async (ctx, i) => {
        const runId = id(param(i, 'runId'));
        orNotFound(await store.getRun(ctx, runId));
        const query = RunEventsQuery.parse(i.query);
        return { ctx: { ...ctx, tx: null } as RouteContext, runId, after: query.after };
      },
    },
    async (value, request, reply) => {
      // No resume id: start before seq 0, so the first event is included.
      let after = -1;
      const header = request.headers[SSE_RESUME_HEADER.toLowerCase()];
      const raw = value.after ?? (typeof header === 'string' ? header : undefined);
      if (raw !== undefined) {
        const parsed = RunEventsQuery.safeParse({ after: raw });
        if (!parsed.success)
          return sendError(reply, request.id, 'bad_request', 'invalid resume id');
        after = Number(raw);
      }
      await streamEvents(reply, value.ctx, value.runId, after);
    },
  );

  async function streamEvents(
    reply: FastifyReply,
    ctx: RouteContext,
    runId: string,
    from: number,
  ): Promise<void> {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    let last = from;
    try {
      while (!closed) {
        // Read the run state first: if it is terminal now, every event already exists.
        const run = await store.getRun(ctx, runId);
        const finished = run === null || isTerminal(run.state);
        const batch = await store.listRunEvents(ctx, runId, last, 100);
        for (const event of batch) {
          const parsed = RunEvent.safeParse(event);
          if (!parsed.success) throw new Error('stored event does not match the C4 schema');
          res.write(
            `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(parsed.data)}\n\n`,
          );
          last = event.seq;
        }
        if (batch.length === 100) continue;
        if (finished) break;
        await sleep(deps.pollMs ?? 1000);
      }
    } catch {
      // Headers are sent already, so the error is reported in-stream, without detail.
      if (!closed) res.write('event: error\ndata: {"code":"internal"}\n\n');
    } finally {
      res.end();
    }
  }

  return { app, routes };
}

function param(input: Input, name: string): string {
  const value = input.params[name];
  if (value === undefined) throw new ActionError('not_found', 'not found');
  return value;
}

function orNotFound<T>(value: T | null): T {
  if (value === null) throw new ActionError('not_found', 'not found');
  return value;
}
