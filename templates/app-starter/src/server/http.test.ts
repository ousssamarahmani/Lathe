import type { Action, ActionRequest, ActionResult } from '@lathe/application-foundation';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from './deps';
import { isSameOrigin, routeWith } from './http';

const BASE = 'http://localhost:3000';
const deps = { baseUrl: BASE } as unknown as AppDeps; // The stub action never touches db or auth.

function stub<T>(result: ActionResult<T> | Error) {
  const seen: ActionRequest[] = [];
  const fn = vi.fn(async (_deps: unknown, request: ActionRequest) => {
    seen.push(request);
    if (result instanceof Error) throw result;
    return result;
  });
  const action = Object.assign(fn, { permission: 'notes.read', scope: 'org' as const });
  return { action: action as unknown as Action<T>, seen, fn };
}

const route = routeWith(() => deps);
const ctx = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });
const req = (method: string, path: string, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, { method, ...init });

describe('isSameOrigin', () => {
  it.each([
    [{}, true],
    [{ origin: BASE }, true],
    [{ 'sec-fetch-site': 'same-origin' }, true],
    [{ 'sec-fetch-site': 'none' }, true],
    [{ origin: 'https://evil.example' }, false],
    [{ origin: 'http://localhost:3001' }, false],
    [{ origin: 'null' }, false],
    [{ 'sec-fetch-site': 'cross-site' }, false],
    [{ 'sec-fetch-site': 'same-site' }, false],
    [{ origin: BASE, 'sec-fetch-site': 'cross-site' }, false],
  ])('%o -> %s', (headers, expected) => {
    expect(isSameOrigin(new Request(BASE, { headers }), BASE)).toBe(expected);
  });
});

describe('route', () => {
  it.each([
    ['unauthenticated', 401],
    ['forbidden', 403],
    ['not_found', 404],
    ['validation_failed', 400],
    ['conflict', 409],
  ] as const)('maps %s to %i with the standard error body', async (code, status) => {
    const { action } = stub({ ok: false, code, message: 'm' });
    const res = await route(action)(req('GET', '/v1/x'), ctx());
    expect(res.status).toBe(status);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'requestId']);
    expect(body['code']).toBe(code);
    expect(body['requestId']).toBe(res.headers.get('x-request-id'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 500 without the error message when the action throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { action } = stub(new Error('SELECT secret FROM users WHERE password = $1'));
    const res = await route(action)(req('GET', '/v1/x'), ctx());
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain('secret');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret');
    spy.mockRestore();
  });

  it('uses the given success status, and 204 has no body', async () => {
    const { action } = stub({ ok: true, value: { id: '1' } });
    const created = await route(action, { status: 201 })(req('GET', '/v1/x'), ctx());
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: '1' });
    const none = await route(action, { status: 204 })(req('GET', '/v1/x'), ctx());
    expect(none.status).toBe(204);
    expect(await none.text()).toBe('');
  });

  it('passes the cookies, a fresh server request id, and the query as input for GET', async () => {
    const { action, seen } = stub({ ok: true, value: null });
    await route(action)(
      req('GET', '/v1/x?limit=2&tag=a&tag=b', { headers: { cookie: 'c=1' } }),
      ctx(),
    );
    await route(action)(req('GET', '/v1/x'), ctx());
    expect(seen[0]?.input).toEqual({ limit: '2', tag: ['a', 'b'] });
    expect(seen[0]?.headers.get('cookie')).toBe('c=1');
    expect(seen[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]?.requestId).not.toBe(seen[1]?.requestId);
  });

  it('ignores a client x-request-id', async () => {
    const { action, seen } = stub({ ok: true, value: null });
    const fixed = '11111111-1111-4111-8111-111111111111';
    const res = await route(action)(
      req('GET', '/v1/x', { headers: { 'x-request-id': fixed } }),
      ctx(),
    );
    expect(seen[0]?.requestId).not.toBe(fixed);
    expect(res.headers.get('x-request-id')).not.toBe(fixed);
  });

  it('path parameters override body fields of the same name', async () => {
    const { action, seen } = stub({ ok: true, value: null });
    await route(action)(
      req('PATCH', '/v1/x/p', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'from-body', title: 't' }),
      }),
      ctx({ id: 'from-path' }),
    );
    expect(seen[0]?.input).toEqual({ id: 'from-path', title: 't' });
  });

  it.each([
    ['not json', 'application/json'],
    ['[1]', 'application/json'],
    ['"s"', 'application/json'],
    ['{"a":1}', 'text/plain'],
  ])('answers 400 bad_request for body %s (%s) without calling the action', async (body, type) => {
    const { action, fn } = stub({ ok: true, value: null });
    const res = await route(action)(
      req('POST', '/v1/x', { headers: { 'content-type': type }, body }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('bad_request');
    expect(fn).not.toHaveBeenCalled();
  });

  it('works on static routes, where Next.js passes no params (regression)', async () => {
    const { action, seen } = stub({ ok: true, value: null });
    const res1 = await route(action)(req('GET', '/v1/me'), { params: Promise.resolve(undefined) });
    // Not something Next.js does, but the handler must not crash on it either.
    const res2 = await route(action)(req('GET', '/v1/me'), {} as never);
    expect([res1.status, res2.status]).toEqual([200, 200]);
    expect(seen.map((s) => s.input)).toEqual([{}, {}]);
  });

  it('treats an empty body as {}', async () => {
    const { action, seen } = stub({ ok: true, value: null });
    await route(action)(req('POST', '/v1/x', { headers: { origin: BASE } }), ctx());
    expect(seen[0]?.input).toEqual({});
  });

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'refuses a cross-origin %s with 403 before calling the action',
    async (method) => {
      const { action, fn } = stub({ ok: true, value: null });
      const res = await route(action)(
        req(method, '/v1/x', { headers: { origin: 'https://evil.example' } }),
        ctx(),
      );
      expect(res.status).toBe(403);
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it('lets a cross-origin GET through to the action, which still checks the session', async () => {
    const { action, fn } = stub({ ok: true, value: null });
    await route(action)(
      req('GET', '/v1/x', { headers: { origin: 'https://evil.example' } }),
      ctx(),
    );
    expect(fn).toHaveBeenCalledOnce();
  });
});
