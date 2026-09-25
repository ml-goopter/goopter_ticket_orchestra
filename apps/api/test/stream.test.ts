import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ExecutionEventType } from "@orchestra/core";
import { LISTEN_APPLICATION_NAME, appendEvent } from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  defaultListBacklog,
  defaultLoadEvent,
} from "../src/realtime/index.js";
import {
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

beforeAll(async () => {
  h = await startTestDb();
  const clock = createClock(new Date("2026-01-01T00:00:00Z"));
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
  waitForFrames(n: number): Promise<Frame[]>;
  close(): void;
}

/**
 * Minimal SSE client over `node:http`, so the test can read frames as they
 * arrive and drop the socket to simulate a client disconnect.
 */
function openStream(
  path: string,
  headers: Record<string, string> = {},
): Promise<StreamClient> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${baseUrl}${path}`,
      { headers: { cookie, ...headers } },
      (res) => {
        const client: StreamClient = {
          status: res.statusCode ?? 0,
          contentType: res.headers["content-type"],
          frames: [],
          comments: [],
          ended: false,
          async waitForFrames(n) {
            await waitFor(() => client.frames.length >= n);
            return client.frames;
          },
          close() {
            req.destroy();
          },
        };
        let buffer = "";
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
});

describe("shutdown (T8/H8)", () => {
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
