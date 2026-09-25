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
   * For a stream opened without a cursor: reads the task's own highest
   * committed event id (0 if none). The stream sends no backlog and starts
   * after this id. It is read after the stream is registered for live
   * delivery, and one task's events commit in id order, so every event
   * committed after the read has a higher id and is delivered live. A
   * LISTEN reconnect re-queries from here (H4), so events committed while
   * the connection was down are not lost before the first live send.
   */
  anchor(): Promise<number>;
  backlog: BacklogPage;
  onError(err: unknown): void;
}

/**
 * Per-subscriber delivery for `GET /tasks/:id/stream` (design.md §12.6).
 *
 * H3: the stream is registered for live delivery before its backlog (or
 * anchor) query runs. While that query is in flight, live events are
 * buffered; once it is done the buffer is flushed in id order. Every send
 * drops an event whose id is at or below the last id sent, so the seam
 * between backlog and live delivery has neither gaps nor duplicates.
 *
 * H4: `resync()` re-runs the backlog query after the last sent id.
 *
 * Backlog rows wait for the client to drain before the next is written,
 * so a large backlog is never buffered in memory ahead of a slow client.
 */
export class TaskStream {
  private lastSentId: number | undefined;
  private syncing = false;
  private resyncRequested = false;
  private buffer: StreamEvent[] = [];
  /** Bytes of buffered events, except one oversized event, which is exempt. */
  private bufferedBytes = 0;
  private bufferHasOversized = false;

  constructor(private readonly options: TaskStreamOptions) {
    this.lastSentId = options.cursor;
  }

  /** Call after the stream is registered with the hub. */
  start(): void {
    void this.sync();
  }

  /**
   * Live events buffered during a sync count toward the connection's
   * output cap. Past it the connection is dropped and the client resumes
   * with Last-Event-ID, so a client stalled in its backlog cannot grow
   * the buffer without bound. One event larger than the cap is still
   * buffered, with its bytes left out of the cap, when no other oversized
   * event is buffered or in flight: a cursor-less stream that has sent
   * nothing would otherwise reconnect without Last-Event-ID and re-anchor
   * past it.
   */
  push(event: StreamEvent): void {
    const { sse } = this.options;
    if (sse.isClosed) return;
    if (this.syncing) {
      const bytes = Buffer.byteLength(event.frame);
      const exempt =
        sse.isOversized(bytes) && !this.bufferHasOversized && !sse.hasOversizedInFlight;
      const counted = exempt ? 0 : bytes;
      if (sse.exceedsCap(this.bufferedBytes + counted)) {
        this.clearBuffer();
        sse.drop();
        return;
      }
      this.buffer.push(event);
      this.bufferedBytes += counted;
      if (exempt) this.bufferHasOversized = true;
      return;
    }
    this.send(event);
  }

  resync(): void {
    if (this.options.sse.isClosed) return;
    if (this.syncing) {
      this.resyncRequested = true;
      return;
    }
    void this.sync();
  }

  /** Returns false when the client has not drained what was written. */
  private send(event: StreamEvent): boolean {
    if (this.lastSentId !== undefined && event.id <= this.lastSentId) return true;
    this.lastSentId = event.id;
    return this.options.sse.write(event.frame);
  }

  private async sync(): Promise<void> {
    const { sse } = this.options;
    this.syncing = true;
    try {
      let runBacklog = true;
      if (this.lastSentId === undefined) {
        this.lastSentId = await this.options.anchor();
        runBacklog = this.resyncRequested;
      }
      while (runBacklog && !sse.isClosed) {
        this.resyncRequested = false;
        let full = true;
        while (full && !sse.isClosed) {
          const page = await this.options.backlog(this.lastSentId);
          for (const event of page.events) {
            if (sse.isClosed) break;
            if (!this.send(event)) await sse.waitForDrain();
          }
          full = page.full;
        }
        runBacklog = this.resyncRequested;
      }

      const buffered = this.buffer.sort((a, b) => a.id - b.id);
      this.clearBuffer();
      for (const event of buffered) this.send(event);
    } catch (err) {
      // The client reconnects with Last-Event-ID and resumes from there.
      this.clearBuffer();
      this.options.onError(err);
      sse.end();
    } finally {
      this.syncing = false;
    }
  }

  private clearBuffer(): void {
    this.buffer = [];
    this.bufferedBytes = 0;
    this.bufferHasOversized = false;
  }
}
