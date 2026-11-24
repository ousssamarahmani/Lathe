/**
 * Creates this app's own database (`<POSTGRES_DB>_<app>` unless LATHE_APP_DB is set),
 * with the same owner/app role setup as infra/postgres/init/roles.sql.in. Idempotent.
 *
 * The only code that uses the Postgres superuser: local development and CI only. The
 * running app and the migration script never get these credentials.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readAdminEnv, type EnvSource } from '../src/server/env';

export async function createDatabase(
  source: EnvSource = process.env,
): Promise<'created' | 'exists'> {
  const env = readAdminEnv(source);
  const connect = async (database: string) => {
    const client = new pg.Client({
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      database,
      user: env.POSTGRES_SUPERUSER,
      password: env.POSTGRES_SUPERUSER_PASSWORD,
    });
    await client.connect();
    return client;
  };

  const admin = await connect(env.POSTGRES_DB);
  let created = false;
  try {
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [env.database]);
    if (found.rowCount === 0) {
      // Identifiers cannot be parameters; the name is validated by readAdminEnv and escaped here.
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(env.database)}`);
      created = true;
    }
  } finally {
    await admin.end();
  }
  if (!created) return 'exists';

  const db = await connect(env.database);
  try {
    const name = db.escapeIdentifier(env.database);
    const owner = db.escapeIdentifier(env.LATHE_DB_OWNER_ROLE);
    const app = db.escapeIdentifier(env.LATHE_DB_APP_ROLE);
    await db.query(`
      REVOKE ALL ON DATABASE ${name} FROM PUBLIC;
      GRANT CONNECT ON DATABASE ${name} TO ${owner}, ${app};
      ALTER SCHEMA public OWNER TO ${owner};
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO ${app};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO ${app};
    `);
  } finally {
    await db.end();
  }
  return 'created';
}

/**
 * Drops a throwaway database created for one test run. Refuses any name that does not
 * end in `_e2e`, so it can never drop the app's real or test database.
 */
export async function dropTestDatabase(source: EnvSource = process.env): Promise<void> {
  const env = readAdminEnv(source);
  if (!env.database.endsWith('_e2e')) {
    throw new Error('dropTestDatabase only drops databases whose name ends in _e2e');
  }
  const admin = new pg.Client({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    database: env.POSTGRES_DB,
    user: env.POSTGRES_SUPERUSER,
    password: env.POSTGRES_SUPERUSER_PASSWORD,
  });
  await admin.connect();
  try {
    await admin.query(
      `DROP DATABASE IF EXISTS ${admin.escapeIdentifier(env.database)} WITH (FORCE)`,
    );
  } finally {
    await admin.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Local runs read the git-ignored repository .env; CI sets the variables directly.
  const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  createDatabase()
    .then((r) => console.log(r === 'created' ? 'database created' : 'database already exists'))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'database creation failed');
      process.exitCode = 1;
    });
}
