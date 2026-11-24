import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// `webpackIgnore`: apps bundle the foundation with Next.js, which would otherwise try to
// bundle this directory as an asset. Migrations run from scripts, never from a bundle.
const DEFAULT_DIR = fileURLToPath(
  new URL(/* webpackIgnore: true */ '../../migrations/', import.meta.url),
);
const APP_ROLE_VAR = ':"app_role"';
// Arbitrary constant so two runners never apply migrations at the same time.
const LOCK_KEY = 7_401_101;

export interface MigrateOptions {
  /** Name of the non-owner app role, substituted for `:"app_role"` in migrations. */
  readonly appRole: string;
  readonly dir?: string;
}

/**
 * Applies forward-only SQL migrations in file-name order, each in its own
 * transaction, and records them in `schema_migrations`. Must run as the owner
 * role. Returns the names applied by this call.
 */
export async function runMigrations(client: pg.Client, options: MigrateOptions): Promise<string[]> {
  const dir = options.dir ?? DEFAULT_DIR;
  const appRole = client.escapeIdentifier(options.appRole);
  const applied: string[] = [];

  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await client.query(`REVOKE ALL ON TABLE schema_migrations FROM ${appRole}`);

    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const text = (await readFile(`${dir}/${file}`, 'utf8')).replaceAll(APP_ROLE_VAR, appRole);
      if (/:["']\w+["']/.test(stripComments(text))) {
        throw new Error(`${file} uses a psql variable other than ${APP_ROLE_VAR}`);
      }
      await client.query('BEGIN');
      try {
        await client.query(text);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed`, { cause: error });
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
  return applied;
}

function stripComments(sqlText: string): string {
  return sqlText.replace(/--.*$/gm, '');
}
