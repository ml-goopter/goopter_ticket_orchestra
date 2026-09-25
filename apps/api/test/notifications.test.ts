import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Clock,
  type Fixtures,
  type TestDb,
  buildTestApp,
  createClock,
  seedFixtures,
  seedNotification,
  seedSession,
  seedTask,
  sessionCookieHeader,
  startTestDb,
} from "./harness.js";

let h: TestDb;
let app: FastifyInstance;
let clock: Clock;
let fx: Fixtures;
let fxOther: Fixtures;
let cookie: string;
let cookieOther: string;

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  h = await startTestDb();
  clock = createClock(new Date("2026-01-01T00:00:00Z"));
  app = await buildTestApp(h, clock);
  fx = await seedFixtures(h.db, "NTF");
  fxOther = await seedFixtures(h.db, "NTO");
  const sessionId = await seedSession(h.db, {
    userId: fx.userId,
    expiresAt: new Date(clock.now().getTime() + 1000 * 60 * 60),
  });
  cookie = sessionCookieHeader(sessionId);
  const sessionIdOther = await seedSession(h.db, {
    userId: fxOther.userId,
    expiresAt: new Date(clock.now().getTime() + 1000 * 60 * 60),
  });
  cookieOther = sessionCookieHeader(sessionIdOther);
}, 180000);

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

let keyCounter = 100;
function nextKey(): string {
  keyCounter += 1;
  return `NTF-${keyCounter}`;
}

async function newTask(): Promise<string> {
  return seedTask(h.db, fx, { jiraKey: nextKey(), state: "IMPLEMENTING" });
}

function get(url: string, withCookie: string | false = cookie) {
  return app.inject({ method: "GET", url, headers: withCookie ? { cookie: withCookie } : {} });
}

function post(url: string, withCookie: string | false = cookie) {
  return app.inject({ method: "POST", url, headers: withCookie ? { cookie: withCookie } : {} });
}

describe("GET /api/notifications (AC9)", () => {
  it("returns broadcast rows and the caller's own, not another user's", async () => {
    const taskId = await newTask();
    const broadcast = await seedNotification(h.db, { taskId, userId: null, title: "broadcast" });
    const mine = await seedNotification(h.db, { taskId, userId: fx.userId, title: "mine" });
    const someoneElses = await seedNotification(h.db, {
      taskId,
      userId: fxOther.userId,
      title: "not mine",
    });

    const res = await get("/api/notifications");
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(broadcast);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(someoneElses);
  });

  it("returns newest first", async () => {
    const taskId = await newTask();
    const first = await seedNotification(h.db, {
      taskId,
      userId: fx.userId,
      title: "first",
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    const second = await seedNotification(h.db, {
      taskId,
      userId: fx.userId,
      title: "second",
      createdAt: new Date("2026-02-02T00:00:00Z"),
    });

    const res = await get("/api/notifications");
    const ids = (res.json() as Array<{ id: string }>).map((r) => r.id);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
  });

  it("returns 401 without a session", async () => {
    expect((await get("/api/notifications", false)).statusCode).toBe(401);
  });
});

describe("POST /api/notifications/:id/read (AC9)", () => {
  it("sets read_at once and is idempotent", async () => {
    const taskId = await newTask();
    const id = await seedNotification(h.db, { taskId, userId: fx.userId, title: "mine" });

    const first = await post(`/api/notifications/${id}/read`);
    expect(first.statusCode).toBe(200);
    const firstReadAt = first.json().readAt;
    expect(firstReadAt).not.toBeNull();

    clock.advance(1000 * 60);
    const second = await post(`/api/notifications/${id}/read`);
    expect(second.statusCode).toBe(200);
    expect(second.json().readAt).toEqual(firstReadAt);
  });

  it("shares one read_at across users for a broadcast row", async () => {
    const taskId = await newTask();
    const id = await seedNotification(h.db, { taskId, userId: null, title: "broadcast" });

    const first = await post(`/api/notifications/${id}/read`, cookie);
    const firstReadAt = first.json().readAt;

    clock.advance(1000 * 60);
    const second = await post(`/api/notifications/${id}/read`, cookieOther);
    expect(second.statusCode).toBe(200);
    expect(second.json().readAt).toEqual(firstReadAt);
  });

  it("returns 404 for an unknown id", async () => {
    expect((await post(`/api/notifications/${UNKNOWN_ID}/read`)).statusCode).toBe(404);
  });

  it("returns 404 for another user's targeted notification", async () => {
    const taskId = await newTask();
    const id = await seedNotification(h.db, { taskId, userId: fxOther.userId, title: "not mine" });

    const res = await post(`/api/notifications/${id}/read`, cookie);
    expect(res.statusCode).toBe(404);
  });

  it("returns 401 without a session", async () => {
    expect((await post(`/api/notifications/${UNKNOWN_ID}/read`, false)).statusCode).toBe(401);
  });
});
