import { placeholder as corePlaceholder } from "@orchestra/core";

export const PACKAGE_NAME = "@orchestra/web";

/**
 * Pure function pulled out of App.tsx so it can be unit tested without a
 * DOM environment. Scaffold placeholder. Replaced by the login screen,
 * board, spec builder, issue views, and attention panel (design.md §3,
 * build order steps 3, 5, 7).
 */
export function getAppLabel(): string {
  return `${PACKAGE_NAME}+${corePlaceholder()}`;
}
