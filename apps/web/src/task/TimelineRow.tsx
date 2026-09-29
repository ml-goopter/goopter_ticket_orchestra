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
 * Cap on the pretty-printed JSON shown for a tool call's input or an
 * unknown event's raw payload (GOT.65). Both come from event producers
 * outside this app's control and can be arbitrarily large; without a cap,
 * expanding a `<details>` disclosure containing one can render and lay out
 * a multi-megabyte `<pre>` block, visibly slowing (or freezing) the tab.
 * A few thousand characters is enough to show useful context while keeping
 * the DOM node small.
 */
const JSON_PREVIEW_LIMIT = 4000;

/**
 * Pretty-prints `value` the same way `JSON.stringify(value, null, 2)` always
 * has, capped at `JSON_PREVIEW_LIMIT` characters (GOT.65, AC1: never an
 * unbounded JSON string). A payload at or under the cap renders identically
 * to before; over the cap, the text is cut at the limit and the caller
 * shows `omittedChars` in a truncation notice.
 */
function previewJson(value: unknown): { text: string; omittedChars: number } {
  const full = JSON.stringify(value, null, 2);
  if (full.length <= JSON_PREVIEW_LIMIT) {
    return { text: full, omittedChars: 0 };
  }
  // Cutting at JSON_PREVIEW_LIMIT can land between the two UTF-16 code units
  // of an astral character (e.g. an emoji), leaving a lone high surrogate at
  // the end of the preview. Pull the cut back one code unit in that case so
  // the preview never ends mid-pair.
  let cut = JSON_PREVIEW_LIMIT;
  const lastCode = full.charCodeAt(cut - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut -= 1;
  }
  return { text: full.slice(0, cut), omittedChars: full.length - cut };
}

function JsonPreview({ value }: { value: unknown }) {
  const { text, omittedChars } = previewJson(value);
  return (
    <>
      <pre>{text}</pre>
      {omittedChars > 0 && (
        <p className="timeline-item__truncated" data-testid="json-truncated-notice">
          Truncated — {formatNumber(omittedChars)} more character{omittedChars === 1 ? "" : "s"} not shown.
        </p>
      )}
    </>
  );
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
          <JsonPreview value={item.toolInput} />
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
          <JsonPreview value={item.payload} />
        </details>
      );
  }
}
