# App Starter

A multi-tenant Next.js app on `@lathe/application-foundation`: sign-in, an org switcher, a
members page with invitation links, and one example tenant resource, notes. Generated apps
start as a copy of this one (`pnpm new-app <name>` from the repository root).

## Run locally

Needs the repository `.env` (names in `.env.example`) and PostgreSQL from `infra/`. The app has its own
database, `<POSTGRES_DB>_<app>` (`LATHE_APP_DB` overrides it), separate from the foundation's.

```sh
pnpm --filter @lathe/app-starter db:create # its own database (uses the Postgres superuser; local and CI only)
pnpm --filter @lathe/app-starter migrate   # foundation + app migrations, as the owner role
pnpm --filter @lathe/app-starter seed      # orgs a and b, one user per role, password LATHE_TEST_PASSWORD
pnpm --filter @lathe/app-starter dev       # http://localhost:3000
```

Seed users are `<role>@app-starter-org-<a|b>.test` for the roles `owner`, `member`, `viewer`.

## Layout

| Path                                           | What                                           |
| ---------------------------------------------- | ---------------------------------------------- |
| `src/server/authz.ts`                          | Roles and permissions                          |
| `src/server/schema.ts`, `migrations/`          | Tenant tables and their RLS                    |
| `src/server/notes.ts`, `src/server/members.ts` | Actions (`defineAction`)                       |
| `src/server/http.ts`                           | The only mapping from action results to HTTP   |
| `src/app/v1/**/route.ts`                       | Routes, one `route(action)` per method         |
| `src/app/(app)/**`                             | Pages; they read data through the same actions |
| `src/server/seed-data.ts`, `scripts/seed.ts`   | Demo orgs and principals                       |

To add a resource: a permission in `authz.ts`, a `tenantTable` in `schema.ts`, a migration with
RLS, actions, route files, pages. The extension points are listed in the foundation README.

## Tests

- `pnpm test` (from the repository root) runs the unit tests.
- `pnpm --filter @lathe/app-starter test:integration` creates the app database if needed and runs the
  HTTP-level tests against PostgreSQL as the app role: tenant isolation, roles, CSRF, invitations,
  org switching.
- `pnpm --filter @lathe/app-starter test:e2e` builds the app and runs the Playwright smoke test in
  Chromium against a throwaway database (dropped afterwards) with a random password and secret.
  Install the browser once with `pnpm --filter @lathe/app-starter exec playwright install chromium`.

`src/tenant-contract.ts` is the app's C1 tenant contract: the verification harness learns about
the app only through it. Its unit test checks it against the role map, the seed and the route files.

The bundler is webpack (`--webpack`): the workspace packages are TypeScript source with
`./x.js` imports, which Turbopack does not resolve.
