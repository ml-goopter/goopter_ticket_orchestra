import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import http, { type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExecutionEventType } from "@orchestra/core";
import { LISTEN_APPLICATION_NAME, appendEvent } from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  defaultListBacklog,
  defaultLoadAnchor,
  defaultLoadEvent,
  type RealtimeOptions,
} from "../src/realtime/index.js";
import { SseConnection, type StreamEvent } from "../src/realtime/sse.js";
import { TaskStream } from "../src/realtime/task-stream.js";
import {
  type Clock,
  type Fixtures,
  type TestDb,
  createClock,
  seedFixtures,
  seedSession,
  seedTask,
  sessionCookieHeader,
  startTestDb,
  testConfig,
} from "./harness.js";

const KEEPALIVE_MS = 150;

let h: TestDb;
let app: FastifyInstance;
let appClosed = false;
let fx: Fixtures;
let clock: Clock;
let cookie: string;
let baseUrl: string;

/** Every `loadEvent` call the live path made, as `event_id`s. */
const loads: number[] = [];
/** Every backlog page query, as `{ taskId, after }`. */
const backlogCalls: Array<{ taskId: string; after: number }> = [];
/** Per-task hooks run around one backlog query (T3 races). */
const backlogHooks = new Map<
  string,
  { before?: () => Promise<void>; after?: () => Promise<void> }
>();
/** Per-task hooks run after a cursor-less stream's anchor query resolves. */
const anchorHooks = new Map<string, () => Promise<void> | void>();
/** Tasks whose next live `loadEvent` call fails once. */
const failNextLoad = new Set<string>();

/** Wraps `defaultLoadAnchor` so a test can act right after the anchor is read. */
const loadAnchorWithHooks: NonNullable<RealtimeOptions["loadAnchor"]> = async (
  db,
  taskId,
) => {
  const anchor = await defaultLoadAnchor(db, taskId);
  const hook = anchorHooks.get(taskId);
  anchorHooks.delete(taskId);
  await hook?.();
  return anchor;
};

beforeAll(async () => {
  h = await startTestDb();
  clock = createClock(new Date("2026-01-01T00:00:00Z"));
  fx = await seedFixtures(h.db, "STR");
  const sessionId = await seedSession(h.db, {
    userId: fx.userId,
    expiresAt: new Date(clock.now().getTime() + 1000 * 60 * 60),
  });
  cookie = sessionCookieHeader(sessionId);

  app = await buildApp({
    db: h.db,
    config: testConfig({ DATABASE_URL: h.connectionString }),
    now: clock.now,
    realtime: {
      keepaliveMs: KEEPALIVE_MS,
      loadEvent: async (db, taskId, eventId) => {
        loads.push(eventId);
        if (failNextLoad.delete(taskId)) throw new Error("injected load failure");
        return defaultLoadEvent(db, taskId, eventId);
      },
      listBacklog: async (db, taskId, after) => {
        backlogCalls.push({ taskId, after });
        const hook = backlogHooks.get(taskId);
        backlogHooks.delete(taskId);
        await hook?.before?.();
        const rows = await defaultListBacklog(db, taskId, after);
        await hook?.after?.();
        return rows;
      },
      loadAnchor: loadAnchorWithHooks,
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
}, 180000);

afterAll(async () => {
  if (!appClosed) await app?.close();
  await h?.stop();
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(20);
  }
}

interface Frame {
  id: string | undefined;
  event: string | undefined;
  data: string | undefined;
}

interface StreamClient {
  status: number;
  contentType: string | undefined;
  frames: Frame[];
  comments: string[];
  ended: boolean;
  /** Waits until at least `n` event frames have arrived. */
  waitForFrames(n: number, timeoutMs?: number): Promise<Frame[]>;
  /** Starts reading a stream opened with `paused: true`. */
  resume(): void;
  close(): void;
}

interface OpenStreamOptions {
  /** Server to connect to; defaults to the shared app. */
  baseUrl?: string;
  /** Do not read the body until `resume()`, simulating a stalled client. */
  paused?: boolean;
}

/**
 * Minimal SSE client over `node:http`, so the test can read frames as they
 * arrive and drop the socket to simulate a client disconnect.
 */
function openStream(
  path: string,
  headers: Record<string, string> = {},
  options: OpenStreamOptions = {},
): Promise<StreamClient> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${options.baseUrl ?? baseUrl}${path}`,
      { headers: { cookie, ...headers } },
      (res) => {
        const client: StreamClient = {
          status: res.statusCode ?? 0,
          contentType: res.headers["content-type"],
          frames: [],
          comments: [],
          ended: false,
          async waitForFrames(n, timeoutMs) {
            await waitFor(() => client.frames.length >= n, timeoutMs);
            return client.frames;
          },
          resume() {
            res.resume();
          },
          close() {
            req.destroy();
          },
        };
        let buffer = "";
        if (options.paused) res.pause();
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let split = buffer.indexOf("\n\n");
          while (split !== -1) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const frame: Frame = { id: undefined, event: undefined, data: undefined };
            let isEvent = false;
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) {
                client.comments.push(line.slice(1).trim());
                continue;
              }
              const colon = line.indexOf(":");
              const field = line.slice(0, colon);
              const value = line.slice(colon + 1).replace(/^ /, "");
              if (field === "id" || field === "event" || field === "data") {
                frame[field] = value;
                isEvent = true;
              }
            }
            if (isEvent) client.frames.push(frame);
            split = buffer.indexOf("\n\n");
          }
        });
        res.on("end", () => {
          client.ended = true;
        });
        res.on("close", () => {
          client.ended = true;
        });
        resolve(client);
      },
    );
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
    });
  });
}

/** Appends one event in its own committed transaction; returns its id. */
async function append(
  taskId: string,
  type: ExecutionEventType,
  payload: unknown = {},
): Promise<number> {
  const { id } = await h.db.transaction((tx) =>
    appendEvent(tx, { taskId, type, payload }),
  );
  return Number(id);
}

let keySeq = 0;
function newTask(): Promise<string> {
  keySeq += 1;
  return seedTask(h.db, fx, {
    jiraKey: `STR-${keySeq}`,
    state: "IMPLEMENTING",
  });
}

function ids(frames: Frame[]): number[] {
  return frames.map((frame) => Number(frame.id));
}

async function terminateListenConnection(): Promise<void> {
  const rows = await h.sql`
    select pg_terminate_backend(pid) from pg_stat_activity
    where application_name = ${LISTEN_APPLICATION_NAME}
  `;
  expect(rows).toHaveLength(1);
}

async function listenPids(): Promise<number[]> {
  const rows = await h.sql<{ pid: number }[]>`
    select pid from pg_stat_activity
    where application_name = ${LISTEN_APPLICATION_NAME}
  `;
  return rows.map((row) => row.pid);
}

interface FreshApp {
  app: FastifyInstance;
  baseUrl: string;
  /** Backend pid of this app's own LISTEN connection. */
  listenPid: number;
}

/**
 * A second app on the shared database with a hub that has seen no
 * notification yet, so no earlier test's traffic shapes its state.
 */
async function startFreshApp(): Promise<FreshApp> {
  const before = new Set(await listenPids());
  const fresh = await buildApp({
    db: h.db,
    config: testConfig({ DATABASE_URL: h.connectionString }),
    now: clock.now,
    realtime: { keepaliveMs: KEEPALIVE_MS, loadAnchor: loadAnchorWithHooks },
  });
  await fresh.listen({ port: 0, host: "127.0.0.1" });
  const { port } = fresh.server.address() as AddressInfo;
  const added = (await listenPids()).filter((pid) => !before.has(pid));
  expect(added).toHaveLength(1);
  return { app: fresh, baseUrl: `http://127.0.0.1:${port}`, listenPid: added[0]! };
}

/**
 * Resolves once a cursor-less stream on `taskId` has read its anchor, or
 * after `fallbackMs` if no anchor query ever runs, so a missing anchor
 * shows up as a wrong result rather than a hang.
 */
function anchored(taskId: string, fallbackMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    anchorHooks.set(taskId, () => resolve());
    setTimeout(resolve, fallbackMs);
  });
}

describe("GET /api/tasks/:id/stream", () => {
  it("T1/H5: delivers only this task's events, in id order, framed like a timeline row", async () => {
    const taskA = await newTask();
    const taskB = await newTask();
    const client = await openStream(`/api/tasks/${taskA}/stream`);
    try {
      expect(client.status).toBe(200);
      expect(client.contentType).toMatch(/^text\/event-stream/);

      const a1 = await append(taskA, "task.state_changed", { to: "X" });
      await append(taskB, "agent.message", { text: "other task" });
      const a2 = await append(taskA, "agent.message", { text: "hello\nworld" });
      const a3 = await append(taskA, "issue.created", { issueId: "i1" });

      const frames = await client.waitForFrames(3);
      await sleep(200);
      expect(ids(client.frames)).toEqual([a1, a2, a3]);
      expect(frames.map((f) => f.event)).toEqual([
        "task.state_changed",
        "agent.message",
        "issue.created",
      ]);

      const timeline = await app.inject({
        method: "GET",
        url: `/api/tasks/${taskA}/timeline`,
        headers: { cookie },
      });
      const { events } = timeline.json() as { events: unknown[] };
      expect(frames.map((f) => JSON.parse(f.data!) as unknown)).toEqual(events);
    } finally {
      client.close();
    }
  });

  it("T2: never delivers an event from a rolled-back transaction", async () => {
    const task = await newTask();
    const client = await openStream(`/api/tasks/${task}/stream`);
    try {
      let rolledBackId = 0;
      await expect(
        h.db.transaction(async (tx) => {
          const { id } = await appendEvent(tx, {
            taskId: task,
            type: "task.state_changed",
            payload: {},
          });
          rolledBackId = Number(id);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      const committed = await append(task, "task.state_changed");

      await client.waitForFrames(1);
      await sleep(200);
      expect(rolledBackId).toBeGreaterThan(0);
      expect(ids(client.frames)).toEqual([committed]);
    } finally {
      client.close();
    }
  });

  for (const via of ["Last-Event-ID", "?after="] as const) {
    it(`T3: reconnect with ${via} delivers every later event exactly once, across the backlog/live seam`, async () => {
      const task = await newTask();
      const e1 = await append(task, "agent.message", { n: 1 });
      const e2 = await append(task, "agent.message", { n: 2 });
      const e3 = await append(task, "agent.message", { n: 3 });

      let beforeQuery = 0;
      let afterQuery = 0;
      backlogHooks.set(task, {
        // Committed after the live subscription but before the backlog
        // query: arrives through both paths and must be sent once.
        before: async () => {
          beforeQuery = await append(task, "agent.message", { n: 4 });
        },
        // Committed after the backlog query read: only live delivery has it.
        after: async () => {
          afterQuery = await append(task, "agent.message", { n: 5 });
        },
      });

      const client =
        via === "Last-Event-ID"
          ? await openStream(`/api/tasks/${task}/stream`, {
              "last-event-id": String(e1),
            })
          : await openStream(`/api/tasks/${task}/stream?after=${e1}`);
      try {
        await client.waitForFrames(4);
        const e6 = await append(task, "agent.message", { n: 6 });
        await client.waitForFrames(5);
        await sleep(200);
        expect(ids(client.frames)).toEqual([e2, e3, beforeQuery, afterQuery, e6]);
      } finally {
        client.close();
      }
    });
  }

  it("T3: Last-Event-ID takes precedence over ?after=", async () => {
    const task = await newTask();
    const e1 = await append(task, "agent.message");
    const e2 = await append(task, "agent.message");
    const e3 = await append(task, "agent.message");
    const client = await openStream(`/api/tasks/${task}/stream?after=${e1}`, {
      "last-event-id": String(e2),
    });
    try {
      await client.waitForFrames(1);
      await sleep(200);
      expect(ids(client.frames)).toEqual([e3]);
    } finally {
      client.close();
    }
  });

  it("T3: rejects a non-integer cursor with 400", async () => {
    const task = await newTask();
    const byQuery = await app.inject({
      method: "GET",
      url: `/api/tasks/${task}/stream?after=abc`,
      headers: { cookie },
    });
    expect(byQuery.statusCode).toBe(400);
    const byHeader = await app.inject({
      method: "GET",
      url: `/api/tasks/${task}/stream`,
      headers: { cookie, "last-event-id": "-1" },
    });
    expect(byHeader.statusCode).toBe(400);
  });

  it("T5: one notification loads the row once for three subscribers", async () => {
    const task = await newTask();
    const clients = await Promise.all([
      openStream(`/api/tasks/${task}/stream`),
      openStream(`/api/tasks/${task}/stream`),
      openStream(`/api/tasks/${task}/stream`),
    ]);
    try {
      const id = await append(task, "agent.message");
      for (const client of clients) {
        await client.waitForFrames(1);
        expect(ids(client.frames)).toEqual([id]);
      }
      expect(loads.filter((loaded) => loaded === id)).toHaveLength(1);
    } finally {
      for (const client of clients) client.close();
    }
  });

  it("T6: events committed while LISTEN is down reach an open stream after reconnect", async () => {
    const task = await newTask();
    const client = await openStream(`/api/tasks/${task}/stream`);
    try {
      const e1 = await append(task, "agent.message");
      await client.waitForFrames(1);

      const resyncsBefore = backlogCalls.filter((c) => c.taskId === task).length;
      // Insert, then kill the listen backend, then commit: the NOTIFY fires
      // while no LISTEN connection exists, so only the resync can deliver it.
      const { id } = await h.db.transaction(async (tx) => {
        const row = await appendEvent(tx, {
          taskId: task,
          type: "agent.message",
          payload: {},
        });
        await terminateListenConnection();
        return row;
      });
      const e2 = Number(id);

      await client.waitForFrames(2);
      expect(loads).not.toContain(e2);
      expect(
        backlogCalls.filter((c) => c.taskId === task).slice(resyncsBefore),
      ).toEqual([{ taskId: task, after: e1 }]);

      const e3 = await append(task, "agent.message");
      await client.waitForFrames(3);
      await sleep(200);
      expect(ids(client.frames)).toEqual([e1, e2, e3]);
    } finally {
      client.close();
    }
  });

  it("T6: a stream opened without a cursor that has sent nothing still recovers", async () => {
    const task = await newTask();
    const client = await openStream(`/api/tasks/${task}/stream`);
    try {
      const { id } = await h.db.transaction(async (tx) => {
        const row = await appendEvent(tx, {
          taskId: task,
          type: "agent.message",
          payload: {},
        });
        await terminateListenConnection();
        return row;
      });
      await client.waitForFrames(1);
      await sleep(200);
      expect(ids(client.frames)).toEqual([Number(id)]);
      expect(loads).not.toContain(Number(id));
    } finally {
      client.close();
    }
  });

  it("F1: a cursor-less stream keeps its task's event that commits after a higher id from another task", async () => {
    const taskA = await newTask();
    const taskB = await newTask();
    const clientB = await openStream(`/api/tasks/${taskB}/stream`);
    let clientA: StreamClient | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    try {
      let inserted!: (id: number) => void;
      const insertedId = new Promise<number>((resolve) => (inserted = resolve));
      const pendingA = h.db.transaction(async (tx) => {
        const { id } = await appendEvent(tx, {
          taskId: taskA,
          type: "agent.message",
          payload: { n: 1 },
        });
        inserted(Number(id));
        await gate;
      });
      const a1 = await insertedId;

      // b1 gets a higher id than a1 but commits first, and the hub sees it.
      const b1 = await append(taskB, "agent.message");
      expect(b1).toBeGreaterThan(a1);
      await clientB.waitForFrames(1);

      const anchorRead = anchored(taskA);
      clientA = await openStream(`/api/tasks/${taskA}/stream`);
      await anchorRead;

      release();
      await pendingA;
      const a2 = await append(taskA, "agent.message", { n: 2 });
      await waitFor(() => ids(clientA!.frames).includes(a2));
      await sleep(200);
      expect(ids(clientA.frames)).toEqual([a1, a2]);
    } finally {
      release();
      clientA?.close();
      clientB.close();
    }
  });

  it("F1: a cursor-less stream delivers an event committed right after its anchor is read", async () => {
    const task = await newTask();
    await append(task, "agent.message", { n: 0 });
    let afterAnchor = 0;
    anchorHooks.set(task, async () => {
      afterAnchor = await append(task, "agent.message", { n: 1 });
    });
    const client = await openStream(`/api/tasks/${task}/stream`);
    try {
      await client.waitForFrames(1);
      await sleep(200);
      expect(afterAnchor).toBeGreaterThan(0);
      expect(ids(client.frames)).toEqual([afterAnchor]);
    } finally {
      client.close();
    }
  });

  it("F2/T6: on a freshly built app, a cursor-less stream that has sent nothing recovers events committed while LISTEN is down", async () => {
    const fresh = await startFreshApp();
    let client: StreamClient | undefined;
    try {
      const task = await newTask();
      const anchorRead = anchored(task);
      client = await openStream(`/api/tasks/${task}/stream`, {}, { baseUrl: fresh.baseUrl });
      expect(client.status).toBe(200);
      await anchorRead;

      const { id } = await h.db.transaction(async (tx) => {
        const row = await appendEvent(tx, {
          taskId: task,
          type: "agent.message",
          payload: {},
        });
        await h.sql`select pg_terminate_backend(${fresh.listenPid})`;
        return row;
      });

      await client.waitForFrames(1);
      await sleep(200);
      expect(ids(client.frames)).toEqual([Number(id)]);
    } finally {
      client?.close();
      await fresh.app.close();
    }
  });

  it("F5: a backlog waits for the client to drain before writing more", async () => {
    const task = await newTask();
    // Two backlog pages of ~10 KB rows: far more than socket buffers hold.
    await h.sql`
      insert into execution_events (task_id, type, payload)
      select ${task}, 'agent.message',
             jsonb_build_object('n', g, 'text', repeat('x', 10000))
      from generate_series(1, 1001) as g
    `;
    const client = await openStream(
      `/api/tasks/${task}/stream`,
      { "last-event-id": "0" },
      { paused: true },
    );
    try {
      const calls = () => backlogCalls.filter((c) => c.taskId === task);
      await waitFor(() => calls().length >= 1);
      await sleep(500);
      expect(calls()).toHaveLength(1);

      client.resume();
      await client.waitForFrames(1001, 60000);
      expect(calls()).toHaveLength(2);
      const got = ids(client.frames);
      expect(new Set(got).size).toBe(1001);
      expect([...got].sort((a, b) => a - b)).toEqual(got);
    } finally {
      client.close();
    }
  });

  it("R2: an event whose live load fails still reaches the stream, before the next event", async () => {
    const task = await newTask();
    const anchorRead = anchored(task);
    const client = await openStream(`/api/tasks/${task}/stream`);
    try {
      await anchorRead;
      failNextLoad.add(task);
      const e1 = await append(task, "agent.message", { n: 1 });
      const e2 = await append(task, "agent.message", { n: 2 });
      await client.waitForFrames(2);
      await sleep(200);
      expect(failNextLoad.has(task)).toBe(false);
      expect(ids(client.frames)).toEqual([e1, e2]);
    } finally {
      failNextLoad.delete(task);
      client.close();
    }
  });

  it("H7: sends a keepalive comment on the configured interval", async () => {
    const task = await newTask();
    const client = await openStream(`/api/tasks/${task}/stream`);
    try {
      await waitFor(
        () => client.comments.filter((c) => c === "keepalive").length >= 2,
      );
    } finally {
      client.close();
    }
  });
});

describe("GET /api/stream", () => {
  it("T4/Q8: sends only state/issue events from every task, with no replay", async () => {
    const taskA = await newTask();
    const taskB = await newTask();
    await append(taskA, "task.state_changed");

    const client = await openStream(`/api/stream`, { "last-event-id": "0" });
    try {
      await append(taskA, "agent.message");
      const s1 = await append(taskA, "task.state_changed");
      const i1 = await append(taskB, "issue.created");
      await append(taskB, "execution.started");
      await append(taskB, "issue.message");
      const i2 = await append(taskB, "issue.resolved");
      const s2 = await append(taskB, "task.state_changed");

      await client.waitForFrames(4);
      await sleep(200);
      expect(ids(client.frames)).toEqual([s1, i1, i2, s2]);
      expect(client.frames.map((f) => f.event)).toEqual([
        "task.state_changed",
        "issue.created",
        "issue.resolved",
        "task.state_changed",
      ]);
      const data = client.frames.map(
        (f) => JSON.parse(f.data!) as { taskId: string },
      );
      expect(data.map((d) => d.taskId)).toEqual([taskA, taskB, taskB, taskB]);
    } finally {
      client.close();
    }
  });
});

describe("auth, validation and cleanup (T7)", () => {
  it("returns 401 without a session on both routes", async () => {
    const task = await newTask();
    for (const url of [`/api/tasks/${task}/stream`, `/api/stream`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
  });

  it("returns 404 for an unknown task and 400 for a non-UUID id", async () => {
    const missing = await app.inject({
      method: "GET",
      url: `/api/tasks/${randomUUID()}/stream`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

    const invalid = await app.inject({
      method: "GET",
      url: `/api/tasks/not-a-uuid/stream`,
      headers: { cookie },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("removes a subscriber when its client disconnects", async () => {
    await waitFor(() => {
      const counts = app.realtime.subscriberCount();
      return counts.task === 0 && counts.global === 0;
    });
    const task = await newTask();
    const taskClient = await openStream(`/api/tasks/${task}/stream`);
    const globalClient = await openStream(`/api/stream`);
    expect(app.realtime.subscriberCount()).toEqual({ task: 1, global: 1 });

    taskClient.close();
    globalClient.close();
    await waitFor(() => {
      const counts = app.realtime.subscriberCount();
      return counts.task === 0 && counts.global === 0;
    });
  });

  it("F3: a client that disconnected before the stream opened leaves no subscriber", async () => {
    await waitFor(() => {
      const counts = app.realtime.subscriberCount();
      return counts.task === 0 && counts.global === 0;
    });
    const task = await newTask();
    // Stand-in for a route that is still awaiting auth or the task lookup
    // when the client goes away: the stream opens after `close` fired.
    const counts: Array<{ task: number; global: number }> = [];
    let received = (): void => {};
    let opened = (): void => {};
    const server = http.createServer((req, res) => {
      res.on("close", () => {
        if (req.url === "/task") app.realtime.openTaskStream(res, task, undefined);
        else app.realtime.openGlobalStream(res);
        counts.push(app.realtime.subscriberCount());
        opened();
      });
      received();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      for (const path of ["/task", "/global"]) {
        const gotRequest = new Promise<void>((resolve) => (received = resolve));
        const done = new Promise<void>((resolve) => (opened = resolve));
        const req = http.get(`http://127.0.0.1:${port}${path}`);
        req.on("error", () => {});
        await gotRequest;
        req.destroy();
        await done;
      }
      expect(counts).toEqual([
        { task: 0, global: 0 },
        { task: 0, global: 0 },
      ]);
      await sleep(KEEPALIVE_MS * 2);
      expect(app.realtime.subscriberCount()).toEqual({ task: 0, global: 0 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("F5: ends a connection whose unsent output exceeds the cap", () => {
    const res = new FakeResponse();
    let closes = 0;
    const sse = new SseConnection(res.asServerResponse(), 60_000, 100);
    sse.onClose(() => {
      closes += 1;
    });
    try {
      sse.write("x".repeat(60));
      expect(sse.isClosed).toBe(false);
      sse.write("x".repeat(60));
      expect(sse.isClosed).toBe(true);
      expect(res.destroyed).toBe(true);
      expect(closes).toBe(1);
      sse.write("x".repeat(60));
      expect(res.written).toBe(120);
    } finally {
      sse.end();
    }
  });

  it("R3: delivers one frame larger than the cap on an otherwise idle connection", () => {
    const res = new FakeResponse();
    const sse = new SseConnection(res.asServerResponse(), 60_000, 100);
    try {
      sse.write("x".repeat(150));
      expect(sse.isClosed).toBe(false);
      expect(res.destroyed).toBe(false);
      expect(res.written).toBe(150);
    } finally {
      sse.end();
    }
  });

  it("R1: live events buffered behind a stalled backlog drop the connection past the cap", async () => {
    const res = new FakeResponse();
    const sse = new SseConnection(res.asServerResponse(), 60_000, 100);
    const event = (id: number): StreamEvent => ({
      id,
      taskId: "t",
      type: "agent.message",
      frame: `id: ${id}\ndata: ${"x".repeat(20)}\n\n`,
    });
    let errors = 0;
    const stream = new TaskStream({
      sse,
      cursor: 0,
      anchor: () => Promise.resolve(0),
      backlog: () => Promise.resolve({ events: [event(1)], full: false }),
      onError: () => {
        errors += 1;
      },
    });
    try {
      stream.start();
      // The backlog row fills the fake socket, so sync() waits for a drain
      // that never comes and every live event is buffered.
      await waitFor(() => res.written > 0);
      let pushes = 0;
      for (let id = 2; id <= 1000 && !sse.isClosed; id += 1) {
        stream.push(event(id));
        pushes += 1;
      }
      expect(sse.isClosed).toBe(true);
      expect(res.destroyed).toBe(true);
      expect(pushes).toBeLessThan(5);
      expect(errors).toBe(0);
    } finally {
      sse.end();
    }
  });

  it("F1: an oversized frame followed by a keepalive and a normal event is fully delivered", async () => {
    const res = new FakeResponse();
    const sse = new SseConnection(res.asServerResponse(), 20, 100);
    const big = fakeEvent(1, 150);
    const normal = fakeEvent(2, 20);
    try {
      expect(sse.write(big.frame)).toBe(false);
      await waitFor(() => res.chunks.includes(": keepalive\n\n"));
      expect(sse.isClosed).toBe(false);
      expect(sse.exceedsCap(normal.frame.length)).toBe(false);
      sse.write(normal.frame);
      expect(sse.isClosed).toBe(false);

      res.flush();
      await sse.waitForDrain();
      expect(sse.isClosed).toBe(false);
      expect(res.destroyed).toBe(false);
      expect(eventChunks(res)).toEqual([big.frame, normal.frame]);
    } finally {
      sse.end();
    }
  });

  it("F1: a live event buffered behind an in-flight oversized backlog frame does not drop the stream", async () => {
    const res = new FakeResponse();
    const sse = new SseConnection(res.asServerResponse(), 20, 100);
    const big = fakeEvent(1, 150);
    const normal = fakeEvent(2, 20);
    const stream = new TaskStream({
      sse,
      cursor: 0,
      anchor: () => Promise.resolve(0),
      backlog: () => Promise.resolve({ events: [big], full: false }),
      onError: () => {},
    });
    try {
      stream.start();
      await waitFor(() => res.chunks.includes(": keepalive\n\n"));
      stream.push(normal);
      expect(sse.isClosed).toBe(false);

      res.flush();
      await waitFor(() => eventChunks(res).length === 2 || sse.isClosed);
      expect(sse.isClosed).toBe(false);
      expect(res.destroyed).toBe(false);
      expect(eventChunks(res)).toEqual([big.frame, normal.frame]);
    } finally {
      sse.end();
    }
  });

  it("F1/Y2: normal frames queued behind an in-flight oversized frame still drop the connection past the cap", () => {
    const res = new FakeResponse();
    const sse = new SseConnection(res.asServerResponse(), 60_000, 100);
    try {
      sse.write("x".repeat(150));
      sse.write("x".repeat(60));
      expect(sse.isClosed).toBe(false);
      sse.write("x".repeat(60));
      expect(sse.isClosed).toBe(true);
      expect(res.destroyed).toBe(true);
    } finally {
      sse.end();
    }
  });

  it("F2: a cursor-less stream that has sent nothing delivers an oversized event received while anchoring", async () => {
    const res = new FakeResponse();
    const sse = new SseConnection(res.asServerResponse(), 60_000, 100);
    let resolveAnchor!: (id: number) => void;
    const anchor = new Promise<number>((resolve) => (resolveAnchor = resolve));
    const big = fakeEvent(5, 150);
    const stream = new TaskStream({
      sse,
      cursor: undefined,
      anchor: () => anchor,
      backlog: () => Promise.resolve({ events: [], full: false }),
      onError: () => {},
    });
    try {
      stream.start();
      stream.push(big);
      expect(sse.isClosed).toBe(false);

      resolveAnchor(4);
      await waitFor(() => eventChunks(res).length === 1 || sse.isClosed);
      expect(sse.isClosed).toBe(false);
      expect(res.destroyed).toBe(false);
      expect(eventChunks(res)).toEqual([big.frame]);
    } finally {
      sse.end();
    }
  });
});

/** A task event whose frame is exactly `size` bytes of ASCII. */
function fakeEvent(id: number, size: number): StreamEvent {
  const head = `id: ${id}\ndata: `;
  const pad = size - head.length - 2;
  return {
    id,
    taskId: "t",
    type: "agent.message",
    frame: `${head}${"x".repeat(pad)}\n\n`,
  };
}

/** Everything written to `res` except keepalive comments. */
function eventChunks(res: FakeResponse): string[] {
  return res.chunks.filter((chunk) => !chunk.startsWith(":"));
}

/**
 * A `ServerResponse` whose client never reads until `flush()`: every write
 * stays buffered in `writableLength`.
 */
class FakeResponse extends EventEmitter {
  writableLength = 0;
  written = 0;
  destroyed = false;
  writableEnded = false;
  readonly chunks: string[] = [];
  private readonly flushCallbacks: Array<() => void> = [];
  writeHead(): this {
    return this;
  }
  flushHeaders(): void {}
  write(chunk: string, callback?: () => void): boolean {
    this.writableLength += chunk.length;
    this.written += chunk.length;
    this.chunks.push(chunk);
    if (callback) this.flushCallbacks.push(callback);
    return this.writableLength < 16;
  }
  /** The client takes everything unsent: write callbacks run, then `drain`. */
  flush(): void {
    this.writableLength = 0;
    for (const callback of this.flushCallbacks.splice(0)) callback();
    this.emit("drain");
  }
  end(): this {
    this.writableEnded = true;
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

describe("shutdown (T8/H8)", () => {
  it("F4: a stream request still awaiting when close() starts ends at once and close() resolves", async () => {
    const fresh = await startFreshApp();
    const task = await newTask();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const tableLocked = new Promise<void>((resolve) => (locked = resolve));
    // Holds the route in its task lookup until close() has begun.
    const lockTx = h.sql.begin(async (sql) => {
      await sql`lock table tasks in access exclusive mode`;
      locked();
      await gate;
    });
    let client: StreamClient | undefined;
    let closing: Promise<void> | undefined;
    try {
      await tableLocked;
      const pending = openStream(`/api/tasks/${task}/stream`, {}, {
        baseUrl: fresh.baseUrl,
      });
      await waitFor(async () => {
        const rows = await h.sql`
          select 1 from pg_stat_activity where wait_event_type = 'Lock'
        `;
        return rows.length > 0;
      });

      closing = fresh.app.close();
      await waitFor(() => !fresh.app.server.listening);
      release();
      await lockTx;

      client = await pending;
      expect(client.status).toBe(200);
      await Promise.race([
        closing,
        sleep(5000).then(() => {
          throw new Error("app.close() did not resolve");
        }),
      ]);
      await waitFor(() => client!.ended);
      expect(fresh.app.realtime.subscriberCount()).toEqual({ task: 0, global: 0 });
    } finally {
      release();
      client?.close();
      await closing;
    }
  });

  it("app.close() resolves with streams open, ends them, and releases LISTEN", async () => {
    const task = await newTask();
    const taskClient = await openStream(`/api/tasks/${task}/stream`);
    const globalClient = await openStream(`/api/stream`);

    await Promise.race([
      app.close(),
      sleep(5000).then(() => {
        throw new Error("app.close() did not resolve");
      }),
    ]);
    appClosed = true;

    await waitFor(() => taskClient.ended && globalClient.ended);
    expect(app.realtime.subscriberCount()).toEqual({ task: 0, global: 0 });
    await waitFor(async () => {
      const rows = await h.sql`
        select pid from pg_stat_activity
        where application_name = ${LISTEN_APPLICATION_NAME}
      `;
      return rows.length === 0;
    });
  });
});
