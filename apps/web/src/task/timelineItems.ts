import { createDeltaAccumulator } from "../sse/deltas.js";
import type { TimelineEvent } from "../api/types.js";

/**
 * One rendered row of the task timeline (design.md §14 Task detail, task
 * contract C). `agent.message.delta` rows for one execution collapse into a
 * single `"message"` item via `createDeltaAccumulator`; the matching
 * `agent.message` replaces that item's text with the final text and marks
 * it `final`.
 *
 * Every field below is additive and stable: a consumer (the spec builder,
 * `../views/SpecBuilderView.tsx`, imports `buildTimelineItems` directly and
 * only reads `kind`, `key`, `text`, `final`, `toolName`) must keep working
 * unchanged, so no existing field is ever renamed, removed, or repurposed.
 */
export interface TimelineItem {
  key: string;
  /** The representative `execution_events.type`, used for family filtering. */
  type: string;
  /** Id of the last event folded into this item. */
  eventId: number;
  createdAt: string;
  executionId: string | null;
  kind:
    | "message"
    | "tool_call"
    | "state_changed"
    | "worktree"
    | "usage"
    | "review"
    | "pull_request"
    | "outcome"
    | "issue"
    | "spec_revision"
    | "generic";
  /** `kind: "message"` */
  text?: string;
  final?: boolean;
  /** `kind: "tool_call"` */
  toolName?: string;
  toolInput?: unknown;
  /** `kind: "tool_call"`: `payload.ok === false`, and its `payload.error` if present. */
  toolOk?: boolean;
  toolError?: string;
  /**
   * `kind: "state_changed"` (`task.state_changed`, and any `execution.*`
   * transition event carrying `from`/`to`, design.md §9.6). `from` is
   * `null` for a transition with no meaningful prior state.
   */
  from?: string | null;
  to?: string;
  trigger?: string;
  /** `kind: "worktree"` (`worktree.prepared`). */
  worktreeBranch?: string | null;
  worktreePath?: string;
  /** `kind: "usage"` (`usage.recorded`). */
  usageModel?: string;
  usageInputTokens?: number;
  usageCachedTokens?: number;
  usageOutputTokens?: number;
  usageCostUsd?: number;
  usageRound?: number | null;
  usageKindLabel?: string;
  /** `kind: "review"` (`review.started`, `review.result`). */
  reviewRound?: number;
  reviewVerdict?: string;
  reviewFindingsCount?: number;
  /** `kind: "pull_request"` (`pull_request.created`). */
  prNumber?: number;
  prUrl?: string;
  /** `kind: "outcome"` (`ci.*`, `pull_request.merged`/`.closed`): a readable one-line outcome. */
  outcomeText?: string;
  /** `kind: "issue"` (`issue.created`, `issue.resolved`). */
  issueId?: string;
  issueTitle?: string;
  issueKindLabel?: string;
  issueBlocking?: boolean;
  /** `kind: "spec_revision"` (`spec.proposed`, `spec.revised`, `spec.approved`). */
  specVersion?: number;
  specRevisionId?: string;
  /**
   * `kind: "generic"`: any `execution_events.type` with no dedicated
   * rendering (design.md §14 Task detail). `payload` is the untouched raw
   * event payload, rendered only inside a collapsed details block -- never
   * inlined as a JSON string (AC1).
   */
  payload?: unknown;
  /** @deprecated unused since the generic row moved to a collapsed `payload` block; kept only for field stability. */
  summary?: string;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function boolField(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

/**
 * Merges freshly-loaded or freshly-delivered events into an existing,
 * ascending, deduplicated-by-id list (AC3: a delivered event appears once
 * even when delivered twice, e.g. by an SSE redelivery after reconnect
 * catch-up overlaps the backlog page).
 */
export function mergeTimelineEvents(
  existing: readonly TimelineEvent[],
  incoming: readonly TimelineEvent[],
): TimelineEvent[] {
  const byId = new Map<number, TimelineEvent>();
  for (const event of existing) {
    byId.set(event.id, event);
  }
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Builds the ascending list of render items from an ascending, deduplicated
 * event list (AC4). Recomputed from the full event list on every change:
 * simpler than incremental state, and cheap at this app's scale (a single
 * task's event log).
 */
export function buildTimelineItems(events: readonly TimelineEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const openMessageIndex = new Map<string, number>();
  const deltas = createDeltaAccumulator();

  for (const event of events) {
    const executionId = event.executionId;
    const bufferKey = executionId ?? `no-execution:${event.id}`;

    if (event.type === "agent.message.delta") {
      const record = asRecord(event.payload);
      const text = stringField(record, "text", "delta") ?? "";
      const combined = deltas.append(bufferKey, text);
      const existingIndex = openMessageIndex.get(bufferKey);
      if (existingIndex !== undefined) {
        items[existingIndex] = {
          ...items[existingIndex]!,
          text: combined,
          eventId: event.id,
          createdAt: event.createdAt,
        };
      } else {
        openMessageIndex.set(bufferKey, items.length);
        items.push({
          key: `message:${bufferKey}`,
          type: event.type,
          eventId: event.id,
          createdAt: event.createdAt,
          executionId,
          kind: "message",
          text: combined,
          final: false,
        });
      }
      continue;
    }

    if (event.type === "agent.message") {
      const record = asRecord(event.payload);
      const text = stringField(record, "text", "content") ?? "";
      deltas.flush(bufferKey);
      const existingIndex = openMessageIndex.get(bufferKey);
      if (existingIndex !== undefined) {
        items[existingIndex] = {
          ...items[existingIndex]!,
          type: event.type,
          eventId: event.id,
          createdAt: event.createdAt,
          text,
          final: true,
        };
        openMessageIndex.delete(bufferKey);
      } else {
        items.push({
          key: `message:${bufferKey}`,
          type: event.type,
          eventId: event.id,
          createdAt: event.createdAt,
          executionId,
          kind: "message",
          text,
          final: true,
        });
      }
      continue;
    }

    if (event.type === "agent.tool_call") {
      const record = asRecord(event.payload);
      // The agent-tools server records the tool name under `tool`
      // (apps/worker/src/agent-tools/invoke.ts:263); older or ad hoc
      // payloads may use `name` instead. `name` wins when both are present
      // (AC2).
      items.push({
        key: `event:${event.id}`,
        type: event.type,
        eventId: event.id,
        createdAt: event.createdAt,
        executionId,
        kind: "tool_call",
        toolName: stringField(record, "name", "tool") ?? "tool",
        toolInput: "input" in record ? record.input : record,
        toolOk: boolField(record, "ok"),
        toolError: stringField(record, "error"),
      });
      continue;
    }

    // `task.state_changed` and any `execution.*` transition event
    // (`execution.assigned`/`.started`/`.resumed`/`.waiting`/`.completed`/
    // `.failed`/`.cancelled`, packages/db/src/transition.ts) share the same
    // `{ from, to, trigger, actor }` payload shape. `execution.queued` and
    // `execution.heartbeat` are not transitions and carry no `to`, so they
    // fall through to the generic row below.
    if (
      event.type === "task.state_changed" ||
      (event.type.startsWith("execution.") && typeof asRecord(event.payload)["to"] === "string")
    ) {
      const record = asRecord(event.payload);
      items.push({
        key: `event:${event.id}`,
        type: event.type,
        eventId: event.id,
        createdAt: event.createdAt,
        executionId,
        kind: "state_changed",
        from: stringField(record, "from") ?? null,
        to: stringField(record, "to") ?? "?",
        trigger: stringField(record, "trigger"),
      });
      continue;
    }

    if (event.type === "worktree.prepared") {
      const record = asRecord(event.payload);
      items.push({
        key: `event:${event.id}`,
        type: event.type,
        eventId: event.id,
        createdAt: event.createdAt,
        executionId,
        kind: "worktree",
        worktreeBranch: stringField(record, "branch") ?? null,
        worktreePath: stringField(record, "worktree_path"),
      });
      continue;
    }

    if (event.type === "usage.recorded") {
      const record = asRecord(event.payload);
      items.push({
        key: `event:${event.id}`,
        type: event.type,
        eventId: event.id,
        createdAt: event.createdAt,
        executionId,
        kind: "usage",
        usageModel: stringField(record, "model"),
        usageInputTokens: numberField(record, "input_tokens"),
        usageCachedTokens: numberField(record, "cached_input_tokens"),
        usageOutputTokens: numberField(record, "output_tokens"),
        usageCostUsd: numberField(record, "cost_usd"),
        usageRound: numberField(record, "round") ?? null,
        usageKindLabel: stringField(record, "kind"),
      });
      continue;
    }

    if (event.type === "review.started" || event.type === "review.result") {
      const record = asRecord(event.payload);
      items.push({
        key: `event:${event.id}`,
        type: event.type,
        eventId: event.id,
        createdAt: event.createdAt,
        executionId,
        kind: "review",
        reviewRound: numberField(record, "round"),
        reviewVerdict: stringField(record, "verdict"),
        reviewFindingsCount: numberField(record, "findings_count"),
      });
      continue;
    }

    if (event.type === "pull_request.created") {
      const record = asRecord(event.payload);
      items.push({
        key: `event:${event.id}`,
        type: event.type,
        eventId: event.id,
        createdAt: event.createdAt,
        executionId,
        kind: "pull_request",
        prNumber: numberField(record, "number"),
        prUrl: stringField(record, "url"),
      });
      continue;
    }

    if (
      event.type.startsWith("ci.") ||
      event.type === "pull_request.merged" ||
      event.type === "pull_request.closed"
    ) {
      const record = asRecord(event.payload);
      items.push({
        key: `event:${event.id}`,
        type: event.type,
        eventId: event.id,
        createdAt: event.createdAt,
        executionId,
        kind: "outcome",
        outcomeText: describeOutcome(event.type, record),
      });
      continue;
    }

    if (event.type === "issue.created" || event.type === "issue.resolved") {
      const record = asRecord(event.payload);
      items.push({
        key: `event:${event.id}`,
        type: event.type,
        eventId: event.id,
        createdAt: event.createdAt,
        executionId,
        kind: "issue",
        issueId: stringField(record, "issue_id"),
        issueTitle: stringField(record, "title"),
        issueKindLabel: stringField(record, "kind", "type", "status"),
        issueBlocking: boolField(record, "blocking"),
      });
      continue;
    }

    if (event.type === "spec.proposed" || event.type === "spec.revised" || event.type === "spec.approved") {
      const record = asRecord(event.payload);
      items.push({
        key: `event:${event.id}`,
        type: event.type,
        eventId: event.id,
        createdAt: event.createdAt,
        executionId,
        kind: "spec_revision",
        specVersion: numberField(record, "version"),
        specRevisionId: stringField(record, "revision_id"),
      });
      continue;
    }

    items.push({
      key: `event:${event.id}`,
      type: event.type,
      eventId: event.id,
      createdAt: event.createdAt,
      executionId,
      kind: "generic",
      payload: event.payload,
    });
  }

  return items;
}

/** A one-line readable outcome for a `ci.*` or `pull_request.merged`/`.closed` event. */
function describeOutcome(type: string, record: Record<string, unknown>): string {
  switch (type) {
    case "ci.started":
      return "CI started";
    case "ci.failed": {
      const round = numberField(record, "round");
      const checks = Array.isArray(record["checks"]) ? record["checks"].length : undefined;
      const parts = ["CI failed"];
      if (round !== undefined) parts.push(`round ${round}`);
      if (checks !== undefined) parts.push(`${checks} check${checks === 1 ? "" : "s"} failed`);
      return parts.join(" - ");
    }
    case "ci.passed":
      return boolField(record, "no_checks") ? "CI passed (no checks)" : "CI passed";
    case "pull_request.merged":
      return "Pull request merged";
    case "pull_request.closed":
      return "Pull request closed";
    default:
      return typeof type === "string" ? type : "Unknown outcome";
  }
}
