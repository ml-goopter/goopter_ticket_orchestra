import { defineConfig } from "vitest/config";

// The schema test (test/schema.test.ts) starts a throwaway postgres:17
// container per @testcontainers/postgresql. `fileParallelism: false` avoids
// racing multiple Postgres containers in CI; `testTimeout` covers a cold
// image pull on first run.
export default defineConfig({
  test: {
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
