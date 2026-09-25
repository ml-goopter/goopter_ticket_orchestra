import type { CommandType } from "@orchestra/core";
import {
  agentWorkers,
  executionCommands,
  executions,
  projects,
  tasks,
  type Db,
  type ExecutionCommandRow,
} from "@orchestra/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LogFields, Logger } from "../src/logger.js";
import { createDefaultPhases } from "../src/phases/index.js";
import {
  createCommandHandlers,
  createConsumeCommandsPhase,
  registerCancelHandler,
  type CommandHandlers,
} from "../src/runner/index.js";
import type { TickContext } from "../src/tick.js";
import { startTestDb, type TestDb } from "./harness.js";

/** design.md §6.1 command consumer against a real Postgres (AC1). */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const HOST = "consumer-host-a";
const OTHER_HOST = "consumer-host-b";
const NOW = new Date("2026-09-25T10:00:00.000Z");

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
});

afterAll(async () => {
  await testDb?.stop();
});

let taskId: string;
let workerId: string;

beforeEach(async () => {
  records.length = 0;
  await db.$client.unsafe(
    "truncate table projects, agent_workers, audit_events restart identity cascade",
  );
  const [worker] = await db
    .insert(agentWorkers)
    .values({ host: HOST, capabilities: [], maxConcurrent: 2, workspaceRoot: "/tmp/o" })
    .returning({ id: agentWorkers.id });
  workerId = worker!.id;
  const [project] = await db
    .insert(projects)
    .values({ key: "CC", name: "consumer", jiraJql: "project = CC" })
    .returning({ id: projects.id });
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      jiraKey: "CC-1",
      jiraSummary: "consumer task",
      jiraPriority: 3,
      jiraCreatedAt: NOW,
      jiraSyncedAt: NOW,
      state: "IMPLEMENTING",
    })
    .returning({ id: tasks.id });
  taskId = task!.id;
});

let attempt = 0;
async function seedExecution(host: string | null): Promise<string> {
  const [row] = await db
    .insert(executions)
    .values({
      taskId,
      role: "implementation",
      attempt: ++attempt,
      state: "RUNNING",
      runtime: "claude",
      model: "default",
      host,
    })
    .returning({ id: executions.id });
  return row!.id;
}

let minute = 0;
async function seedCommand(
  type: CommandType,
  executionId: string | null,
  payload: unknown = {},
): Promise<string> {
  const [row] = await db
    .insert(executionCommands)
    .values({
      taskId,
      executionId,
      type,
      payload,
      createdAt: new Date(NOW.getTime() - 60_000 * 100 + 60_000 * ++minute),
    })
    .returning({ id: executionCommands.id });
  return row!.id;
}

const command = async (id: string) =>
  (await db.query.executionCommands.findFirst({ where: (c, { eq }) => eq(c.id, id) }))!;

const config = loadConfig({
  DATABASE_URL: "postgres://localhost/unused",
  WORKER_HOST: HOST,
});

function ctx(): TickContext {
  return { db, workerId, config, now: NOW, tick: 1, logger };
}

function recordingHandlers(
  seen: ExecutionCommandRow[],
  failOn: Set<string> = new Set(),
): CommandHandlers {
  const handlers = createCommandHandlers();
  handlers.registerCommandHandler("cancel", async (cmd) => {
    seen.push(cmd);
    if (failOn.has(cmd.id)) throw new Error("handler boom");
  });
  return handlers;
}

describe("consume_commands phase (design.md §6.1)", () => {
  it("claims handled types for this host or an unpinned execution, oldest first, and completes them", async () => {
    const mine = await seedExecution(HOST);
    const theirs = await seedExecution(OTHER_HOST);
    const unpinned = await seedExecution(null);

    const cOther = await seedCommand("cancel", theirs);
    const cMine = await seedCommand("cancel", mine);
    const cUnpinned = await seedCommand("cancel", unpinned);
    const cNoExecution = await seedCommand("cancel", null);
    const cUnhandled = await seedCommand("send_message", mine);

    const seen: ExecutionCommandRow[] = [];
    await createConsumeCommandsPhase(recordingHandlers(seen)).run(ctx());

    expect(seen.map((c) => c.id)).toEqual([cMine, cUnpinned, cNoExecution]);
    for (const id of [cMine, cUnpinned, cNoExecution]) {
      const row = await command(id);
      expect(row.claimedAt).toEqual(NOW);
      expect(row.completedAt).not.toBeNull();
    }
    // Another host's execution: left alone.
    expect((await command(cOther)).claimedAt).toBeNull();
    // A type with no handler: never claimed.
    expect((await command(cUnhandled)).claimedAt).toBeNull();
  });

  it("claims at most 10 per tick", async () => {
    const mine = await seedExecution(HOST);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await seedCommand("cancel", mine));

    const seen: ExecutionCommandRow[] = [];
    await createConsumeCommandsPhase(recordingHandlers(seen)).run(ctx());

    expect(seen.map((c) => c.id)).toEqual(ids.slice(0, 10));
    expect((await command(ids[10]!)).claimedAt).toBeNull();
    expect((await command(ids[11]!)).claimedAt).toBeNull();

    seen.length = 0;
    await createConsumeCommandsPhase(recordingHandlers(seen)).run(ctx());
    expect(seen.map((c) => c.id)).toEqual(ids.slice(10));
  });

  it("leaves a throwing handler's command claimed and uncompleted and runs the next one", async () => {
    const mine = await seedExecution(HOST);
    const first = await seedCommand("cancel", mine);
    const second = await seedCommand("cancel", mine);

    const seen: ExecutionCommandRow[] = [];
    await createConsumeCommandsPhase(recordingHandlers(seen, new Set([first]))).run(ctx());

    expect(seen.map((c) => c.id)).toEqual([first, second]);
    const failed = await command(first);
    expect(failed.claimedAt).toEqual(NOW);
    expect(failed.completedAt).toBeNull();
    expect((await command(second)).completedAt).not.toBeNull();
    expect(records.some((r) => r.level === "error" && r.msg === "command handler failed")).toBe(true);

    // Claimed stays claimed: a later tick does not run it again.
    seen.length = 0;
    await createConsumeCommandsPhase(recordingHandlers(seen)).run(ctx());
    expect(seen).toEqual([]);
  });

  it("with no handler registered claims nothing (default phase registry)", async () => {
    const mine = await seedExecution(HOST);
    const id = await seedCommand("cancel", mine);

    const phase = createDefaultPhases().find((p) => p.name === "consume_commands")!;
    await phase.run(ctx());

    expect((await command(id)).claimedAt).toBeNull();
  });

  it("cancel handler aborts the command's execution_id only, is a no-op when not live, and ignores payload.execution_id", async () => {
    const mine = await seedExecution(HOST);
    const other = await seedExecution(HOST);
    const viaColumn = await seedCommand("cancel", mine);
    const notLive = await seedCommand("cancel", other);
    // No execution_id: completed as a no-op with a warning, payload ignored.
    const viaPayload = await seedCommand("cancel", null, { execution_id: mine });
    // The column wins over a payload naming another execution.
    const mixed = await seedCommand("cancel", other, { execution_id: mine });

    const aborted: string[] = [];
    const handlers = createCommandHandlers();
    registerCancelHandler(handlers, {
      abort: (executionId) => {
        aborted.push(executionId);
        return executionId === mine;
      },
    });
    await createDefaultPhases({ commands: handlers })
      .find((p) => p.name === "consume_commands")!
      .run(ctx());

    expect(aborted).toEqual([mine, other, other]);
    for (const id of [viaColumn, notLive, viaPayload, mixed]) {
      expect((await command(id)).completedAt).not.toBeNull();
    }
    expect(
      records.filter(
        (r) => r.level === "warn" && r.msg === "cancel command names no execution",
      ).map((r) => r.fields.commandId),
    ).toEqual([viaPayload]);
  });

  it("refuses a second handler for the same type", () => {
    const handlers = createCommandHandlers();
    handlers.registerCommandHandler("cancel", async () => {});
    expect(() => handlers.registerCommandHandler("cancel", async () => {})).toThrow(
      /already registered/,
    );
  });
});
