import { getDeps } from '../../../server/deps';

/**
 * Better Auth (sign-in, sign-out, session) under `AUTH_BASE_PATH` (C4). Sign-up is
 * closed in this app. This is the only route not built with `defineAction`: it
 * authenticates, it does not act on tenant data.
 */
const handle = (request: Request): Promise<Response> => getDeps().auth.handler(request);

export const GET = handle;
export const POST = handle;
