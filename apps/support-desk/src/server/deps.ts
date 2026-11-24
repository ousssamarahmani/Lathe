import { createAuth, type ActionDeps } from '@lathe/application-foundation';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { readAppEnv } from './env';

export interface AppDeps extends ActionDeps {
  readonly baseUrl: string;
  readonly pool: pg.Pool;
}

// Kept on globalThis so dev-mode reloads reuse one pool instead of leaking connections.
const holder = globalThis as typeof globalThis & { __latheAppDeps?: AppDeps };

/** Database, auth and config for this process, created on first use from the environment. */
export function getDeps(): AppDeps {
  if (holder.__latheAppDeps) return holder.__latheAppDeps;
  const env = readAppEnv();
  const pool = new pg.Pool({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    database: env.database,
    user: env.LATHE_DB_APP_ROLE,
    password: env.LATHE_DB_APP_PASSWORD,
    max: 10,
  });
  // An idle connection that the server closes (restart, failover) must not crash the
  // process. Log the error class only: driver messages can contain query details.
  pool.on('error', (error) => {
    console.error(`[app] database connection lost: ${error.name}`);
  });
  const db = drizzle({ client: pool });
  const baseUrl = new URL(env.LATHE_APP_BASE_URL).origin;
  const auth = createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: baseUrl,
    trustedOrigins: [baseUrl],
    // Sign-up stays closed: users come from the seed script or an invitation.
  });
  holder.__latheAppDeps = { db, auth, baseUrl, pool };
  return holder.__latheAppDeps;
}

/** Closes the pool. For scripts and tests. */
export async function closeDeps(): Promise<void> {
  const deps = holder.__latheAppDeps;
  delete holder.__latheAppDeps;
  await deps?.pool.end();
}
