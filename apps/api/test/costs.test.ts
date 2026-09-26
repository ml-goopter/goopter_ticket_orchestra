import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestApp,
  createClock,
  seedExecution,
  seedExecutionUsage,
  seedFixtures,
  seedSession,
  seedTask,
  sessionCookieHeader,
  startTestDb,
  type Clock,
  type Fixtures,
  type TestDb,
} from "./harness.js";

let h: TestDb;
let app: FastifyInstance;
let clock: Clock;
let cookie: string;

let fx1: Fixtures;
let fx2: Fixtures;
let task1: string;
let task2: string;

const T1 = new Date("2026-02-01T00:00:00Z"); // task1 main
const T2 = new Date("2026-02-02T00:00:00Z"); // task1 review round 1
const T3 = new Date("2026-02-03T00:00:00Z"); // task1 resume
const T4 = new Date("2026-03-01T00:00:00Z"); // task2 main (unpriced)
const T5 = new Date("2026-03-02T00:00:00Z"); // task2 review round 1

beforeAll(async () => {
  h = await startTestDb();
  clock = createClock(new Date("2026-01-01T00:00:00Z"));
  app = await buildTestApp(h, clock);

  fx1 = await seedFixtures(h.db, "CST1");
  fx2 = await seedFixtures(h.db, "CST2");

  const sessionId = await seedSession(h.db, {
    userId: fx1.userId,
    expiresAt: new Date(clock.now().getTime() + 1000 * 60 * 60),
  });
  cookie = sessionCookieHeader(sessionId);

  task1 = await seedTask(h.db, fx1, { jiraKey: "CST1-1", state: "IMPLEMENTING" });
  task2 = await seedTask(h.db, fx2, { jiraKey: "CST2-1", state: "IMPLEMENTING" });

  const execution1 = await seedExecution(h.db, task1, {
    state: "RUNNING",
    runtime: "claude",
    model: "claude-sonnet-5",
  });
  await seedExecutionUsage(h.db, execution1, {
    kind: "main",
    runtime: "claude",
    model: "claude-sonnet-5",
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 50,
    costUsd: "1.000000",
    recordedAt: T1,
  });
  await seedExecutionUsage(h.db, execution1, {
    kind: "review",
    round: 1,
    runtime: "claude",
    model: "claude-sonnet-5",
    inputTokens: 60,
    cachedInputTokens: 5,
    outputTokens: 20,
    costUsd: "0.500000",
    recordedAt: T2,
  });
  await seedExecutionUsage(h.db, execution1, {
    kind: "resume",
    runtime: "claude",
    model: "claude-sonnet-5",
    inputTokens: 30,
    cachedInputTokens: 0,
    outputTokens: 10,
    costUsd: "0.250000",
    recordedAt: T3,
  });

  const execution2 = await seedExecution(h.db, task2, {
    state: "RUNNING",
    runtime: "codex",
    model: "gpt-5-codex-preview",
  });
  await seedExecutionUsage(h.db, execution2, {
    kind: "main",
    runtime: "codex",
    model: "gpt-5-codex-preview",
    inputTokens: 200,
    cachedInputTokens: 0,
    outputTokens: 100,
    costUsd: null,
    recordedAt: T4,
  });
  await seedExecutionUsage(h.db, execution2, {
    kind: "review",
    round: 1,
    runtime: "codex",
    model: "gpt-5-codex",
    inputTokens: 80,
    cachedInputTokens: 0,
    outputTokens: 40,
    costUsd: "2.000000",
    recordedAt: T5,
  });
}, 180000);

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

function findRow(rows: Array<{ key: { id: string; label: string } }>, label: string) {
  const row = rows.find((r) => r.key.label === label);
  if (!row) throw new Error(`no row for label ${label} among ${JSON.stringify(rows)}`);
  return row;
}

describe("GET /api/costs (AC3)", () => {
  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/costs?group=project" });
    expect(res.statusCode).toBe(401);
  });

  it("groups by project and sums cost, tokens, and by_kind", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/costs?group=project",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();

    const project1 = findRow(rows, "CST1 project");
    expect(project1.cost_usd).toBe(1.75);
    expect(project1.input_tokens).toBe(190);
    expect(project1.cached_input_tokens).toBe(15);
    expect(project1.output_tokens).toBe(80);
    expect(project1.unpriced_rows).toBe(0);
    expect(project1.by_kind.main).toMatchObject({ cost_usd: 1, unpriced_rows: 0 });
    expect(project1.by_kind.review).toMatchObject({ cost_usd: 0.5, unpriced_rows: 0 });
    expect(project1.by_kind.resume).toMatchObject({ cost_usd: 0.25, unpriced_rows: 0 });

    const project2 = findRow(rows, "CST2 project");
    expect(project2.cost_usd).toBe(2);
    expect(project2.unpriced_rows).toBe(1);
    expect(project2.by_kind.main).toMatchObject({ cost_usd: 0, unpriced_rows: 1 });
    expect(project2.by_kind.review).toMatchObject({ cost_usd: 2, unpriced_rows: 0 });
  });

  it("groups by task, labeling rows with the Jira key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/costs?group=task",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(findRow(rows, "CST1-1").cost_usd).toBe(1.75);
    expect(findRow(rows, "CST2-1").cost_usd).toBe(2);
  });

  it("groups by runtime", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/costs?group=runtime",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(findRow(rows, "claude").cost_usd).toBe(1.75);
    const codexRow = findRow(rows, "codex");
    expect(codexRow.cost_usd).toBe(2);
    expect(codexRow.unpriced_rows).toBe(1);
  });

  it("filters by from/to against execution_usage.recorded_at", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/costs?group=project&from=${T1.toISOString()}&to=${T2.toISOString()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    // Only T1 (main, 1.00) and T2 (review, 0.50) fall in range; T3 (resume) does not.
    expect(findRow(rows, "CST1 project").cost_usd).toBe(1.5);
    expect(rows.find((r: { key: { label: string } }) => r.key.label === "CST2 project")).toBeUndefined();
  });

  it("rejects an unknown group with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/costs?group=repository",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing group with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/costs",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed date with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/costs?group=project&from=not-a-date",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects from after to with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/costs?group=project&from=${T5.toISOString()}&to=${T1.toISOString()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/tasks/:id/costs (AC4)", () => {
  it("returns the per-execution breakdown, estimated true for claude", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/tasks/${task1}/costs`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.task_id).toBe(task1);
    expect(body.total).toMatchObject({ cost_usd: 1.75, unpriced_rows: 0 });
    expect(body.executions).toHaveLength(1);

    const execution = body.executions[0];
    expect(execution.runtime).toBe("claude");
    expect(execution.estimated).toBe(true);
    expect(execution.usage).toHaveLength(3);
    expect(execution.usage.map((u: { kind: string }) => u.kind)).toEqual([
      "main",
      "review",
      "resume",
    ]);
    expect(execution.usage[1].round).toBe(1);
    for (const row of execution.usage) {
      expect(row.estimated).toBe(true);
    }
    expect(execution.total.cost_usd).toBe(1.75);
  });

  it("returns estimated false for codex, and cost_usd null on the unpriced row", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/tasks/${task2}/costs`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toMatchObject({ cost_usd: 2, unpriced_rows: 1 });

    const execution = body.executions[0];
    expect(execution.runtime).toBe("codex");
    expect(execution.estimated).toBe(false);
    const main = execution.usage.find((u: { kind: string }) => u.kind === "main");
    expect(main.cost_usd).toBeNull();
    expect(main.estimated).toBe(false);
  });

  it("404s for an unknown task", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tasks/00000000-0000-0000-0000-000000000000/costs",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
