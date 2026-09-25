import { createDeltaAccumulator } from "../sse/deltas.js";
import type { TimelineEvent } from "../api/types.js";

/**
 * One rendered row of the task timeline (design.md §14 Task detail, task
 * contract C). `agent.message.delta` rows for one execution collapse into a
 * single `"message"` item via `createDeltaAccumulator`; the matching
 * `agent.message` replaces that item's text with the final text and marks
 * it `final`.
 */
export interface TimelineItem {
  key: string;
  /** The representative `execution_events.type`, used for family filtering. */
  type: string;
  /** Id of the last event folded into this item. */
  eventId: number;
  createdAt: string;
  executionId: string | null;
  kind: "message" | "tool_call" | "state_changed" | "generic";
  /** `kind: "message"` */
  text?: string;
  final?: boolean;
  /** `kind: "tool_call"` */
  toolName?: string;
  toolInput?: unknown;
  /** `kind: "state_changed"` */
  from?: string;
  to?: string;
  trigger?: string;
  /** `kind: "generic"`: a compact, one-line rendering of `payload`. */
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

function summarizePayload(payload: unknown): string {
  try {
    const json = JSON.stringify(payload) ?? "";
    return json.length > 160 ? `${json.slice(0, 157)}...` : json;
  } catch {
    return String(payload);
  }
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
      items.push({
        key: `event:${event.id}`,
        type: event.type,
        eventId: event.id,
        createdAt: event.createdAt,
        executionId,
        kind: "tool_call",
        toolName: stringField(record, "name") ?? "tool",
        toolInput: record.input ?? record,
      });
      continue;
    }

    if (event.type === "task.state_changed") {
      const record = asRecord(event.payload);
      items.push({
        key: `event:${event.id}`,
        type: event.type,
        eventId: event.id,
        createdAt: event.createdAt,
        executionId,
        kind: "state_changed",
        from: stringField(record, "from") ?? "?",
        to: stringField(record, "to") ?? "?",
        trigger: stringField(record, "trigger"),
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
      summary: summarizePayload(event.payload),
    });
  }

  return items;
}
