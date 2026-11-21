import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/application-foundation',
      'packages/verification-harness',
      'packages/shared-contracts',
      // Tests of repository tooling (import boundaries, P0-10). Fixture files are not tests.
      { test: { name: 'scripts', include: ['scripts/**/*.test.mjs'] } },
    ],
  },
});
