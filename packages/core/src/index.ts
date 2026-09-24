export const PACKAGE_NAME = "@orchestra/core";

/**
 * Scaffold placeholder, kept for dependent packages (`db`, `adapters`,
 * `prompts`, `review-wrapper`) that import it to prove workspace wiring.
 * Superseded for domain logic by the exports below; the state machine
 * transition table itself is GOT.12.
 */
export function placeholder(): string {
  return PACKAGE_NAME;
}

export * from "./enums.js";
export * from "./spec-content.js";
export * from "./events.js";
export * from "./agent-tools.js";
