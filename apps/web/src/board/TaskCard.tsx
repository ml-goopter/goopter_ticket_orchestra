import { Link } from "react-router";
import type { TaskCard as TaskCardData } from "../api/types.js";
import { formatUsd } from "../ui/number.js";
import { formatAge } from "./format.js";

export interface TaskCardProps {
  card: TaskCardData;
  /** Current time, injected so age is deterministic in tests. */
  now: Date;
  /** Whether the card's column is one of `HIGHLIGHTED_COLUMNS` (design.md §14). */
  highlighted: boolean;
}

/** `formatUsd`, with an em dash for a cost that isn't a finite number. */
function formatCost(costUsd: number): string {
  return Number.isFinite(costUsd) ? formatUsd(costUsd) : "—";
}

/**
 * One board card (design.md §14 Board row): Jira key link, summary
 * (clamped to 3 lines, full text in `title`), runtime badge, age in
 * column, cost so far. A card in a highlighted column carries a matching
 * accent (`.board-card--highlighted`).
 */
export function TaskCard({ card, now, highlighted }: TaskCardProps) {
  return (
    <li
      data-testid="board-card"
      className={highlighted ? "board-card board-card--highlighted" : "board-card"}
    >
      <Link to={`/tasks/${card.id}`} className="board-card__key">
        {card.jiraKey}
      </Link>
      <p className="board-card__summary" title={card.jiraSummary}>
        {card.jiraSummary}
      </p>
      <div className="board-card__meta">
        <span className="badge badge--neutral" data-testid="runtime-badge">
          {card.runtime ?? "none"}
        </span>
        <span className="board-card__age" data-testid="card-age">
          {formatAge(card.updatedAt, now)}
        </span>
        <span className="board-card__cost" data-testid="card-cost">
          {formatCost(card.cost)}
        </span>
      </div>
    </li>
  );
}
