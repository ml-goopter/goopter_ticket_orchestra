import { defineConfig } from "vitest/config";

// Vitest 5 dropped the standalone `defineWorkspace` helper in favor of
// `test.projects` on a config object. This file is kept as
// `vitest.workspace.ts` for discoverability; run it explicitly with
// `vitest --config vitest.workspace.ts` to execute every package's tests
// from the repo root. `pnpm -r test` (used in CI) does not need it, since
// each package runs its own `vitest run` scoped to itself.
export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
