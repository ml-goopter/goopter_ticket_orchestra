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
 * One board card (design.md §14 Board row, approved mockup UR2): top row is
 * the Jira key link and cost, then the summary (clamped to 2 lines, full
 * text in `title`), then a meta row of the runtime tag and age. A card in a
 * highlighted column carries a matching accent (`.board-card--highlighted`).
 */
export function TaskCard({ card, now, highlighted }: TaskCardProps) {
  return (
    <li
      data-testid="board-card"
      className={highlighted ? "board-card board-card--highlighted" : "board-card"}
    >
      <div className="board-card__top">
        <Link to={`/tasks/${card.id}`} className="board-card__key">
          {card.jiraKey}
        </Link>
        <span className="board-card__cost" data-testid="card-cost">
          {formatCost(card.cost)}
        </span>
      </div>
      <p className="board-card__summary" title={card.jiraSummary}>
        {card.jiraSummary}
      </p>
      <div className="board-card__meta">
        <span className="tag" data-testid="runtime-tag">
          {card.runtime ?? "none"}
        </span>
        <span className="board-card__age" data-testid="card-age">
          {formatAge(card.updatedAt, now)}
        </span>
      </div>
    </li>
  );
}
