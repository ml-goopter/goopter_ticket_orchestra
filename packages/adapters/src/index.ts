import { placeholder as corePlaceholder } from "@orchestra/core";
import { placeholder as promptsPlaceholder } from "@orchestra/prompts";

export const PACKAGE_NAME = "@orchestra/adapters";

/**
 * Scaffold placeholder, kept because `apps/worker` still imports it to prove
 * workspace wiring. The real surface is exported below: the `AgentAdapter`
 * contract (design.md §7) and the Claude runtime implementation (§7.1). The
 * Codex adapter (§7.2) lands with build-order step 9. Depends on nothing from
 * @orchestra/db (design.md §3): it yields events, the worker persists them.
 */
export function placeholder(): string {
  return `${PACKAGE_NAME}+${corePlaceholder()}+${promptsPlaceholder()}`;
}

export * from "./types.js";
export * from "./policies.js";
export * from "./retriable.js";
export * from "./claude.js";
