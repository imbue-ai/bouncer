import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Scope to the unit tests. Without this, vitest's default glob also matches
    // the Playwright e2e specs (e2e/**/*.spec.ts), which import @playwright/test
    // and fail with "test.describe() … not expected here". Playwright runs those
    // separately via `npm run test:e2e`.
    include: ['tests/**/*.{test,spec}.ts'],
  },
});
