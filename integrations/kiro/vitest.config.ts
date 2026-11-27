import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: '@lathe/kiro-integration', include: ['src/**/*.test.ts'] },
});
