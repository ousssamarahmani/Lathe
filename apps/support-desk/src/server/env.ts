import { z } from 'zod';
import { APP_SLUG } from './app-slug';

const Identifier = z
  .string()
  .regex(/^[a-z_][a-z0-9_]{0,62}$/, 'expected a lowercase database name');

/**
 * Each app has its own database, so its tables never mix with the foundation's or
 * another app's (in tests and in deployment). Default: `<POSTGRES_DB>_<app slug>`,
 * the slug with `-` turned into `_`; `LATHE_APP_DB` overrides it.
 */
const Database = {
  POSTGRES_HOST: z.string().min(1).default('127.0.0.1'),
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  POSTGRES_DB: Identifier,
  LATHE_APP_DB: Identifier.optional(),
};

const withDatabase = <T extends { POSTGRES_DB: string; LATHE_APP_DB?: string | undefined }>(
  env: T,
): T & { readonly database: string } => ({
  ...env,
  database: env.LATHE_APP_DB ?? `${env.POSTGRES_DB}_${APP_SLUG.replaceAll('-', '_')}`,
});

/** Variables the running app needs. Values are secrets or config; they are never logged. */
const AppEnv = z
  .object({
    ...Database,
    /** The non-owner app role. It has no BYPASSRLS, so RLS applies to every query. */
    LATHE_DB_APP_ROLE: z.string().min(1),
    LATHE_DB_APP_PASSWORD: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    /** Public origin of this app. Cookie-bearing writes from any other origin are refused. */
    LATHE_APP_BASE_URL: z.url().default('http://localhost:3000'),
  })
  .transform(withDatabase);
export type AppEnv = z.infer<typeof AppEnv>;

/** Variables the migration script needs: the owner role, never used by the running app. */
const OwnerEnv = z
  .object({
    ...Database,
    LATHE_DB_OWNER_ROLE: z.string().min(1),
    LATHE_DB_OWNER_PASSWORD: z.string().min(1),
    LATHE_DB_APP_ROLE: z.string().min(1),
  })
  .transform(withDatabase);
export type OwnerEnv = z.infer<typeof OwnerEnv>;

/**
 * Variables of `pnpm db:create`, the only code that uses the Postgres superuser. Local
 * development and CI only; a deployment creates the database outside the app.
 */
const AdminEnv = z
  .object({
    ...Database,
    POSTGRES_SUPERUSER: z.string().min(1),
    POSTGRES_SUPERUSER_PASSWORD: z.string().min(1),
    LATHE_DB_OWNER_ROLE: z.string().min(1),
    LATHE_DB_APP_ROLE: z.string().min(1),
  })
  .transform(withDatabase);
export type AdminEnv = z.infer<typeof AdminEnv>;

/** Any map of variable names to values, for example `process.env`. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

function parse<T>(schema: z.ZodType<T, unknown>, source: EnvSource): T {
  const result = schema.safeParse(source);
  if (!result.success) {
    // Names only, never values.
    const names = [...new Set(result.error.issues.map((i) => i.path.join('.')))];
    throw new Error(`missing or invalid environment variables: ${names.join(', ')}`);
  }
  return result.data;
}

export const readAppEnv = (source: EnvSource = process.env): AppEnv => parse(AppEnv, source);
export const readOwnerEnv = (source: EnvSource = process.env): OwnerEnv => parse(OwnerEnv, source);
export const readAdminEnv = (source: EnvSource = process.env): AdminEnv => parse(AdminEnv, source);
