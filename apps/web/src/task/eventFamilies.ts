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
