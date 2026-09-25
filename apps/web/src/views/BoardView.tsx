import { useCallback, useEffect, useMemo, useState } from "react";
import { createApiClient, type BoardApiClient } from "../api/client.js";
import type { TaskCard as TaskCardData } from "../api/types.js";
import { BOARD_COLUMN_ORDER, groupByColumn, HIGHLIGHTED_COLUMNS } from "../board/columns.js";
import { TaskCard } from "../board/TaskCard.js";
import { useRefetchOnReconnect } from "../board/useEventReconnect.js";
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

  const fetchCards = useCallback(async () => {
    try {
      const result = await apiClient.listTasks();
      setCards(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the board.");
    }
  }, [apiClient]);

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
      <h1>Board</h1>
      {error && <p role="alert">{error}</p>}
      {!error && cards === null && <p>Loading...</p>}
      {grouped && (
        <div className="board">
          {BOARD_COLUMN_ORDER.map((column) => {
            const columnCards = grouped.get(column) ?? [];
            const highlighted = HIGHLIGHTED_COLUMNS.has(column);
            return (
              <section
                key={column}
                aria-label={column}
                className={highlighted ? "board-column board-column--highlighted" : "board-column"}
                data-highlighted={highlighted}
              >
                <h2>{column}</h2>
                {columnCards.length === 0 ? (
                  <p>No tasks.</p>
                ) : (
                  <ul>
                    {columnCards.map((card) => (
                      <TaskCard key={card.id} card={card} now={currentTime} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
