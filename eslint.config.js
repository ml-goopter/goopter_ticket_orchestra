// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      "**/.treehouse/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
  {
    // design.md §3: "Nothing else imports drizzle directly." `packages/db`
    // owns every drizzle query; everyone else goes through its typed
    // helpers in `packages/db/src/queries`. Covers test files too (not
    // just `src/**`): a test that queries the schema through drizzle
    // directly is exactly the coupling this boundary exists to prevent.
    files: [
      "apps/**/*.{ts,tsx}",
      "packages/core/**/*.{ts,tsx}",
      "packages/adapters/**/*.{ts,tsx}",
      "packages/prompts/**/*.{ts,tsx}",
      "packages/review-wrapper/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["drizzle-orm", "drizzle-orm/*"],
              message:
                "design.md §3: nothing outside packages/db imports drizzle directly. Add or use a typed helper in packages/db/src/queries instead.",
            },
          ],
        },
      ],
    },
  },
);
