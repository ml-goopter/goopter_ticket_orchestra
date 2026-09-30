import { useCallback, useEffect, useMemo, useState } from "react";
import { createApiClient, type BoardApiClient } from "../api/client.js";
import type { TaskCard as TaskCardData } from "../api/types.js";
import "../board/board.css";
import { BOARD_COLUMN_ORDER, columnAccent, groupByColumn, HIGHLIGHTED_COLUMNS } from "../board/columns.js";
import { TaskCard } from "../board/TaskCard.js";
import { useRefetchOnReconnect } from "../board/useEventReconnect.js";
import { useLatestRequest } from "../board/useLatestRequest.js";
import { useEventStream, type EventSourceFactory } from "../sse/useEventStream.js";

export interface BoardViewProps {
  /** Injectable for tests; defaults to a real createApiClient(). */
  client?: BoardApiClient;
  /** Injectable for tests; defaults to the real `EventSource`. */
  createEventSource?: EventSourceFactory;
  /** Injectable for tests, so card age is deterministic. */
  now?: () => Date;
}

const STREAM_TYPES = ["task.state_changed", "issue.created", "issue.resolved"] as const;

/**
 * Board (design.md §14, spec §25): the ten §5.1 columns, live-updated over
 * SSE. `GET /stream` has no replay (docs/build-order.md GOT.36
 * carry-forward), so both a `task.state_changed` event and a reconnect
 * trigger a full `listTasks()` refetch rather than a local patch.
 */
export function BoardView({ client, createEventSource, now = () => new Date() }: BoardViewProps = {}) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const [cards, setCards] = useState<TaskCardData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { begin, isCurrent } = useLatestRequest();

  const fetchCards = useCallback(async () => {
    const generation = begin();
    try {
      const result = await apiClient.listTasks();
      if (!isCurrent(generation)) return;
      setCards(result);
      setError(null);
    } catch (err) {
      if (!isCurrent(generation)) return;
      setError(err instanceof Error ? err.message : "Failed to load the board.");
    }
  }, [apiClient, begin, isCurrent]);

  useEffect(() => {
    void fetchCards();
  }, [fetchCards]);

  // A caller-supplied `createEventSource` (tests) always enables the
  // subscription; otherwise it needs the real `EventSource` global, which
  // Node test environments (e.g. router.test.tsx, rendering `BoardView`
  // with no overrides) do not provide. Guarding here rather than in the
  // hook keeps that environment gap out of apps/web/src/sse (owned by
  // another task) while still connecting for real in every browser.
  const eventSourceAvailable = createEventSource !== undefined || typeof EventSource !== "undefined";

  const { status } = useEventStream("/api/stream", {
    types: STREAM_TYPES,
    createEventSource,
    enabled: eventSourceAvailable,
    onEvent: (event) => {
      if (event.type === "task.state_changed") {
        void fetchCards();
      }
    },
  });

  useRefetchOnReconnect(status, () => void fetchCards());

  const grouped = cards ? groupByColumn(cards) : null;
  const currentTime = now();

  return (
    <main>
      {/*
       * The topbar and the kanban row both live inside `.board-bleed` (B4,
       * UR2): AppLayout's `.page` centres its content at max-width 1200px,
       * so either one outside the bleed would sit at a different left edge
       * than a full-width board. Sharing the wrapper keeps the topbar's
       * border and the first column starting at the same x regardless of
       * viewport width.
       */}
      <div className="board-bleed">
        <div className="topbar">
          <div className="topbar__crumbs">
            <h1 className="topbar__crumb-current">Board</h1>
            {/* AC1: "· N tasks" from the already-loaded cards, no extra request. */}
            {cards !== null && <span>· {cards.length} tasks</span>}
          </div>
          <div className="topbar__spacer" />
        </div>
        <div className="board-bleed__content">
          {error && (
            <p role="alert" className="alert alert--error">
              {error}
            </p>
          )}
          {!error && cards === null && <p>Loading...</p>}
          {grouped && (
            <div className="kanban">
              {BOARD_COLUMN_ORDER.map((column) => {
                const columnCards = grouped.get(column) ?? [];
                const highlighted = HIGHLIGHTED_COLUMNS.has(column);
                const populated = columnCards.length > 0;
                // Empty, non-highlighted columns collapse to a narrow rail
                // (header only, name rotated, no card area) so a real
                // board's mostly-empty columns don't push the populated
                // ones off screen (B1/B3). An empty but highlighted column
                // stays full height but narrower than a populated one;
                // any populated column is always full width.
                const compact = !highlighted && !populated;
                const highlightedEmpty = highlighted && !populated;
                const columnClassName = [
                  "kanban__column",
                  highlighted && "kanban__column--highlighted",
                  compact && "board-column--compact",
                  highlightedEmpty && "board-column--highlighted-empty",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <section
                    key={column}
                    aria-label={column}
                    className={columnClassName}
                    data-highlighted={highlighted}
                    data-compact={compact}
                  >
                    <div className="kanban__column-header">
                      <span
                        aria-hidden="true"
                        className={`board-column__dot board-column__dot--${columnAccent(column)}`}
                      />
                      <h2>{column}</h2>
                      <span className={highlighted ? "badge badge--attention" : "badge badge--neutral"}>
                        {columnCards.length}
                      </span>
                    </div>
                    {!compact && (
                      <div className="kanban__column-body">
                        {columnCards.length === 0 ? (
                          <p className="board-empty">No tasks.</p>
                        ) : (
                          <ul className="board-list">
                            {columnCards.map((card) => (
                              <TaskCard key={card.id} card={card} now={currentTime} highlighted={highlighted} />
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
