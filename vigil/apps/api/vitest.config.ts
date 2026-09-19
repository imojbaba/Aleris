import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    /**
     * One file at a time.
     *
     * Two suites share a single Postgres and each truncates between tests, so
     * running files in parallel had them wiping each other's fixtures — which
     * surfaced as the release engine "forgetting" attempts it had definitely
     * made. Nothing here is slow enough for the parallelism to be worth the
     * ambiguity.
     */
    fileParallelism: false,
  },
});
