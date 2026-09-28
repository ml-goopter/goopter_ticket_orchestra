import { Link } from "react-router";
import { StateBadge } from "../ui/StateBadge.js";
import { Time } from "../ui/Time.js";
import { Markdown } from "../ui/Markdown.js";
import { humanizeEnum } from "../ui/humanizeEnum.js";
import { formatNumber, formatUsd } from "../ui/number.js";
import { shortTypeLabel, typeLabel } from "./eventFamilies.js";
import type { TimelineItem } from "./timelineItems.js";

export interface TimelineRowProps {
  item: TimelineItem;
  /** The task this row belongs to, for the spec builder link (`kind: "spec_revision"`). */
  taskId: string;
}

/**
 * One timeline row (design.md §14 Task detail, task contract C): a compact
 * one-liner -- type label, one-line human summary, relative `Time`
 * right-aligned, all on one flex row (T1 fix: was a ~90px bordered card per
 * row with the label on its own line). A row with multi-line content
 * (`agent.message` markdown, an expanded `agent.tool_call`) grows taller
 * naturally; every other row stays close to one line. Never a raw JSON
 * string outside a collapsed `<details>` (AC1).
 *
 * The label column shows `shortTypeLabel` (one word, e.g. "Execution",
 * "Worktree") rather than the full `typeLabel` (T7 fix: the full label
 * truncated illegibly at column width); the full event type stays
 * available via the `title` attribute.
 */
export function TimelineRow({ item, taskId }: TimelineRowProps) {
  return (
    <li className="timeline-item" data-testid="timeline-item" data-type={item.type}>
      <span className="timeline-item__label" title={typeLabel(item.type)}>
        {shortTypeLabel(item.type)}
      </span>
      <div className="timeline-item__body">
        <TimelineRowBody item={item} taskId={taskId} />
      </div>
      <Time value={item.createdAt} />
    </li>
  );
}

function TimelineRowBody({ item, taskId }: TimelineRowProps) {
  switch (item.kind) {
    case "message":
      return (
        <div className="timeline-item__message">
          <Markdown>{item.text ?? ""}</Markdown>
          {!item.final && (
            <span className="timeline-item__in-progress" data-testid="message-in-progress">
              …
            </span>
          )}
        </div>
      );

    case "tool_call":
      return (
        <details className="timeline-item__disclosure">
          <summary>{item.toolName}</summary>
          <pre>{JSON.stringify(item.toolInput, null, 2)}</pre>
          {item.toolOk === false && (
            <p className="timeline-item__tool-error" role="alert">
              {item.toolError ?? "Tool call failed."}
            </p>
          )}
        </details>
      );

    case "state_changed":
      return (
        <span className="timeline-item__transition">
          {item.from && (
            <>
              <StateBadge state={item.from} />
              <span aria-hidden="true"> → </span>
            </>
          )}
          <StateBadge state={item.to ?? "?"} />
        </span>
      );

    case "worktree":
      return (
        <span className="timeline-item__mono">
          {item.worktreeBranch ?? "no branch"}
          {item.worktreePath && <> · {item.worktreePath}</>}
        </span>
      );

    case "usage":
      return (
        <span>
          {item.usageModel ?? "unknown model"} — {formatNumber(item.usageInputTokens ?? 0)} in /{" "}
          {formatNumber(item.usageCachedTokens ?? 0)} cached / {formatNumber(item.usageOutputTokens ?? 0)} out —{" "}
          {formatUsd(item.usageCostUsd ?? 0)}
          {item.usageRound != null && ` (round ${item.usageRound})`}
        </span>
      );

    case "review":
      return (
        <span>
          Review round {item.reviewRound ?? "?"}
          {item.reviewVerdict && <> — {humanizeEnum(item.reviewVerdict)}</>}
          {item.reviewFindingsCount != null && (
            <>
              , {item.reviewFindingsCount} finding{item.reviewFindingsCount === 1 ? "" : "s"}
            </>
          )}
        </span>
      );

    case "pull_request":
      return (
        <span>
          Pull request{" "}
          {item.prUrl ? (
            <a href={item.prUrl} target="_blank" rel="noopener noreferrer">
              #{item.prNumber}
            </a>
          ) : (
            `#${item.prNumber ?? "?"}`
          )}{" "}
          opened
        </span>
      );

    case "outcome":
      return <span>{item.outcomeText}</span>;

    case "issue": {
      const label = item.issueTitle ?? (item.issueKindLabel ? humanizeEnum(item.issueKindLabel) : "Issue");
      return (
        <span>
          {label}
          {item.issueBlocking && <span className="badge badge--attention">Blocking</span>}
          {item.issueId && (
            <>
              {" "}
              <Link to={`/issues/${item.issueId}`}>Open issue</Link>
            </>
          )}
        </span>
      );
    }

    case "spec_revision":
      return (
        <span>
          v{item.specVersion ?? "?"} <Link to={`/tasks/${taskId}/spec`}>Open spec builder</Link>
        </span>
      );

    case "generic":
    default:
      return (
        <details className="timeline-item__disclosure">
          <summary>Details</summary>
          <pre>{JSON.stringify(item.payload, null, 2)}</pre>
        </details>
      );
  }
}
