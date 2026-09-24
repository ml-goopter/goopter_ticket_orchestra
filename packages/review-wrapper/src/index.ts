import { placeholder as corePlaceholder } from "@orchestra/core";

export const PACKAGE_NAME = "@orchestra/review-wrapper";

/**
 * Scaffold placeholder. Replaced by the `orchestra-review` binary put on
 * the agent's PATH (design.md §3, §14; D14).
 */
export function placeholder(): string {
  return `${PACKAGE_NAME}+${corePlaceholder()}`;
}
