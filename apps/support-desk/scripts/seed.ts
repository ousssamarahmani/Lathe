/**
 * Creates the two demo orgs and one principal per role in each (C1 fixtures,
 * strategy `seed-script`). Runs as the app role, like the app. Users are created
 * through Better Auth with sign-up opened for this process only; the running app
 * keeps sign-up closed. Skips if the seed already exists.
 *
 * Needs LATHE_TEST_PASSWORD (at least 12 characters). It is never printed.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAuth, seedDemo, users } from '@lathe/application-foundation';
import { drizzle } from 'drizzle-orm/node-postgres';
import { inArray } from 'drizzle-orm';
import pg from 'pg';
import { z } from 'zod';
import { readAppEnv, type EnvSource } from '../src/server/env';
import { demoSeed, SEED_PRINCIPALS } from '../src/server/seed-data';

export async function seed(source: EnvSource = process.env): Promise<'created' | 'exists'> {
  const env = readAppEnv(source);
  const password = z.string().min(12).max(128).safeParse(source['LATHE_TEST_PASSWORD']);
  if (!password.success) throw new Error('LATHE_TEST_PASSWORD must be set (12 to 128 characters)');

  const pool = new pg.Pool({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    database: env.database,
    user: env.LATHE_DB_APP_ROLE,
    password: env.LATHE_DB_APP_PASSWORD,
    max: 2,
  });
  try {
    const db = drizzle({ client: pool });
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(
        inArray(
          users.email,
          SEED_PRINCIPALS.map((p) => p.email),
        ),
      );
    if (existing.length === SEED_PRINCIPALS.length) return 'exists';
    if (existing.length > 0) {
      throw new Error('the seed exists only in part; reset the database before seeding again');
    }
    const baseUrl = new URL(env.LATHE_APP_BASE_URL).origin;
    const auth = createAuth({
      db,
      secret: env.BETTER_AUTH_SECRET,
      baseURL: baseUrl,
      trustedOrigins: [baseUrl],
      allowSignUp: true,
    });
    await seedDemo(auth, db, demoSeed(password.data));
    return 'created';
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Local runs read the git-ignored repository .env; elsewhere the variables are set directly.
  const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  seed()
    .then((r) =>
      console.log(
        r === 'created'
          ? `seeded 2 orgs and ${SEED_PRINCIPALS.length} principals`
          : 'seed already present',
      ),
    )
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'seed failed');
      process.exitCode = 1;
    });
}
