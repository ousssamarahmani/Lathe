import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/application-foundation',
      'packages/verification-harness',
      'packages/shared-contracts',
      'services/factory-engine',
      // Every app has its own vitest.config.ts, including apps from `pnpm new-app`.
      'apps/*',
      'templates/*',
      // Tests of repository tooling (import boundaries, P0-10). Fixture files are not tests.
      { test: { name: 'scripts', include: ['scripts/**/*.test.mjs'] } },
    ],
  },
});
