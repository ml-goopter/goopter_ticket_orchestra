/**
 * Timeline filter families (design.md §14 Task detail, task contract C):
 * fixed sets of `execution_events.type` values grouped by prefix. Every
 * `EXECUTION_EVENT_TYPES` value (packages/core/src/events.ts) belongs to
 * exactly one family below.
 */
export const EVENT_FAMILIES = ["state", "agent", "issues", "review", "pr_ci"] as const;
export type EventFamily = (typeof EVENT_FAMILIES)[number];

export const FAMILY_LABELS: Record<EventFamily, string> = {
  state: "State",
  agent: "Agent",
  issues: "Issues",
  review: "Review",
  pr_ci: "PR & CI",
};

const PREFIX_FAMILIES: ReadonlyArray<readonly [string, EventFamily]> = [
  ["execution.", "state"],
  ["worktree.", "state"],
  ["agent.", "agent"],
  ["issue.", "issues"],
  ["review.", "review"],
  ["spec.", "review"],
  ["pull_request.", "pr_ci"],
  ["ci.", "pr_ci"],
];

/** `task.state_changed` and `usage.recorded` have no prefix family. */
const EXACT_FAMILIES: Readonly<Record<string, EventFamily>> = {
  "task.state_changed": "state",
  "usage.recorded": "state",
};

/** The family an `execution_events.type` belongs to, or `null` if none match. */
export function familyOf(type: string): EventFamily | null {
  const exact = EXACT_FAMILIES[type];
  if (exact !== undefined) {
    return exact;
  }
  for (const [prefix, family] of PREFIX_FAMILIES) {
    if (type.startsWith(prefix)) {
      return family;
    }
  }
  return null;
}

/**
 * `execution_events.type` (dotted/underscored lower case, e.g.
 * `"task.state_changed"`) to a readable label ("Task state changed"), for
 * the timeline row's type label and the generic fallback row (design.md
 * §14 Task detail). Unlike `ui/humanizeEnum`, which expects
 * `SCREAMING_SNAKE_CASE`, this splits on both `.` and `_`.
 */
export function typeLabel(type: string): string {
  const words = type.split(/[._]/).filter((word) => word.length > 0);
  return words
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

const EXACT_SHORT_LABELS: Readonly<Record<string, string>> = {
  "task.state_changed": "State",
  "usage.recorded": "Usage",
  "agent.tool_call": "Tool",
};

const PREFIX_SHORT_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["execution.", "Execution"],
  ["worktree.", "Worktree"],
  ["agent.", "Message"],
  ["spec.", "Spec"],
  ["issue.", "Issue"],
  ["review.", "Review"],
  ["pull_request.", "PR"],
  ["ci.", "CI"],
];

/**
 * A one-word label for the timeline row's fixed-width label column (T7
 * fix: `typeLabel` produces the full event name, e.g. "Task state
 * changed" or "Execution assigned", which truncates illegibly at column
 * width). Callers should keep `typeLabel(type)` in a `title` attribute so
 * the full event type is still available on hover.
 */
export function shortTypeLabel(type: string): string {
  const exact = EXACT_SHORT_LABELS[type];
  if (exact !== undefined) {
    return exact;
  }
  for (const [prefix, label] of PREFIX_SHORT_LABELS) {
    if (type.startsWith(prefix)) {
      return label;
    }
  }
  return typeLabel(type);
}
