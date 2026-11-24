import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Local runs read the git-ignored repository .env. CI provides the same variables directly.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  test: {
    name: '@lathe/support-desk:integration',
    include: ['src/**/*.integration.test.ts'],
    // Applies the foundation and app migrations as the owner role before any test.
    globalSetup: ['src/server/integration-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      // A throwaway signing secret per run when none is configured. Never a fixed value.
      BETTER_AUTH_SECRET:
        process.env['BETTER_AUTH_SECRET'] ?? randomBytes(32).toString('base64url'),
    },
  },
});
