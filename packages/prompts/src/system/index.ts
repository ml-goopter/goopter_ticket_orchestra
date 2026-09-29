import { SPEC_SYSTEM_PROMPT } from "./spec.js";
import {
  IMPLEMENTATION_SYSTEM_PROMPT,
  IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES,
  IMPLEMENTATION_SYSTEM_PROMPT_CLAUDE,
  IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES_CLAUDE,
} from "./implementation.js";
import { REVIEW_SYSTEM_PROMPT } from "./review.js";

export { SPEC_SYSTEM_PROMPT } from "./spec.js";
export {
  DELEGATION_PROTOCOL,
  IMPLEMENTATION_SYSTEM_PROMPT,
  IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES,
  IMPLEMENTATION_SYSTEM_PROMPT_CLAUDE,
  IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES_CLAUDE,
} from "./implementation.js";
export { REVIEW_SYSTEM_PROMPT } from "./review.js";

export interface SystemPromptOptions {
  /**
   * Repository has `no-mistakes` initialized. Only meaningful for
   * `"implementation"` (design.md §9.2, §14 D14); ignored otherwise.
   */
  noMistakes?: boolean;
  /**
   * The execution's runtime. `"claude"` adds the delegation section to the
   * implementation prompt; any other value, or none, leaves it out. Ignored
   * for other roles.
   */
  runtime?: "claude" | "codex";
}

/** Selects the static system prompt for an execution role (design.md §9.2). */
export function systemPromptFor(
  role: "spec" | "implementation" | "review",
  opts: SystemPromptOptions = {},
): string {
  switch (role) {
    case "spec":
      return SPEC_SYSTEM_PROMPT;
    case "implementation":
      if (opts.runtime === "claude") {
        return opts.noMistakes
          ? IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES_CLAUDE
          : IMPLEMENTATION_SYSTEM_PROMPT_CLAUDE;
      }
      return opts.noMistakes
        ? IMPLEMENTATION_SYSTEM_PROMPT_NO_MISTAKES
        : IMPLEMENTATION_SYSTEM_PROMPT;
    case "review":
      return REVIEW_SYSTEM_PROMPT;
  }
}
