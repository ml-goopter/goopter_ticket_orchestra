import { useEffect, useRef, useState } from "react";
import { EXECUTION_EVENT_TYPES, type ExecutionEventType } from "@orchestra/core";

export type EventStreamStatus = "connecting" | "open" | "closed";

export interface StreamEvent {
  type: ExecutionEventType | "message";
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

export interface UseEventStreamOptions {
  onEvent?: (event: StreamEvent) => void;
  /** Defaults to true; set false to tear the connection down. */
  enabled?: boolean;
  /** Defaults to the real `EventSource`. */
  createEventSource?: EventSourceFactory;
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
const SUBSCRIBED_TYPES: readonly string[] = [...EXECUTION_EVENT_TYPES, "message"];

/**
 * SSE subscription with `Last-Event-ID` resume (design.md §12.6). Browsers
 * resend `Last-Event-ID` automatically on reconnect; the `?after=` query
 * param is the explicit fallback the server also accepts. Reconnects with
 * exponential backoff (1s, 2s, 4s, ... capped at 30s), reset once the
 * connection opens successfully.
 */
export function useEventStream(
  url: string,
  options: UseEventStreamOptions = {},
): UseEventStreamResult {
  const { onEvent, enabled = true, createEventSource = defaultFactory } = options;

  const [status, setStatus] = useState<EventStreamStatus>("closed");
  const [lastEventId, setLastEventId] = useState<string | null>(null);

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const lastEventIdRef = useRef<string | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

      const after = lastEventIdRef.current ?? "";
      const separator = url.includes("?") ? "&" : "?";
      const fullUrl = `${url}${separator}after=${after}`;

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

      for (const type of SUBSCRIBED_TYPES) {
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
            type: type as StreamEvent["type"],
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
  }, [url, enabled, createEventSource]);

  return { status, lastEventId };
}
