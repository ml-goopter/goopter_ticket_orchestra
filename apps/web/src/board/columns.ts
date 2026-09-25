import type { DashboardColumn } from "@orchestra/core";
import type { TaskCard } from "../api/types.js";

/**
 * Board render order (design.md §14: "'Waiting for You' and 'Needs Human'
 * columns are always leftmost and highlighted"). Deliberately not
 * `DASHBOARD_COLUMNS`'s own declaration order, which groups columns by
 * task-state proximity instead of display position.
 */
export const BOARD_COLUMN_ORDER: readonly DashboardColumn[] = [
  "Waiting for You",
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

/** The two leftmost columns that carry the highlighted styling. */
export const HIGHLIGHTED_COLUMNS: ReadonlySet<DashboardColumn> = new Set([
  "Waiting for You",
  "Needs Human",
]);

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
