import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Single fork. These tests share one Postgres database and one connection
    // pool; running files in parallel would have them competing for connections
    // for no gain on a suite this small.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
