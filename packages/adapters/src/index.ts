import { placeholder as corePlaceholder } from "@orchestra/core";
import { placeholder as promptsPlaceholder } from "@orchestra/prompts";

export const PACKAGE_NAME = "@orchestra/adapters";

/**
 * Scaffold placeholder. Replaced by the AgentAdapter interface plus the
 * Claude and Codex implementations (design.md §3, §7; build order steps
 * 5 and 9). Depends on nothing from @orchestra/db (design.md §3): it
 * yields events, the worker persists them.
 */
export function placeholder(): string {
  return `${PACKAGE_NAME}+${corePlaceholder()}+${promptsPlaceholder()}`;
}
