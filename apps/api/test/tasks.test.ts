import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, auditEvents, executionEvents, executions, tasks } from "@orchestra/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Clock,
  type Fixtures,
  type TestDb,
  buildTestApp,
  createClock,
  seedDependency,
  seedExecution,
  seedFixtures,
  seedSession,
  seedTask,
  sessionCookieHeader,
  startTestDb,
} from "./harness.js";

let h: TestDb;
let app: FastifyInstance;
let clock: Clock;
let fx: Fixtures;
let fx2: Fixtures;
let cookie: string;

beforeAll(async () => {
  h = await startTestDb();
  clock = createClock(new Date("2026-01-01T00:00:00Z"));
  app = await buildTestApp(h, clock);

  fx = await seedFixtures(h.db, "TSK");
  fx2 = await seedFixtures(h.db, "OTH");

  const sessionId = await seedSession(h.db, {
    userId: fx.userId,
    expiresAt: new Date(clock.now().getTime() + 1000 * 60 * 60),
  });
  cookie = sessionCookieHeader(sessionId);
}, 180000);

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

function seedTaskViaHarness(
  fixtures: Fixtures,
  options: Parameters<typeof seedTask>[2],
) {
  return seedTask(h.db, fixtures, options);
}

describe("GET /api/tasks (AC1)", () => {
  let needsSpecId: string;
  let waitingId: string;
  let readyForMergeId: string;
  let doneId: string;
  let specReviewId: string;
  let otherProjectId: string;
  let costTaskId: string;

  beforeAll(async () => {
    needsSpecId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-1",
      state: "NEEDS_SPEC",
      priority: 1,
    });
    waitingId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-2",
      state: "IMPLEMENTING",
      priority: 2,
    });
    await seedExecution(h.db, waitingId, { state: "WAITING_FOR_USER" });
    readyForMergeId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-3",
      state: "READY_FOR_MERGE",
      priority: 3,
    });
    doneId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-4",
      state: "DONE",
      priority: 4,
    });
    specReviewId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-5",
      state: "SPEC_REVIEW",
      priority: 5,
    });
    otherProjectId = await seedTaskViaHarness(fx2, {
      jiraKey: "OTH-1",
      state: "NEEDS_SPEC",
      priority: 1,
    });
    costTaskId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-6",
      state: "IMPLEMENTING",
      priority: 6,
    });
    await seedExecution(h.db, costTaskId, {
      state: "COMPLETED",
      costUsd: "1.250000",
    });
    await seedExecution(h.db, costTaskId, {
      state: "COMPLETED",
      attempt: 2,
      costUsd: "0.750000",
    });
  });

  it("returns cards with derived columns for every seeded state", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const cards = res.json() as Array<{ id: string; column: string }>;
    const byId = new Map(cards.map((c) => [c.id, c]));

    expect(byId.get(needsSpecId)?.column).toBe("Needs Spec");
    expect(byId.get(waitingId)?.column).toBe("Waiting for You");
    expect(byId.get(readyForMergeId)?.column).toBe("Ready for Merge");
    expect(byId.get(doneId)?.column).toBe("Done");
  });

  it("filters by state", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tasks?state=NEEDS_SPEC",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const cards = res.json() as Array<{ id: string; state: string }>;
    expect(cards.every((c) => c.state === "NEEDS_SPEC")).toBe(true);
    expect(cards.map((c) => c.id)).toContain(needsSpecId);
  });

  it("returns 400 for an unknown state", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tasks?state=NOT_A_STATE",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("filters by project id", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/tasks?project=${fx.projectId}`,
      headers: { cookie },
    });
    const cards = res.json() as Array<{ id: string }>;
    expect(cards.map((c) => c.id)).toContain(needsSpecId);
    expect(cards.map((c) => c.id)).not.toContain(otherProjectId);
  });

  it("filters by project key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tasks?project=OTH",
      headers: { cookie },
    });
    const cards = res.json() as Array<{ id: string }>;
    expect(cards.map((c) => c.id)).toEqual([otherProjectId]);
  });

  it("attention=1 returns only tasks listAttention would return", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tasks?attention=1",
      headers: { cookie },
    });
    const cards = res.json() as Array<{ id: string }>;
    const ids = cards.map((c) => c.id);
    expect(ids).toContain(specReviewId);
    expect(ids).toContain(readyForMergeId);
    expect(ids).toContain(waitingId);
    expect(ids).not.toContain(needsSpecId);
    expect(ids).not.toContain(doneId);
  });

  it("cost equals the sum of the task's executions' cost_usd", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { cookie },
    });
    const cards = res.json() as Array<{ id: string; cost: number }>;
    const card = cards.find((c) => c.id === costTaskId)!;
    expect(card.cost).toBe(2);
  });
});

describe("GET /api/tasks/:id (AC2)", () => {
  let taskId: string;
  let dependsOnId: string;

  beforeAll(async () => {
    dependsOnId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-10",
      state: "DONE",
      priority: 10,
    });
    taskId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-11",
      state: "IMPLEMENTING",
      priority: 11,
    });
    await seedDependency(h.db, taskId, dependsOnId);
    await seedExecution(h.db, taskId, { state: "RUNNING", costUsd: "3.000000" });
  });

  it("returns the aggregate with dependencies and cost", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.task.id).toBe(taskId);
    expect(body.dependencies).toEqual([
      { taskId: dependsOnId, jiraKey: "TSK-10", state: "DONE" },
    ]);
    expect(body.cost.costUsd).toBe(3);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tasks/00000000-0000-4000-8000-000000000000",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for a malformed id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tasks/not-a-uuid",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/tasks/:id/timeline (AC3)", () => {
  let taskId: string;

  beforeAll(async () => {
    taskId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-20",
      state: "IMPLEMENTING",
      priority: 20,
    });
    await h.db.transaction(async (tx) => {
      for (let n = 1; n <= 5; n++) {
        await appendEvent(tx, {
          taskId,
          type: "agent.note",
          payload: { n },
        });
      }
    });
  });

  it("pages through events with limit and after", async () => {
    const first = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/timeline?limit=2`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.events).toHaveLength(2);
    expect(firstBody.events.map((e: { payload: { n: number } }) => e.payload.n)).toEqual([1, 2]);
    const nextAfter = firstBody.nextAfter;
    expect(typeof nextAfter).toBe("number");

    const second = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/timeline?after=${nextAfter}&limit=2`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.events.map((e: { payload: { n: number } }) => e.payload.n)).toEqual([3, 4]);
  });

  it("returns an empty page when paging past the last event (F5)", async () => {
    const all = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/timeline?limit=5`,
      headers: { cookie },
    });
    const lastId = all.json().nextAfter;

    const res = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/timeline?after=${lastId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toEqual([]);
    expect(body.nextAfter).toBe(lastId);
  });

  it("returns 400 for limit=0 and limit=1001", async () => {
    const zero = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/timeline?limit=0`,
      headers: { cookie },
    });
    expect(zero.statusCode).toBe(400);

    const tooMany = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/timeline?limit=1001`,
      headers: { cookie },
    });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe("PATCH /api/tasks/:id (AC4)", () => {
  let taskId: string;
  let taskAKey: string;
  let taskBKey: string;
  let taskAId: string;
  let taskBId: string;

  beforeAll(async () => {
    taskId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-30",
      state: "READY",
      priority: 30,
    });
    taskAId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-31",
      state: "READY",
      priority: 31,
    });
    taskBId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-32",
      state: "READY",
      priority: 32,
    });
    taskAKey = "TSK-31";
    taskBKey = "TSK-32";
  });

  it("sets runtime_override to codex and back to null", async () => {
    const setRes = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie },
      payload: { runtime_override: "codex" },
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json().task.runtimeOverride).toBe("codex");

    const clearRes = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie },
      payload: { runtime_override: null },
    });
    expect(clearRes.statusCode).toBe(200);
    expect(clearRes.json().task.runtimeOverride).toBeNull();
  });

  it("persists dependencies by Jira key and returns them", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie },
      payload: { dependencies: [taskAKey] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dependencies).toEqual([
      { taskId: taskAId, jiraKey: taskAKey, state: "READY" },
    ]);
  });

  it("returns 400 naming an unknown Jira key", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie },
      payload: { dependencies: ["NOPE-1"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("NOPE-1");
  });

  it("returns 400 for an unknown body key (F1)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie },
      payload: { runtime_override: "codex", bogus: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 naming a duplicate Jira key (F2)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie },
      payload: { dependencies: [taskAKey, taskAKey] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(res.json().error.message).toContain(taskAKey);
  });

  it("rejects a cycle: A->B then B->A", async () => {
    const first = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskAId}`,
      headers: { cookie },
      payload: { dependencies: [taskBKey] },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskBId}`,
      headers: { cookie },
      payload: { dependencies: [taskAKey] },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error.code).toBe("DEPENDENCY_CYCLE");
    expect(body.error.path).toContain(taskAKey);
    expect(body.error.path).toContain(taskBKey);
  });

  it("two opposing concurrent PATCHes serialise: one 200, one 409 DEPENDENCY_CYCLE, never a 500 (F6)", async () => {
    const pId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-37",
      state: "READY",
      priority: 37,
    });
    const qId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-38",
      state: "READY",
      priority: 38,
    });

    // Both payloads set runtime_override *and* dependencies: F6's deadlock
    // needs `setRuntimeOverride`'s row-level UPDATE on the task's own id to
    // race against the other request's lock acquisition, not just the
    // dependency lock step in isolation.
    const [first, second] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/tasks/${pId}`,
        headers: { cookie },
        payload: { runtime_override: "codex", dependencies: ["TSK-38"] },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/tasks/${qId}`,
        headers: { cookie },
        payload: { runtime_override: "claude", dependencies: ["TSK-37"] },
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = first.statusCode === 200 ? first : second;
    const loser = first.statusCode === 200 ? second : first;
    expect(loser.json().error.code).toBe("DEPENDENCY_CYCLE");
    expect(winner.json().dependencies).toHaveLength(1);
  });

  it("rejects a self-dependency with 409 DEPENDENCY_CYCLE and the exact two-node path (F4)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie },
      payload: { dependencies: ["TSK-30"] },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("DEPENDENCY_CYCLE");
    expect(body.error.path).toEqual(["TSK-30", "TSK-30"]);
  });

  it("clears dependencies when given an empty array (F5)", async () => {
    const clearTaskId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-33",
      state: "READY",
      priority: 33,
    });
    await seedTaskViaHarness(fx, {
      jiraKey: "TSK-34",
      state: "READY",
      priority: 34,
    });

    const setRes = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${clearTaskId}`,
      headers: { cookie },
      payload: { dependencies: ["TSK-34"] },
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json().dependencies).toHaveLength(1);

    const clearRes = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${clearTaskId}`,
      headers: { cookie },
      payload: { dependencies: [] },
    });
    expect(clearRes.statusCode).toBe(200);
    expect(clearRes.json().dependencies).toEqual([]);
  });

  it("leaves dependencies untouched when omitted from the body (F5)", async () => {
    const untouchedTaskId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-35",
      state: "READY",
      priority: 35,
    });
    const depTaskId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-36",
      state: "READY",
      priority: 36,
    });

    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${untouchedTaskId}`,
      headers: { cookie },
      payload: { dependencies: ["TSK-36"] },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${untouchedTaskId}`,
      headers: { cookie },
      payload: { runtime_override: "codex" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dependencies).toEqual([
      { taskId: depTaskId, jiraKey: "TSK-36", state: "READY" },
    ]);
  });
});

describe("POST /api/tasks/:id/cancel (AC5)", () => {
  it("cancels from NEEDS_SPEC, writes audit + event, and cancels a RUNNING execution", async () => {
    const taskId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-40",
      state: "NEEDS_SPEC",
      priority: 40,
    });
    const execId = await seedExecution(h.db, taskId, { state: "RUNNING" });

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ from: "NEEDS_SPEC", to: "CANCELLED" });

    const audits = await h.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, taskId));
    expect(audits.some((a) => a.toState === "CANCELLED")).toBe(true);

    const events = await h.db
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.taskId, taskId));
    expect(events.some((e) => e.type === "task.state_changed")).toBe(true);

    const [execRow] = await h.db
      .select()
      .from(executions)
      .where(eq(executions.id, execId));
    expect(execRow!.state).toBe("CANCELLED");
  });

  it("returns 409 ILLEGAL_TRANSITION cancelling a DONE task", async () => {
    const taskId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-41",
      state: "DONE",
      priority: 41,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");
  });
});

describe("POST /api/tasks/:id/retry (AC6)", () => {
  it("moves NEEDS_HUMAN to READY and clears needs_human_reason", async () => {
    const taskId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-50",
      state: "NEEDS_HUMAN",
      priority: 50,
      needsHumanReason: "stuck",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/retry`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ from: "NEEDS_HUMAN", to: "READY" });

    const [row] = await h.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row!.needsHumanReason).toBeNull();

    const audits = await h.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, taskId));
    expect(audits.some((a) => a.toState === "READY")).toBe(true);

    const events = await h.db
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.taskId, taskId));
    expect(events.some((e) => e.type === "task.state_changed")).toBe(true);
  });

  it("returns 409 retrying from IMPLEMENTING", async () => {
    const taskId = await seedTaskViaHarness(fx, {
      jiraKey: "TSK-51",
      state: "IMPLEMENTING",
      priority: 51,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/retry`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");
  });
});

describe("auth required (AC7)", () => {
  it.each([
    ["GET", "/api/tasks"],
    ["GET", "/api/tasks/00000000-0000-4000-8000-000000000000"],
    ["GET", "/api/tasks/00000000-0000-4000-8000-000000000000/timeline"],
    ["PATCH", "/api/tasks/00000000-0000-4000-8000-000000000000"],
    ["POST", "/api/tasks/00000000-0000-4000-8000-000000000000/cancel"],
    ["POST", "/api/tasks/00000000-0000-4000-8000-000000000000/retry"],
  ])("rejects %s %s without a session cookie", async (method, url) => {
    const res = await app.inject({ method: method as "GET", url });
    expect(res.statusCode).toBe(401);
  });
});

describe("dependency boundary (AC8, design.md §3: apps/api never imports drizzle-orm)", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const allowed = new Set([
    join(srcDir, "plugins", "auth.ts"),
    join(srcDir, "lib", "users.ts"),
    join(srcDir, "routes", "auth.ts"),
  ]);

  function walk(dir: string): string[] {
    const entries = readdirSync(dir);
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        files.push(...walk(full));
      } else if (entry.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  it("imports drizzle-orm only from the three pre-existing files", () => {
    const offenders: string[] = [];
    for (const file of walk(srcDir)) {
      if (allowed.has(file)) continue;
      const content = readFileSync(file, "utf8");
      if (/from\s+["']drizzle-orm["']/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("routes/tasks.ts in particular has zero drizzle-orm imports", () => {
    const content = readFileSync(join(srcDir, "routes", "tasks.ts"), "utf8");
    expect(/drizzle-orm/.test(content)).toBe(false);
  });
});
