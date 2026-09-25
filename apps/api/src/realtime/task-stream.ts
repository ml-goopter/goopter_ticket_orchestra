import type { SseConnection, StreamEvent } from "./sse.js";

/**
 * Returns the task's events with `id > after`, ascending, and whether the
 * page was full (so more may follow).
 */
export type BacklogPage = (
  after: number,
) => Promise<{ events: StreamEvent[]; full: boolean }>;

export interface TaskStreamOptions {
  sse: SseConnection;
  /**
   * Explicit resume cursor (Last-Event-ID, else `?after=`). When set, the
   * stream sends the backlog after it before any live event (H3).
   */
  cursor: number | undefined;
  /**
   * Dedup floor for a stream opened without a cursor: the highest event id
   * the hub had seen when this stream subscribed. It sends no backlog, but
   * a LISTEN reconnect re-queries from here (H4), so events committed while
   * the connection was down are not lost before the first live send.
   */
  anchor: number | undefined;
  backlog: BacklogPage;
  onError(err: unknown): void;
}

/**
 * Per-subscriber delivery for `GET /tasks/:id/stream` (design.md §12.6).
 *
 * H3: the stream is registered for live delivery before its backlog query
 * runs. While a backlog query is in flight, live events are buffered; once
 * the backlog is sent the buffer is flushed in id order. Every send drops
 * an event whose id is at or below the last id sent, so the seam between
 * backlog and live delivery has neither gaps nor duplicates.
 *
 * H4: `resync()` re-runs the backlog query after the last sent id.
 */
export class TaskStream {
  private lastSentId: number | undefined;
  private syncing = false;
  private resyncRequested = false;
  private buffer: StreamEvent[] = [];

  constructor(private readonly options: TaskStreamOptions) {
    this.lastSentId = options.cursor ?? options.anchor;
  }

  /** Call after the stream is registered with the hub. */
  start(): void {
    if (this.options.cursor !== undefined) {
      void this.sync();
    }
  }

  push(event: StreamEvent): void {
    if (this.options.sse.isClosed) return;
    if (this.syncing) {
      this.buffer.push(event);
      return;
    }
    this.send(event);
  }

  resync(): void {
    if (this.options.sse.isClosed || this.lastSentId === undefined) return;
    if (this.syncing) {
      this.resyncRequested = true;
      return;
    }
    void this.sync();
  }

  private send(event: StreamEvent): void {
    if (this.lastSentId !== undefined && event.id <= this.lastSentId) return;
    this.options.sse.write(event.frame);
    this.lastSentId = event.id;
  }

  private async sync(): Promise<void> {
    this.syncing = true;
    try {
      do {
        this.resyncRequested = false;
        let full = true;
        while (full && !this.options.sse.isClosed) {
          const page = await this.options.backlog(this.lastSentId ?? 0);
          for (const event of page.events) this.send(event);
          full = page.full;
        }
      } while (this.resyncRequested && !this.options.sse.isClosed);

      const buffered = this.buffer.sort((a, b) => a.id - b.id);
      this.buffer = [];
      for (const event of buffered) this.send(event);
    } catch (err) {
      // The client reconnects with Last-Event-ID and resumes from there.
      this.options.onError(err);
      this.options.sse.end();
    } finally {
      this.syncing = false;
    }
  }
}
