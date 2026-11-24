import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { APP_SLUG } from './src/server/app-slug';

/**
 * Browser smoke test of the app (task P1-07): sign in, switch org, create and read a
 * note, check isolation between orgs. `pnpm test:e2e` builds the app first.
 *
 * Every run uses a throwaway database (`<POSTGRES_DB>_<app>_e2e`, dropped afterwards)
 * and a fresh random auth secret and test password. They are set once here, in the
 * main process, and inherited by the web server and the workers. Nothing is written
 * to disk.
 */
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
process.env['LATHE_APP_DB'] ??=
  `${process.env['POSTGRES_DB'] ?? 'lathe'}_${APP_SLUG.replaceAll('-', '_')}_e2e`;
process.env['BETTER_AUTH_SECRET'] ??= randomBytes(32).toString('base64url');
process.env['LATHE_TEST_PASSWORD'] ??= randomBytes(18).toString('base64url');

const PORT = 3199;
process.env['LATHE_APP_BASE_URL'] = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Outside the repository, so run artifacts are never committed.
  outputDir: join(tmpdir(), `lathe-e2e-${APP_SLUG}`),
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/sign-in`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
