import type { ServerResponse } from "node:http";
import type { ExecutionEventRow } from "@orchestra/db";

/** H7: default interval for the `: keepalive` comment. */
export const DEFAULT_KEEPALIVE_MS = 25_000;

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

/**
 * One open SSE response. Writes the headers immediately, sends a keepalive
 * comment on an interval, and runs `onClose` callbacks exactly once when
 * the client disconnects or the server ends the stream.
 */
export class SseConnection {
  private closed = false;
  private readonly keepalive: NodeJS.Timeout;
  private readonly closeCallbacks: Array<() => void> = [];

  constructor(
    private readonly res: ServerResponse,
    keepaliveMs: number,
  ) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    this.keepalive = setInterval(() => this.write(": keepalive\n\n"), keepaliveMs);
    res.on("close", () => this.handleClose());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  write(chunk: string): void {
    if (this.closed) return;
    this.res.write(chunk);
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback);
  }

  /** Ends the response from the server side. */
  end(): void {
    if (this.closed) return;
    this.res.end();
    this.handleClose();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepalive);
    for (const callback of this.closeCallbacks) callback();
  }
}
