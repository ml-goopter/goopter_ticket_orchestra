import { Link } from "react-router";
import type { TaskCard as TaskCardData } from "../api/types.js";
import { formatAge, formatCostUsd } from "./format.js";

export interface TaskCardProps {
  card: TaskCardData;
  /** Current time, injected so age is deterministic in tests. */
  now: Date;
}

/**
 * One board card (design.md §14 Board row): Jira key link, summary,
 * runtime badge, age in column, cost so far.
 */
export function TaskCard({ card, now }: TaskCardProps) {
  return (
    <li data-testid="board-card">
      <Link to={`/tasks/${card.id}`}>{card.jiraKey}</Link>
      <p>{card.jiraSummary}</p>
      <span data-testid="runtime-badge">{card.runtime ?? "none"}</span>
      <span data-testid="card-age">{formatAge(card.updatedAt, now)}</span>
      <span data-testid="card-cost">{formatCostUsd(card.cost)}</span>
    </li>
  );
}
