import { defineConfig } from "vitest/config";

// Auth tests start a throwaway postgres:17 container per
// @testcontainers/postgresql. `fileParallelism: false` avoids racing
// multiple Postgres containers in CI; `testTimeout` covers a cold image
// pull on first run (matches packages/db/vitest.config.ts).
export default defineConfig({
  test: {
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
