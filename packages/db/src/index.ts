import { placeholder as corePlaceholder } from "@orchestra/core";

export * from "./schema/index.js";
export * from "./client.js";
export { runMigrations } from "./migrate.js";
export * from "./transition.js";
export * from "./events.js";
export * from "./listen.js";
export * from "./queries/index.js";

export const PACKAGE_NAME = "@orchestra/db";

/**
 * Kept only so `apps/api` and `apps/worker`'s own scaffold placeholders
 * (which compose every dependency's `placeholder()` to prove workspace
 * wiring) keep building. Owned by `apps/**`, out of scope here (GOT.13);
 * remove this once those packages replace their placeholders with real
 * code.
 */
export function placeholder(): string {
  return `${PACKAGE_NAME}+${corePlaceholder()}`;
}
