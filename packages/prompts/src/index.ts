import { placeholder as corePlaceholder } from "@orchestra/core";

export const PACKAGE_NAME = "@orchestra/prompts";

/**
 * Scaffold placeholder. Replaced by system prompts and prompt assembly
 * per role (design.md §3, build order step 5).
 */
export function placeholder(): string {
  return `${PACKAGE_NAME}+${corePlaceholder()}`;
}
