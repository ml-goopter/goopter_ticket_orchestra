import { defineConfig } from "vitest/config";

// `test/worker-db.test.ts` and `test/shutdown.test.ts` each start a throwaway
// postgres:17 container per @testcontainers/postgresql, matching
// `packages/db/vitest.config.ts`. `fileParallelism: false` stops them racing
// and `testTimeout` covers a cold image pull on first run.
export default defineConfig({
  test: {
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
