import { placeholder as corePlaceholder } from "@orchestra/core";
import { placeholder as dbPlaceholder } from "@orchestra/db";
import { placeholder as adaptersPlaceholder } from "@orchestra/adapters";
import { placeholder as promptsPlaceholder } from "@orchestra/prompts";

export const PACKAGE_NAME = "@orchestra/worker";

/**
 * Scaffold placeholder. Replaced by the scheduler, pollers, agent runner,
 * agent-tools server, and sweeper (design.md §3, §6-§11; build order steps
 * 4-9). `api` and `worker` are the only entry points (design.md §3).
 */
export function placeholder(): string {
  return [
    PACKAGE_NAME,
    corePlaceholder(),
    dbPlaceholder(),
    adaptersPlaceholder(),
    promptsPlaceholder(),
  ].join("+");
}
