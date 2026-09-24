import { placeholder as corePlaceholder } from "@orchestra/core";
import { placeholder as dbPlaceholder } from "@orchestra/db";

export const PACKAGE_NAME = "@orchestra/api";

/**
 * Scaffold placeholder. Replaced by the Fastify server: auth, projects,
 * repositories, tasks read routes (design.md §3, §12; build order step 3).
 * `api` and `worker` are the only entry points (design.md §3).
 */
export function placeholder(): string {
  return `${PACKAGE_NAME}+${corePlaceholder()}+${dbPlaceholder()}`;
}
