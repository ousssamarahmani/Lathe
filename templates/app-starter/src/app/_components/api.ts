/**
 * Browser-side calls to this app's own `/v1` routes. Same origin only, so the
 * session cookie and the `Origin` header go with every request.
 */
export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

export async function callApi<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    return { ok: false, status: 0, code: 'network', message: 'The server could not be reached.' };
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    // Not JSON (for example a proxy error page): fall back to the status below.
    json = undefined;
  }
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  const err = (json ?? {}) as { code?: unknown; message?: unknown };
  return {
    ok: false,
    status: res.status,
    code: typeof err.code === 'string' ? err.code : 'error',
    message: typeof err.message === 'string' ? err.message : `Request failed (${res.status}).`,
  };
}
