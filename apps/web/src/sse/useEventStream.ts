import { useEffect, useRef, useState } from "react";
import { EXECUTION_EVENT_TYPES, type ExecutionEventType } from "@orchestra/core";

export type EventStreamStatus = "connecting" | "open" | "closed";

/** Default `StreamEvent["type"]` when a caller does not supply `types`. */
export type DefaultStreamEventType = ExecutionEventType | "message";

export interface StreamEvent<T extends string = DefaultStreamEventType> {
  type: T;
  data: unknown;
  id: string | null;
}

export interface MessageEventLike {
  data: string;
  lastEventId?: string;
}

/**
 * Minimal shape of the browser `EventSource` that the hook depends on, so
 * tests can inject a fake implementation instead of the real thing.
 */
export interface EventSourceLike {
  close(): void;
  addEventListener(type: string, listener: (event: MessageEventLike) => void): void;
  onerror: ((event: unknown) => void) | null;
  onopen: (() => void) | null;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface UseEventStreamOptions<T extends string = DefaultStreamEventType> {
  onEvent?: (event: StreamEvent<T>) => void;
  /** Defaults to true; set false to tear the connection down. */
  enabled?: boolean;
  /** Defaults to the real `EventSource`. */
  createEventSource?: EventSourceFactory;
  /**
   * Event types to subscribe to. Defaults to every execution event type plus
   * "message". The dashboard passes the §12.6 `GET /stream` set —
   * `task.state_changed`, `issue.created`, `issue.resolved`, `notification`
   * — to receive `notification` events, which the default list omits.
   *
   * `T` is inferred from this array (pass `as const` for a literal union), so
   * `StreamEvent<T>["type"]` narrows to exactly the configured types without
   * a cast at the call site.
   */
  types?: readonly T[];
}

export interface UseEventStreamResult {
  status: EventStreamStatus;
  lastEventId: string | null;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

const defaultFactory: EventSourceFactory = (url) =>
  new EventSource(url) as unknown as EventSourceLike;

// The server sends `event: <type>` per row (design.md §12.6), so the client
// has to subscribe to every known type plus the unnamed default "message".
const SUBSCRIBED_TYPES: readonly DefaultStreamEventType[] = [
  ...EXECUTION_EVENT_TYPES,
  "message",
];

/**
 * SSE subscription with `Last-Event-ID` resume (design.md §12.6). Browsers
 * resend `Last-Event-ID` automatically on reconnect; the `?after=` query
 * param is the explicit fallback the server also accepts. Reconnects with
 * exponential backoff (1s, 2s, 4s, ... capped at 30s), reset once the
 * connection opens successfully.
 */
export function useEventStream<T extends string = DefaultStreamEventType>(
  url: string,
  options: UseEventStreamOptions<T> = {},
): UseEventStreamResult {
  const {
    onEvent,
    enabled = true,
    createEventSource = defaultFactory,
    // Only reached when the caller also leaves `T` at its default, so the
    // default list's `DefaultStreamEventType` elements are always valid `T`s.
    types = SUBSCRIBED_TYPES as unknown as readonly T[],
  } = options;

  const [status, setStatus] = useState<EventStreamStatus>("closed");
  const [lastEventId, setLastEventId] = useState<string | null>(null);

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const lastEventIdRef = useRef<string | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Depending on `types` itself reconnects on every render for a caller that
  // passes an inline array literal, since a new array is `!==` the previous
  // one even when its contents are identical (F2). Keying on the de-duped,
  // sorted contents instead means only an actual change in the type *set*
  // triggers the effect below. `JSON.stringify` of the array (rather than a
  // joined string) avoids the collision a joined key has between e.g.
  // `["a,b"]` and `["a", "b"]` (F4).
  const typesKey = JSON.stringify([...new Set(types)].sort());

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let disposed = false;
    let currentSource: EventSourceLike | null = null;

    function clearTimer() {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function connect() {
      if (disposed) {
        return;
      }

      const after = lastEventIdRef.current;
      const separator = url.includes("?") ? "&" : "?";
      const fullUrl = after === null ? url : `${url}${separator}after=${after}`;

      setStatus("connecting");
      const source = createEventSource(fullUrl);
      currentSource = source;

      source.onopen = () => {
        if (disposed) return;
        attemptRef.current = 0;
        setStatus("open");
      };

      source.onerror = () => {
        source.close();
        if (disposed) return;
        setStatus("closed");
        const delay = Math.min(MIN_BACKOFF_MS * 2 ** attemptRef.current, MAX_BACKOFF_MS);
        attemptRef.current += 1;
        clearTimer();
        timerRef.current = setTimeout(connect, delay);
      };

      for (const type of types) {
        source.addEventListener(type, (event) => {
          if (disposed) return;
          if (event.lastEventId) {
            lastEventIdRef.current = event.lastEventId;
            setLastEventId(event.lastEventId);
          }

          let data: unknown = event.data;
          try {
            data = JSON.parse(event.data) as unknown;
          } catch {
            // Not JSON; deliver the raw string.
          }

          onEventRef.current?.({
            type,
            data,
            id: event.lastEventId ?? null,
          });
        });
      }
    }

    connect();

    return () => {
      disposed = true;
      clearTimer();
      currentSource?.close();
      attemptRef.current = 0;
      setStatus("closed");
    };
    // `types` itself is intentionally not a dependency: `typesKey` is its
    // stable, content-based stand-in (F2).
  }, [url, enabled, createEventSource, typesKey]);

  return { status, lastEventId };
}
