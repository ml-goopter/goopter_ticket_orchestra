import { placeholder as corePlaceholder } from "@orchestra/core";

export const PACKAGE_NAME = "@orchestra/db";

/**
 * Scaffold placeholder. Replaced by the drizzle schema, migrations, and
 * typed queries (design.md §3, §4; build order step 2). Depends on
 * @orchestra/core to prove the workspace dependency wiring works.
 */
export function placeholder(): string {
  return `${PACKAGE_NAME}+${corePlaceholder()}`;
}
