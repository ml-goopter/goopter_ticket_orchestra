import type { DashboardColumn } from "@orchestra/core";
import type { TaskCard } from "../api/types.js";

/**
 * Board render order (design.md §14: the "Needs Human" column is
 * always leftmost and highlighted). Deliberately not
 * `DASHBOARD_COLUMNS`'s own declaration order, which groups columns by
 * task-state proximity instead of display position.
 */
export const BOARD_COLUMN_ORDER: readonly DashboardColumn[] = [
  "Needs Human",
  "Needs Spec",
  "Spec In Progress",
  "Awaiting Spec Approval",
  "Ready",
  "Implementing",
  "CI",
  "Ready for Merge",
  "Done",
];

/** The leftmost column, which carries the highlighted styling. */
export const HIGHLIGHTED_COLUMNS: ReadonlySet<DashboardColumn> = new Set([
  "Needs Human",
]);

/** The colour family a non-highlighted column header's dot uses (UR2, approved mockup). */
export type ColumnAccent = "attention" | "progress" | "success" | "neutral";

const PROGRESS_COLUMNS: ReadonlySet<DashboardColumn> = new Set(["Spec In Progress", "Implementing", "CI"]);
const SUCCESS_COLUMNS: ReadonlySet<DashboardColumn> = new Set(["Ready for Merge", "Done"]);

/**
 * Column header dot colour (UR2 AC2): "Needs Human" is
 * `attention` (amber, matching its highlighted tint); the agent-active
 * columns are `progress` (blue); the two merge-ready columns are `success`
 * (green); everything else (still-in-triage columns) is `neutral` (grey).
 */
export function columnAccent(column: DashboardColumn): ColumnAccent {
  if (HIGHLIGHTED_COLUMNS.has(column)) return "attention";
  if (PROGRESS_COLUMNS.has(column)) return "progress";
  if (SUCCESS_COLUMNS.has(column)) return "success";
  return "neutral";
}

/**
 * Groups cards by their api-assigned `column`, preserving each card's
 * position within the api's response order (design.md §12.2 `listBoard`
 * orders by priority then age). Every column in `BOARD_COLUMN_ORDER` gets
 * an entry, empty or not, so a column with no cards still renders.
 */
export function groupByColumn(cards: readonly TaskCard[]): Map<DashboardColumn, TaskCard[]> {
  const grouped = new Map<DashboardColumn, TaskCard[]>();
  for (const column of BOARD_COLUMN_ORDER) {
    grouped.set(column, []);
  }
  for (const card of cards) {
    const list = grouped.get(card.column);
    if (list) {
      list.push(card);
    } else {
      grouped.set(card.column, [card]);
    }
  }
  return grouped;
}
