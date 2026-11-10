import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'legacy/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
  },
});
