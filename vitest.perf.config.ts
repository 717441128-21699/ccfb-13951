import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/perf.test.ts'],
    environment: 'node',
    testTimeout: 120000,
  },
});
