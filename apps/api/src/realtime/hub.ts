import type { ServerResponse } from "node:http";
import type { ExecutionEventType } from "@orchestra/core";
import {
  TIMELINE_LIMIT_MAX,
  listTimeline,
  type Db,
  type ExecutionEventRow,
  type NotifyPayload,
} from "@orchestra/db";
import type { FastifyBaseLogger } from "fastify";
import { SseConnection, toStreamEvent, type StreamEvent } from "./sse.js";
import { TaskStream } from "./task-stream.js";

/** Q7: the only event types `GET /stream` forwards. */
export const GLOBAL_STREAM_TYPES: ReadonlySet<ExecutionEventType> = new Set([
  "task.state_changed",
  "issue.created",
  "issue.resolved",
]);

/** Loads the one row a `NOTIFY` names, or null if it is not visible. */
export type LoadEvent = (
  db: Db,
  taskId: string,
  eventId: number,
) => Promise<ExecutionEventRow | null>;

/** One backlog page: the task's rows with `id > after`, ascending, at most `TIMELINE_LIMIT_MAX`. */
export type ListBacklog = (
  db: Db,
  taskId: string,
  after: number,
) => Promise<ExecutionEventRow[]>;

export const defaultLoadEvent: LoadEvent = async (db, taskId, eventId) => {
  const [row] = await listTimeline(db, taskId, {
    after: BigInt(eventId - 1),
    limit: 1,
  });
  return row !== undefined && Number(row.id) === eventId ? row : null;
};

export const defaultListBacklog: ListBacklog = (db, taskId, after) =>
  listTimeline(db, taskId, { after: BigInt(after), limit: TIMELINE_LIMIT_MAX });

export interface RealtimeHubOptions {
  db: Db;
  log: FastifyBaseLogger;
  keepaliveMs: number;
  loadEvent: LoadEvent;
  listBacklog: ListBacklog;
}

/**
 * Fans committed `execution_events` rows out to SSE subscribers (design.md
 * §12.6). The LISTEN connection feeds `handleNotify` and `handleListen`.
 *
 * H2: each notification loads its row once, then every matching subscriber
 * gets the same pre-rendered frame. Loads run concurrently but deliveries
 * are chained, so subscribers see events in notification (commit) order.
 */
export class RealtimeHub {
  private readonly taskStreams = new Map<string, Set<TaskStream>>();
  private readonly globalStreams = new Set<SseConnection>();
  private readonly connections = new Set<SseConnection>();
  private delivery: Promise<void> = Promise.resolve();
  /** Highest event id seen on the channel; anchors cursor-less task streams. */
  private highWater = 0;

  constructor(private readonly options: RealtimeHubOptions) {}

  handleNotify(payload: NotifyPayload): void {
    if (payload.event_id > this.highWater) this.highWater = payload.event_id;
    if (!this.taskStreams.has(payload.task_id) && this.globalStreams.size === 0) {
      return;
    }
    const load = this.options
      .loadEvent(this.options.db, payload.task_id, payload.event_id)
      .catch((err: unknown) => {
        this.options.log.error({ err, payload }, "realtime: event load failed");
        return null;
      });
    this.delivery = this.delivery
      .then(async () => {
        const row = await load;
        if (row) this.deliver(toStreamEvent(row));
      })
      .catch((err: unknown) => {
        this.options.log.error({ err, payload }, "realtime: event delivery failed");
      });
  }

  /** H4: LISTEN is (re)established; every task stream re-reads what it may have missed. */
  handleListen(): void {
    for (const streams of this.taskStreams.values()) {
      for (const stream of streams) stream.resync();
    }
  }

  openTaskStream(res: ServerResponse, taskId: string, cursor: number | undefined): void {
    const sse = this.track(res);
    const stream = new TaskStream({
      sse,
      cursor,
      anchor: this.highWater > 0 ? this.highWater : undefined,
      backlog: async (after) => {
        const rows = await this.options.listBacklog(this.options.db, taskId, after);
        return {
          events: rows.map(toStreamEvent),
          full: rows.length >= TIMELINE_LIMIT_MAX,
        };
      },
      onError: (err) =>
        this.options.log.error({ err, taskId }, "realtime: backlog query failed"),
    });

    let streams = this.taskStreams.get(taskId);
    if (!streams) {
      streams = new Set();
      this.taskStreams.set(taskId, streams);
    }
    streams.add(stream);
    sse.onClose(() => {
      const current = this.taskStreams.get(taskId);
      current?.delete(stream);
      if (current?.size === 0) this.taskStreams.delete(taskId);
    });

    stream.start();
  }

  /** Q8: no replay; only live `GLOBAL_STREAM_TYPES` events. */
  openGlobalStream(res: ServerResponse): void {
    const sse = this.track(res);
    this.globalStreams.add(sse);
    sse.onClose(() => this.globalStreams.delete(sse));
  }

  /** H8: ends every open stream. */
  closeAll(): void {
    for (const sse of [...this.connections]) sse.end();
  }

  subscriberCount(): { task: number; global: number } {
    let task = 0;
    for (const streams of this.taskStreams.values()) task += streams.size;
    return { task, global: this.globalStreams.size };
  }

  private track(res: ServerResponse): SseConnection {
    const sse = new SseConnection(res, this.options.keepaliveMs);
    this.connections.add(sse);
    sse.onClose(() => this.connections.delete(sse));
    return sse;
  }

  private deliver(event: StreamEvent): void {
    const streams = this.taskStreams.get(event.taskId);
    if (streams) {
      for (const stream of streams) stream.push(event);
    }
    if (GLOBAL_STREAM_TYPES.has(event.type as ExecutionEventType)) {
      for (const sse of this.globalStreams) sse.write(event.frame);
    }
  }
}
