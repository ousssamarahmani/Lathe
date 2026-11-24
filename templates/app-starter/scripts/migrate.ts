/**
 * Applies the foundation migrations, then this app's own, as the owner role.
 * Run with `pnpm --filter <app> migrate`. The running app never gets the owner role.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@lathe/application-foundation';
import pg from 'pg';
import { readOwnerEnv, type EnvSource } from '../src/server/env';

export const APP_MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(source: EnvSource = process.env): Promise<string[]> {
  const env = readOwnerEnv(source);
  const client = new pg.Client({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    database: env.database,
    user: env.LATHE_DB_OWNER_ROLE,
    password: env.LATHE_DB_OWNER_PASSWORD,
  });
  await client.connect();
  try {
    const foundation = await runMigrations(client, { appRole: env.LATHE_DB_APP_ROLE });
    const app = await runMigrations(client, {
      appRole: env.LATHE_DB_APP_ROLE,
      dir: APP_MIGRATIONS,
    });
    return [...foundation, ...app];
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Local runs read the git-ignored repository .env; elsewhere the variables are set directly.
  const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  migrate()
    .then((applied) =>
      console.log(
        `migrations applied: ${applied.length > 0 ? applied.join(', ') : 'none pending'}`,
      ),
    )
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'migration failed');
      process.exitCode = 1;
    });
}
