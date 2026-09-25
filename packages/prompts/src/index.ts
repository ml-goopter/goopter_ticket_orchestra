import { placeholder as corePlaceholder } from "@orchestra/core";

export const PACKAGE_NAME = "@orchestra/prompts";

/**
 * Scaffold placeholder, still imported by `@orchestra/adapters` and
 * `@orchestra/worker` to prove workspace wiring (design.md §3). Superseded
 * for prompt content by the exports below (GOT.15).
 */
export function placeholder(): string {
  return `${PACKAGE_NAME}+${corePlaceholder()}`;
}

export * from "./types.js";
export * from "./system/index.js";
export * from "./user.js";
export * from "./resume.js";
export * from "./spec-markdown.js";
export * from "./spec-diff.js";
export * from "./review.js";
