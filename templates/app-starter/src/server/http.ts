import { randomUUID } from 'node:crypto';
import type { Action, ActionErrorCode } from '@lathe/application-foundation';
import { RequestId, type ApiError, type ErrorCode } from '@lathe/shared-contracts';
import { getDeps, type AppDeps } from './deps';

/**
 * Turns a `defineAction` action into a Next.js route handler. This is the only
 * place that maps action results to HTTP. Route files contain nothing else:
 *
 *   export const GET = route(listNotes);
 *
 * Input is the JSON body (POST, PUT, PATCH) or the query string (GET, DELETE),
 * with path parameters written over it, so a body cannot replace the `:id` of
 * the URL. Unknown fields are rejected by the actions' strict schemas.
 */

const STATUS: Record<ActionErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

type Params = Record<string, string | string[] | undefined>;
export interface RouteContext {
  /** On static routes Next.js resolves this to undefined, not to an empty object. */
  readonly params: Promise<Params | undefined>;
}
export type RouteHandler = (request: Request, context: RouteContext) => Promise<Response>;

class BadRequest extends Error {}

function headersFor(requestId: string): Headers {
  return new Headers({ 'cache-control': 'no-store', 'x-request-id': requestId });
}

function errorResponse(status: number, code: ErrorCode, message: string, requestId: string) {
  const body: ApiError = { code, message, requestId: RequestId.parse(requestId) };
  return Response.json(body, { status, headers: headersFor(requestId) });
}

/**
 * CSRF defense for cookie-authenticated writes, on top of `SameSite=Lax`: a
 * browser always sends `Origin` (and `Sec-Fetch-Site`) on a cross-site write,
 * so any value other than this app's origin is refused. Non-browser clients
 * send neither and carry no ambient cookies.
 */
export function isSameOrigin(request: Request, baseUrl: string): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.get('origin');
  return origin === null || origin === baseUrl;
}

async function readInput(request: Request): Promise<Record<string, unknown>> {
  const method = request.method.toUpperCase();
  if (!BODY_METHODS.has(method)) {
    const input: Record<string, unknown> = {};
    const query = new URL(request.url).searchParams;
    for (const key of new Set(query.keys())) {
      const values = query.getAll(key);
      // A repeated key becomes an array, which the strict schemas reject.
      input[key] = values.length === 1 ? values[0] : values;
    }
    return input;
  }
  const text = await request.text();
  if (text.trim() === '') return {};
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) throw new BadRequest('content-type');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequest('json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequest('shape');
  }
  return { ...(parsed as Record<string, unknown>) };
}

export interface RouteOptions {
  readonly status?: 200 | 201 | 204;
}

/** `route` with its dependencies passed in. Tests use it with a stub; the app uses `route`. */
export function routeWith(resolveDeps: () => AppDeps) {
  return <T>(action: Action<T>, options: RouteOptions = {}): RouteHandler =>
    handlerFor(resolveDeps, action, options);
}

function handlerFor<T>(
  resolveDeps: () => AppDeps,
  action: Action<T>,
  options: RouteOptions,
): RouteHandler {
  return async (request, context) => {
    const requestId = randomUUID();
    const deps = resolveDeps();
    if (!SAFE_METHODS.has(request.method.toUpperCase()) && !isSameOrigin(request, deps.baseUrl)) {
      return errorResponse(403, 'forbidden', 'cross-origin request refused', requestId);
    }
    let input: Record<string, unknown>;
    try {
      input = await readInput(request);
    } catch (error) {
      if (!(error instanceof BadRequest)) throw error;
      return errorResponse(400, 'bad_request', 'request body must be a JSON object', requestId);
    }
    // Defensive: tests and callers outside Next.js may omit the context entirely.
    const params: Params = (await (context as RouteContext | undefined)?.params) ?? {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) input[key] = value;
    }

    let result;
    try {
      result = await action(deps, { headers: request.headers, input, requestId });
    } catch (error) {
      // Programmer or infrastructure error. Log the request id and error class only:
      // driver messages can contain query parameters.
      console.error(
        `[app] request ${requestId} failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      return errorResponse(500, 'internal', 'internal error', requestId);
    }
    if (!result.ok) {
      return errorResponse(STATUS[result.code], result.code, result.message, requestId);
    }
    if (options.status === 204) {
      return new Response(null, { status: 204, headers: headersFor(requestId) });
    }
    return Response.json(result.value, {
      status: options.status ?? 200,
      headers: headersFor(requestId),
    });
  };
}

export const route = routeWith(getDeps);
