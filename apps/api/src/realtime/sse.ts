import type { ServerResponse } from "node:http";
import type { ExecutionEventRow } from "@orchestra/db";

/** H7: default interval for the `: keepalive` comment. */
export const DEFAULT_KEEPALIVE_MS = 25_000;

/**
 * Default cap on output a client has not yet taken. Past it the connection
 * is dropped and the client resumes with `Last-Event-ID`.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** One `execution_events` row, pre-rendered once and shared by every subscriber. */
export interface StreamEvent {
  id: number;
  taskId: string;
  type: string;
  frame: string;
}

/**
 * Renders one row as an SSE frame (design.md §12.6): `id`, `event: <type>`,
 * and `data` holding the row in the exact shape `GET /tasks/:id/timeline`
 * returns (the drizzle row with `id` as a number). `JSON.stringify`
 * escapes newlines, so the payload always fits on one `data:` line.
 */
export function toStreamEvent(row: ExecutionEventRow): StreamEvent {
  const id = Number(row.id);
  const data = JSON.stringify({ ...row, id });
  return {
    id,
    taskId: row.taskId,
    type: row.type,
    frame: `id: ${id}\nevent: ${row.type}\ndata: ${data}\n\n`,
  };
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
} as const;

/**
 * Answers a stream request that arrives while the api is shutting down:
 * headers, then an immediate end. `connection: close` releases the socket
 * so `app.close()` is not held open, and the client reconnects elsewhere.
 */
export function endStreamImmediately(res: ServerResponse): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(200, { ...SSE_HEADERS, connection: "close" });
  res.end();
}

/**
 * One open SSE response. Writes the headers immediately, sends a keepalive
 * comment on an interval, and runs `onClose` callbacks exactly once when
 * the client disconnects or the server ends the stream. A response whose
 * client is already gone starts closed, so nothing is registered for it.
 *
 * Output the client has not taken is capped at `maxBufferedBytes`; past
 * it the connection is destroyed and the client resumes with
 * `Last-Event-ID`. `write` reports backpressure and `waitForDrain`
 * resolves once the client catches up (or the connection closes).
 */
export class SseConnection {
  private closed = false;
  private needDrain = false;
  private readonly keepalive: NodeJS.Timeout | undefined;
  private readonly closeCallbacks: Array<() => void> = [];
  private readonly drainWaiters = new Set<() => void>();

  constructor(
    private readonly res: ServerResponse,
    keepaliveMs: number,
    private readonly maxBufferedBytes: number = DEFAULT_MAX_BUFFERED_BYTES,
  ) {
    if (res.destroyed || res.writableEnded) {
      this.closed = true;
      return;
    }
    res.writeHead(200, { ...SSE_HEADERS, connection: "keep-alive" });
    res.flushHeaders();
    this.keepalive = setInterval(() => this.write(": keepalive\n\n"), keepaliveMs);
    res.on("close", () => this.handleClose());
    res.on("drain", () => {
      this.needDrain = false;
      this.releaseDrainWaiters();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Returns false when the caller should `waitForDrain` before writing more. */
  write(chunk: string): boolean {
    if (this.closed) return false;
    if (!this.res.write(chunk)) this.needDrain = true;
    if (this.res.writableLength > this.maxBufferedBytes) {
      this.res.destroy();
      this.handleClose();
      return false;
    }
    return !this.needDrain;
  }

  waitForDrain(): Promise<void> {
    if (this.closed || !this.needDrain) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.add(resolve));
  }

  /** Runs `callback` on close, or at once if the connection is already closed. */
  onClose(callback: () => void): void {
    if (this.closed) {
      callback();
      return;
    }
    this.closeCallbacks.push(callback);
  }

  /** Ends the response from the server side. */
  end(): void {
    if (this.closed) return;
    this.res.end();
    this.handleClose();
  }

  private releaseDrainWaiters(): void {
    const waiters = [...this.drainWaiters];
    this.drainWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepalive);
    this.releaseDrainWaiters();
    for (const callback of this.closeCallbacks) callback();
  }
}
