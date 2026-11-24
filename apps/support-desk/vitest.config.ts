import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@lathe/support-desk',
    include: ['src/**/*.test.{ts,tsx}'],
    // Integration tests need a real PostgreSQL and run via `pnpm test:integration`.
    exclude: ['src/**/*.integration.test.ts'],
    environment: 'node',
  },
});
