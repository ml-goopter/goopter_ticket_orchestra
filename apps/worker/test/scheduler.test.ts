import type { ExecutionState, Runtime, TaskState } from "@orchestra/core";
import {
  agentWorkers,
  createDb,
  executions,
  projects,
  repositories,
  specificationRevisions,
  taskDependencies,
  tasks,
  type Db,
} from "@orchestra/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { LEASE_TTL_MS } from "../src/agent-tools/lease.js";
import { loadConfig } from "../src/config.js";
import type { LogFields, Logger } from "../src/logger.js";
import { createDefaultPhases } from "../src/phases/index.js";
import {
  claimNextTask,
  createClaimPhase,
  createPromotePhase,
  type ClaimedExecution,
  type OnClaimed,
} from "../src/scheduler/index.js";
import type { Phase, TickContext } from "../src/tick.js";
import { startTestDb, waitFor, type TestDb } from "./harness.js";

/**
 * design.md §6.2 promotion and §6.3 claim against a real Postgres. Reads go
 * through drizzle's relational query API on the `Db` handle and raw SQL
 * through the postgres-js client, because `apps/**` may not import
 * drizzle-orm (eslint boundary).
 */

const records: Array<{ level: string; fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ level: "debug", fields, msg }),
  info: (fields, msg) => void records.push({ level: "info", fields, msg }),
  warn: (fields, msg) => void records.push({ level: "warn", fields, msg }),
  error: (fields, msg) => void records.push({ level: "error", fields, msg }),
  child: () => logger,
};

const NOW = new Date("2026-09-24T10:00:00.000Z");

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
});

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  records.length = 0;
  await raw(
    "truncate table projects, agent_workers, audit_events restart identity cascade",
  );
});

// ---------------------------------------------------------------- helpers

function raw(text: string, params: unknown[] = []): Promise<unknown[]> {
  return db.$client.unsafe(text, params as never[]) as unknown as Promise<
    unknown[]
  >;
}

let seq = 0;

async function seedWorker(
  options: { host?: string; capabilities?: string[]; maxConcurrent?: number } = {},
): Promise<{ id: string; host: string }> {
  const host = options.host ?? `host-${++seq}`;
  const [row] = await db
    .insert(agentWorkers)
    .values({
      host,
      capabilities: options.capabilities ?? ["node"],
      maxConcurrent: options.maxConcurrent ?? 2,
      workspaceRoot: "/tmp/orchestra",
    })
    .returning({ id: agentWorkers.id });
  return { id: row!.id, host };
}

let projectId: string | undefined;

async function project(): Promise<string> {
  if (projectId) {
    const found = await db.query.projects.findFirst({
      where: (p, { eq }) => eq(p.id, projectId!),
    });
    if (found) return projectId;
  }
  const n = ++seq;
  const [row] = await db
    .insert(projects)
    .values({ key: `SCH${n}`, name: `sched ${n}`, jiraJql: `project = SCH${n}` })
    .returning({ id: projects.id });
  projectId = row!.id;
  return projectId;
}

async function seedRepo(
  options: {
    runtime?: Runtime;
    model?: string | null;
    maxWorktrees?: number;
    capability?: string | null;
  } = {},
): Promise<string> {
  const n = ++seq;
  const [row] = await db
    .insert(repositories)
    .values({
      projectId: await project(),
      name: `repo-${n}`,
      gitUrl: `git@example.com:repo-${n}.git`,
      defaultBranch: "main",
      defaultRuntime: options.runtime ?? "claude",
      defaultModel: options.model === undefined ? "claude-opus" : options.model,
      maxConcurrentWorktrees: options.maxWorktrees ?? 1,
      requiredCapability: options.capability ?? null,
    })
    .returning({ id: repositories.id });
  return row!.id;
}

async function seedTask(options: {
  state: TaskState;
  repositoryId?: string | null;
  priority?: number;
  createdAt?: Date;
  runtimeOverride?: Runtime | null;
}): Promise<string> {
  const n = ++seq;
  const [row] = await db
    .insert(tasks)
    .values({
      projectId: await project(),
      repositoryId: options.repositoryId ?? null,
      jiraKey: `SCH-${n}`,
      jiraSummary: `task ${n}`,
      jiraPriority: options.priority ?? 3,
      jiraCreatedAt: options.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
      jiraSyncedAt: NOW,
      state: options.state,
      runtimeOverride: options.runtimeOverride ?? null,
    })
    .returning({ id: tasks.id });
  return row!.id;
}

async function approveRevision(taskId: string): Promise<string> {
  const [row] = await db
    .insert(specificationRevisions)
    .values({ taskId, version: 1, status: "approved", content: {} })
    .returning({ id: specificationRevisions.id });
  await raw("update tasks set approved_revision_id = $1 where id = $2", [
    row!.id,
    taskId,
  ]);
  return row!.id;
}

async function seedExecution(options: {
  taskId: string;
  state: ExecutionState;
  host?: string | null;
  role?: "spec" | "implementation";
  attempt?: number;
}): Promise<string> {
  const [row] = await db
    .insert(executions)
    .values({
      taskId: options.taskId,
      role: options.role ?? "implementation",
      attempt: options.attempt ?? 1,
      state: options.state,
      runtime: "claude",
      model: "claude-opus",
      host: options.host ?? null,
    })
    .returning({ id: executions.id });
  return row!.id;
}

async function dependOn(taskId: string, ...dependsOn: string[]): Promise<void> {
  await db
    .insert(taskDependencies)
    .values(dependsOn.map((d) => ({ taskId, dependsOnTaskId: d })));
}

const taskState = async (id: string) =>
  (await db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!
    .state;
const executionsFor = (taskId: string) =>
  db.query.executions.findMany({
    where: (t, { eq }) => eq(t.taskId, taskId),
    orderBy: (t, { asc }) => [asc(t.attempt)],
  });
const leasesFor = (taskId: string) =>
  db.query.taskLeases.findMany({ where: (t, { eq }) => eq(t.taskId, taskId) });
const auditFor = (entityId: string) =>
  db.query.auditEvents.findMany({
    where: (t, { eq }) => eq(t.entityId, entityId),
    orderBy: (t, { asc }) => [asc(t.id)],
  });
const eventsFor = (taskId: string) =>
  db.query.executionEvents.findMany({
    where: (t, { eq }) => eq(t.taskId, taskId),
    orderBy: (t, { asc }) => [asc(t.id)],
  });

/** Row counts across every table promotion or claim could write. */
async function writeSnapshot() {
  const [row] = (await raw(`select
      (select count(*)::int from executions) as executions,
      (select count(*)::int from task_leases) as leases,
      (select count(*)::int from audit_events) as audits,
      (select count(*)::int from execution_events) as events,
      (select string_agg(id || ':' || state, ',' order by id) from tasks) as states`)) as Array<
    Record<string, unknown>
  >;
  return row;
}

const config = loadConfig({ DATABASE_URL: "postgres://localhost/unused" });

function ctx(workerId: string, now: Date = NOW): TickContext {
  return { db, workerId, config, now, tick: 1, logger };
}

function recorder(): { calls: ClaimedExecution[]; onClaimed: OnClaimed } {
  const calls: ClaimedExecution[] = [];
  return { calls, onClaimed: (c) => void calls.push(c) };
}

async function runClaim(
  workerId: string,
  runtimes: Runtime[] = ["claude", "codex"],
): Promise<ClaimedExecution | null> {
  return claimNextTask({ db, workerId, runtimes, now: NOW });
}

// -------------------------------------------------------------- promotion

describe("promote_approved (design.md §6.2)", () => {
  let workerId: string;
  let promote: Phase;

  beforeEach(async () => {
    workerId = (await seedWorker()).id;
    promote = createPromotePhase();
  });

  it("moves a task with no dependencies to READY through transition()", async () => {
    const task = await seedTask({ state: "SPEC_APPROVED" });

    await promote.run(ctx(workerId));

    expect(await taskState(task)).toBe("READY");
    const audit = await auditFor(task);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entityType: "task",
      fromState: "SPEC_APPROVED",
      toState: "READY",
      trigger: "dependency.satisfied",
      actorKind: "worker",
      actorId: workerId,
    });
    const events = await eventsFor(task);
    expect(events.map((e) => e.type)).toEqual(["task.state_changed"]);
    expect(events[0]!.payload).toMatchObject({
      from: "SPEC_APPROVED",
      to: "READY",
      trigger: "dependency.satisfied",
    });
  });

  it("moves a task whose dependencies are all DONE to READY", async () => {
    const a = await seedTask({ state: "DONE" });
    const b = await seedTask({ state: "DONE" });
    const task = await seedTask({ state: "SPEC_APPROVED" });
    await dependOn(task, a, b);

    await promote.run(ctx(workerId));

    expect(await taskState(task)).toBe("READY");
  });

  it.each<TaskState>(["FAILED", "CANCELLED"])(
    "moves a task with a %s dependency to BLOCKED",
    async (bad) => {
      const done = await seedTask({ state: "DONE" });
      const failed = await seedTask({ state: bad });
      const task = await seedTask({ state: "SPEC_APPROVED" });
      await dependOn(task, done, failed);

      await promote.run(ctx(workerId));

      expect(await taskState(task)).toBe("BLOCKED");
      expect(await auditFor(task)).toMatchObject([
        {
          fromState: "SPEC_APPROVED",
          toState: "BLOCKED",
          trigger: "dependency.failed",
          actorKind: "worker",
        },
      ]);
      expect((await eventsFor(task)).map((e) => e.type)).toEqual([
        "task.state_changed",
      ]);
    },
  );

  it("leaves a task unchanged while a dependency is still open", async () => {
    const done = await seedTask({ state: "DONE" });
    const open = await seedTask({ state: "IMPLEMENTING" });
    const task = await seedTask({ state: "SPEC_APPROVED" });
    await dependOn(task, done, open);

    await promote.run(ctx(workerId));

    expect(await taskState(task)).toBe("SPEC_APPROVED");
    expect(await auditFor(task)).toEqual([]);
    expect(await eventsFor(task)).toEqual([]);
  });

  it("skips a task with an execution WAITING_FOR_USER", async () => {
    const task = await seedTask({ state: "SPEC_APPROVED" });
    await seedExecution({ taskId: task, state: "WAITING_FOR_USER" });

    await promote.run(ctx(workerId));

    expect(await taskState(task)).toBe("SPEC_APPROVED");
    expect(await auditFor(task)).toEqual([]);
  });

  it("does not move BLOCKED back to READY when its dependency recovers (Q6)", async () => {
    const dep = await seedTask({ state: "DONE" });
    const task = await seedTask({ state: "BLOCKED" });
    await dependOn(task, dep);

    await promote.run(ctx(workerId));

    expect(await taskState(task)).toBe("BLOCKED");
  });

  it("promotes every eligible task in one pass and ignores other states", async () => {
    const a = await seedTask({ state: "SPEC_APPROVED" });
    const b = await seedTask({ state: "SPEC_APPROVED" });
    const other = await seedTask({ state: "SPEC_REVIEW" });

    await promote.run(ctx(workerId));

    expect(await taskState(a)).toBe("READY");
    expect(await taskState(b)).toBe("READY");
    expect(await taskState(other)).toBe("SPEC_REVIEW");
  });

  it("keeps promoting other tasks when one task's transaction fails", async () => {
    const bad = await seedTask({ state: "SPEC_APPROVED", priority: 1 });
    const good = await seedTask({ state: "SPEC_APPROVED", priority: 2 });
    await withFailingTrigger(
      "tasks",
      "before update",
      `new.id = '${bad}'`,
      async () => {
        await promote.run(ctx(workerId));
      },
    );

    expect(await taskState(bad)).toBe("SPEC_APPROVED");
    expect(await auditFor(bad)).toEqual([]);
    expect(await taskState(good)).toBe("READY");
    expect(
      records.some((r) => r.level === "error" && r.fields.taskId === bad),
    ).toBe(true);
  });
});

// ------------------------------------------------------------------ claim

/** Installs a trigger that raises on `table` when `condition` holds. */
async function withFailingTrigger<T>(
  table: string,
  timing: string,
  condition: string,
  body: () => Promise<T>,
): Promise<T> {
  await raw(`create or replace function orchestra_test_fail() returns trigger
    language plpgsql as $$ begin raise exception 'injected failure'; end $$`);
  await raw(`create trigger orchestra_test_fail ${timing} on ${table}
    for each row when (${condition}) execute function orchestra_test_fail()`);
  try {
    return await body();
  } finally {
    await raw(`drop trigger orchestra_test_fail on ${table}`);
  }
}

describe("claim (design.md §6.3, §7.3)", () => {
  it("creates the ASSIGNED execution, the lease and the IMPLEMENTING move in one go (S7, G5)", async () => {
    const worker = await seedWorker({ host: "claim-host" });
    const repo = await seedRepo({ runtime: "codex", model: "gpt-5-codex" });
    const task = await seedTask({ state: "READY", repositoryId: repo });
    const revision = await approveRevision(task);

    const claim = await runClaim(worker.id);

    const [execution] = await executionsFor(task);
    expect(claim).toEqual({ executionId: execution!.id, taskId: task });
    expect(execution).toMatchObject({
      role: "implementation",
      attempt: 1,
      state: "ASSIGNED",
      runtime: "codex",
      model: "gpt-5-codex",
      specRevisionId: revision,
      workerId: worker.id,
      host: "claim-host",
    });

    const leases = await leasesFor(task);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      executionId: execution!.id,
      workerId: worker.id,
    });
    expect(leases[0]!.acquiredAt.getTime()).toBe(NOW.getTime());
    expect(leases[0]!.expiresAt.getTime()).toBe(NOW.getTime() + LEASE_TTL_MS);
    expect(LEASE_TTL_MS).toBe(5 * 60 * 1000);

    expect(await taskState(task)).toBe("IMPLEMENTING");

    expect(await auditFor(execution!.id)).toMatchObject([
      {
        entityType: "execution",
        fromState: "QUEUED",
        toState: "ASSIGNED",
        trigger: "execution.assigned",
        actorKind: "worker",
        actorId: worker.id,
      },
    ]);
    expect(await auditFor(task)).toMatchObject([
      {
        entityType: "task",
        fromState: "READY",
        toState: "IMPLEMENTING",
        trigger: "task.claimed",
        actorKind: "worker",
        actorId: worker.id,
      },
    ]);
    const events = await eventsFor(task);
    expect(events.map((e) => [e.type, e.executionId])).toEqual([
      ["execution.assigned", execution!.id],
      ["task.state_changed", null],
    ]);
  });

  it("uses the literal model 'default' when the repository sets none (Q5)", async () => {
    const worker = await seedWorker();
    const repo = await seedRepo({ model: null });
    const task = await seedTask({ state: "READY", repositoryId: repo });

    await runClaim(worker.id);

    const [execution] = await executionsFor(task);
    expect(execution!.model).toBe("default");
    expect(execution!.specRevisionId).toBeNull();
  });

  it("claims lowest jira_priority first, then oldest jira_created_at (S2)", async () => {
    const worker = await seedWorker({ maxConcurrent: 10 });
    const repo = await seedRepo({ maxWorktrees: 10 });
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-02-01T00:00:00.000Z");
    const p2old = await seedTask({ state: "READY", repositoryId: repo, priority: 2, createdAt: older });
    const p1new = await seedTask({ state: "READY", repositoryId: repo, priority: 1, createdAt: newer });
    const p1old = await seedTask({ state: "READY", repositoryId: repo, priority: 1, createdAt: older });

    const order: string[] = [];
    for (let i = 0; i < 3; i += 1) order.push((await runClaim(worker.id))!.taskId);

    expect(order).toEqual([p1old, p1new, p2old]);
    expect(await runClaim(worker.id)).toBeNull();
  });

  it("claims nothing when the host's ASSIGNED+RUNNING count reaches max_concurrent (S3)", async () => {
    const worker = await seedWorker({ host: "slots-host", maxConcurrent: 2 });
    const repo = await seedRepo({ maxWorktrees: 10 });
    const busy1 = await seedTask({ state: "IMPLEMENTING", repositoryId: repo });
    const busy2 = await seedTask({ state: "IMPLEMENTING", repositoryId: repo });
    await seedExecution({ taskId: busy1, state: "ASSIGNED", host: "slots-host" });
    await seedExecution({ taskId: busy2, state: "RUNNING", host: "slots-host" });
    const task = await seedTask({ state: "READY", repositoryId: repo });

    expect(await runClaim(worker.id)).toBeNull();
    expect(await taskState(task)).toBe("READY");
    expect(await executionsFor(task)).toEqual([]);
  });

  it("does not count WAITING_FOR_USER or other hosts' executions against the slots (S3)", async () => {
    const worker = await seedWorker({ host: "slots-host-2", maxConcurrent: 1 });
    const repo = await seedRepo({ maxWorktrees: 10 });
    const paused = await seedTask({ state: "IMPLEMENTING", repositoryId: repo });
    const elsewhere = await seedTask({ state: "IMPLEMENTING", repositoryId: repo });
    await seedExecution({ taskId: paused, state: "WAITING_FOR_USER", host: "slots-host-2" });
    await seedExecution({ taskId: elsewhere, state: "RUNNING", host: "other-host" });
    const task = await seedTask({ state: "READY", repositoryId: repo });

    expect((await runClaim(worker.id))?.taskId).toBe(task);
  });

  it("skips a repository at max_concurrent_worktrees and claims from another (S4)", async () => {
    const worker = await seedWorker({ host: "wt-host", maxConcurrent: 5 });
    const full = await seedRepo({ maxWorktrees: 1 });
    const free = await seedRepo({ maxWorktrees: 1 });
    const running = await seedTask({ state: "IMPLEMENTING", repositoryId: full });
    await seedExecution({ taskId: running, state: "ASSIGNED", host: "wt-host" });
    const inFull = await seedTask({ state: "READY", repositoryId: full, priority: 1 });
    const inFree = await seedTask({ state: "READY", repositoryId: free, priority: 5 });

    expect((await runClaim(worker.id))?.taskId).toBe(inFree);
    expect(await taskState(inFull)).toBe("READY");
  });

  it("counts only this host's ASSIGNED+RUNNING executions against worktree capacity (S4)", async () => {
    const worker = await seedWorker({ host: "wt-host-2", maxConcurrent: 5 });
    const repo = await seedRepo({ maxWorktrees: 1 });
    const other = await seedTask({ state: "IMPLEMENTING", repositoryId: repo });
    const paused = await seedTask({ state: "IMPLEMENTING", repositoryId: repo });
    await seedExecution({ taskId: other, state: "RUNNING", host: "someone-else" });
    await seedExecution({ taskId: paused, state: "WAITING_FOR_USER", host: "wt-host-2" });
    const task = await seedTask({ state: "READY", repositoryId: repo });

    expect((await runClaim(worker.id))?.taskId).toBe(task);
  });

  it("skips a repository whose required_capability the worker lacks (S5)", async () => {
    const worker = await seedWorker({ capabilities: ["node"], maxConcurrent: 5 });
    const odoo = await seedRepo({ capability: "odoo" });
    const node = await seedRepo({ capability: "node" });
    const any = await seedRepo({ capability: null });
    const inOdoo = await seedTask({ state: "READY", repositoryId: odoo, priority: 1 });
    const inNode = await seedTask({ state: "READY", repositoryId: node, priority: 2 });
    const inAny = await seedTask({ state: "READY", repositoryId: any, priority: 3 });

    expect((await runClaim(worker.id))?.taskId).toBe(inNode);
    expect((await runClaim(worker.id))?.taskId).toBe(inAny);
    expect(await runClaim(worker.id)).toBeNull();
    expect(await taskState(inOdoo)).toBe("READY");
  });

  it("matches a null required_capability for a worker with no capabilities (S5)", async () => {
    const worker = await seedWorker({ capabilities: [] });
    const repo = await seedRepo({ capability: null });
    const task = await seedTask({ state: "READY", repositoryId: repo });

    expect((await runClaim(worker.id))?.taskId).toBe(task);
  });

  it("claims only tasks whose effective runtime is detected (S6)", async () => {
    const worker = await seedWorker({ maxConcurrent: 5 });
    const codexRepo = await seedRepo({ runtime: "codex", maxWorktrees: 5 });
    const claudeRepo = await seedRepo({ runtime: "claude", maxWorktrees: 5 });
    const codexDefault = await seedTask({ state: "READY", repositoryId: codexRepo, priority: 1 });
    const overriddenToCodex = await seedTask({
      state: "READY",
      repositoryId: claudeRepo,
      priority: 2,
      runtimeOverride: "codex",
    });
    const overriddenToClaude = await seedTask({
      state: "READY",
      repositoryId: codexRepo,
      priority: 3,
      runtimeOverride: "claude",
    });

    const claim = await runClaim(worker.id, ["claude"]);
    expect(claim?.taskId).toBe(overriddenToClaude);
    expect((await executionsFor(overriddenToClaude))[0]!.runtime).toBe("claude");
    expect(await runClaim(worker.id, ["claude"])).toBeNull();
    expect(await taskState(codexDefault)).toBe("READY");
    expect(await taskState(overriddenToCodex)).toBe("READY");
  });

  it("claims nothing when no runtime was detected (S6)", async () => {
    const worker = await seedWorker();
    const repo = await seedRepo();
    const task = await seedTask({ state: "READY", repositoryId: repo });

    expect(await runClaim(worker.id, [])).toBeNull();
    expect(await taskState(task)).toBe("READY");
  });

  it("logs a task skipped for an undetected runtime once per task (S6)", async () => {
    const worker = await seedWorker({ capabilities: ["node"] });
    const codexRepo = await seedRepo({ runtime: "codex" });
    const odooCodexRepo = await seedRepo({ runtime: "codex", capability: "odoo" });
    const skipped = await seedTask({ state: "READY", repositoryId: codexRepo });
    // Not claimable for capability anyway: runtime is not the reason.
    await seedTask({ state: "READY", repositoryId: odooCodexRepo });
    const { onClaimed } = recorder();
    const phase = createClaimPhase({ runtimes: ["claude"], onClaimed });

    await phase.run(ctx(worker.id));
    await phase.run(ctx(worker.id));
    await phase.run(ctx(worker.id));

    const warnings = records.filter(
      (r) => r.level === "warn" && r.msg.includes("runtime"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields).toMatchObject({ taskId: skipped, runtime: "codex" });
    expect(await taskState(skipped)).toBe("READY");
  });

  it("gives attempt = previous max implementation attempt + 1 (S10)", async () => {
    const worker = await seedWorker();
    const repo = await seedRepo();
    const task = await seedTask({ state: "READY", repositoryId: repo });
    await seedExecution({ taskId: task, state: "FAILED", attempt: 1 });
    await seedExecution({ taskId: task, state: "CANCELLED", attempt: 2 });
    await seedExecution({ taskId: task, state: "COMPLETED", role: "spec", attempt: 7 });

    const claim = await runClaim(worker.id);

    const created = (await executionsFor(task)).find(
      (e) => e.id === claim!.executionId,
    );
    expect(created!.attempt).toBe(3);
  });

  describe("a task back in READY with a leftover lease (S11, S12)", () => {
    const LATER = new Date(NOW.getTime() + 60 * 60 * 1000);

    /**
     * Claims the task for real, then ends that execution in FAILED and puts
     * the task back to READY (as NEEDS_HUMAN -> READY on human.retry does),
     * leaving the first claim's lease row in place.
     */
    async function claimThenFail(workerId: string, task: string) {
      const first = await runClaim(workerId);
      expect(first?.taskId).toBe(task);
      await raw("update executions set state = 'FAILED' where id = $1", [
        first!.executionId,
      ]);
      await raw("update tasks set state = 'READY' where id = $1", [task]);
      const leftover = await leasesFor(task);
      expect(leftover).toHaveLength(1);
      expect(leftover[0]!.executionId).toBe(first!.executionId);
      return first!;
    }

    it("claims the task and replaces the old lease with one for the new execution (S11)", async () => {
      const worker = await seedWorker();
      const repo = await seedRepo();
      const task = await seedTask({ state: "READY", repositoryId: repo });
      const first = await claimThenFail(worker.id, task);

      const claim = await claimNextTask({
        db,
        workerId: worker.id,
        runtimes: ["claude"],
        now: LATER,
      });

      expect(claim?.taskId).toBe(task);
      expect(claim!.executionId).not.toBe(first.executionId);
      expect(await taskState(task)).toBe("IMPLEMENTING");

      const leases = await leasesFor(task);
      expect(leases).toHaveLength(1);
      expect(leases[0]).toMatchObject({
        executionId: claim!.executionId,
        workerId: worker.id,
      });
      expect(leases[0]!.acquiredAt.getTime()).toBe(LATER.getTime());
      expect(leases[0]!.expiresAt.getTime()).toBe(
        LATER.getTime() + 5 * 60 * 1000,
      );

      const all = await executionsFor(task);
      const previous = all.find((e) => e.id === first.executionId)!;
      const created = all.find((e) => e.id === claim!.executionId)!;
      expect(created.state).toBe("ASSIGNED");
      expect(created.attempt).toBe(previous.attempt + 1);
    });

    it("replaces a lease another worker held and still claims the next task on the following tick (S12)", async () => {
      const previousHolder = await seedWorker({ maxConcurrent: 5 });
      const worker = await seedWorker({ maxConcurrent: 5 });
      const repo = await seedRepo({ maxWorktrees: 5 });
      const retried = await seedTask({ state: "READY", repositoryId: repo, priority: 1 });
      await claimThenFail(previousHolder.id, retried);
      const lower = await seedTask({ state: "READY", repositoryId: repo, priority: 2 });
      const { calls, onClaimed } = recorder();
      const phase = createClaimPhase({ runtimes: ["claude"], onClaimed });

      await phase.run(ctx(worker.id, LATER));
      await phase.run(ctx(worker.id, LATER));

      expect(calls.map((c) => c.taskId)).toEqual([retried, lower]);
      expect(await taskState(retried)).toBe("IMPLEMENTING");
      expect(await taskState(lower)).toBe("IMPLEMENTING");
      const retriedLeases = await leasesFor(retried);
      expect(retriedLeases).toHaveLength(1);
      expect(retriedLeases[0]).toMatchObject({
        executionId: calls[0]!.executionId,
        workerId: worker.id,
      });
      expect(await leasesFor(lower)).toMatchObject([
        { executionId: calls[1]!.executionId, workerId: worker.id },
      ]);
    });

    it("keeps the old lease row untouched when a later claim step fails (S7)", async () => {
      const worker = await seedWorker();
      const repo = await seedRepo();
      const task = await seedTask({ state: "READY", repositoryId: repo });
      await claimThenFail(worker.id, task);
      const leaseBefore = await leasesFor(task);
      const before = await writeSnapshot();

      await withFailingTrigger(
        "tasks",
        "before update",
        "new.state = 'IMPLEMENTING'",
        async () => {
          await expect(
            claimNextTask({ db, workerId: worker.id, runtimes: ["claude"], now: LATER }),
          ).rejects.toThrow();
        },
      );

      expect(await writeSnapshot()).toEqual(before);
      expect(await leasesFor(task)).toEqual(leaseBefore);
      expect(await taskState(task)).toBe("READY");
    });
  });

  describe("rolls back every write when a step fails (S7)", () => {
    const steps: Array<[string, string, string, string]> = [
      ["execution insert", "executions", "before insert", "new.state = 'QUEUED'"],
      ["execution QUEUED -> ASSIGNED update", "executions", "before update", "new.state = 'ASSIGNED'"],
      ["execution audit row", "audit_events", "before insert", "new.entity_type = 'execution'"],
      ["execution.assigned event", "execution_events", "before insert", "new.type = 'execution.assigned'"],
      ["lease insert", "task_leases", "before insert", "true"],
      ["task READY -> IMPLEMENTING update", "tasks", "before update", "new.state = 'IMPLEMENTING'"],
      ["task audit row", "audit_events", "before insert", "new.entity_type = 'task'"],
      ["task.state_changed event", "execution_events", "before insert", "new.type = 'task.state_changed'"],
    ];

    it.each(steps)("at the %s", async (_step, table, timing, condition) => {
      const worker = await seedWorker();
      const repo = await seedRepo();
      const task = await seedTask({ state: "READY", repositoryId: repo });
      const { calls, onClaimed } = recorder();
      const phase = createClaimPhase({ runtimes: ["claude"], onClaimed });
      const before = await writeSnapshot();

      await withFailingTrigger(table, timing, condition, async () => {
        const err = await phase.run(ctx(worker.id)).then(
          () => undefined,
          (e: unknown) => e,
        );
        // drizzle wraps the driver error; the trigger's message is the cause.
        expect(String((err as Error | undefined)?.cause)).toMatch(
          /injected failure/,
        );
      });

      expect(await writeSnapshot()).toEqual(before);
      expect(await taskState(task)).toBe("READY");
      expect(await executionsFor(task)).toEqual([]);
      expect(await leasesFor(task)).toEqual([]);
      expect(await auditFor(task)).toEqual([]);
      expect(calls).toEqual([]);
    });
  });

  describe("concurrent claimers (S8)", () => {
    it("two workers racing for one task produce one execution and one lease", async () => {
      const a = await seedWorker({ host: "race-a" });
      const b = await seedWorker({ host: "race-b" });
      const repo = await seedRepo({ maxWorktrees: 5 });

      for (let round = 0; round < 10; round += 1) {
        const task = await seedTask({ state: "READY", repositoryId: repo });

        const results = await Promise.all([runClaim(a.id), runClaim(b.id)]);

        expect(results.filter((r) => r !== null)).toEqual([
          expect.objectContaining({ taskId: task }),
        ]);
        expect(await executionsFor(task)).toHaveLength(1);
        expect(await leasesFor(task)).toHaveLength(1);
        expect(await taskState(task)).toBe("IMPLEMENTING");
        // Free the claimer's slot for the next round.
        await raw("update executions set state = 'COMPLETED' where task_id = $1", [task]);
      }
    });

    it("the loser skips the locked task and claims the next one", async () => {
      const a = await seedWorker({ host: "race-c" });
      const b = await seedWorker({ host: "race-d" });
      const repo = await seedRepo({ maxWorktrees: 5 });
      const first = await seedTask({ state: "READY", repositoryId: repo, priority: 1 });
      const second = await seedTask({ state: "READY", repositoryId: repo, priority: 2 });

      // Holds only the first claimer inside its transaction, with the task
      // row locked, while the second runs. With SKIP LOCKED the second
      // finishes first; waiting on the lock would make it finish after.
      await raw(`create or replace function orchestra_test_slow() returns trigger
        language plpgsql as $$ begin perform pg_sleep(1); return new; end $$`);
      await raw(`create trigger orchestra_test_slow before insert on executions
        for each row when (new.host = 'race-c')
        execute function orchestra_test_slow()`);
      let results: Array<ClaimedExecution | null>;
      const finished: string[] = [];
      try {
        const slowFirst = runClaim(a.id).then((r) => {
          finished.push("a");
          return r;
        });
        // A separate connection pool so the second claim cannot queue
        // behind the first on a shared connection.
        const other = createDb(testDb.connectionString);
        try {
          await waitFor(
            async () => {
              const rows = (await raw(
                "select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'tasks' and l.mode = 'RowShareLock'",
              )) as Array<{ n: number }>;
              return rows[0]!.n > 0 ? true : undefined;
            },
            { what: "first claimer to lock the task", everyMs: 10 },
          );
          const second_ = claimNextTask({
            db: other,
            workerId: b.id,
            runtimes: ["claude"],
            now: NOW,
          }).then((r) => {
            finished.push("b");
            return r;
          });
          results = await Promise.all([slowFirst, second_]);
        } finally {
          await other.$client.end({ timeout: 5 });
        }
      } finally {
        await raw("drop trigger orchestra_test_slow on executions");
      }

      expect(finished).toEqual(["b", "a"]);
      expect(results[0]?.taskId).toBe(first);
      expect(results[1]?.taskId).toBe(second);
      for (const task of [first, second]) {
        expect(await executionsFor(task)).toHaveLength(1);
        expect(await leasesFor(task)).toHaveLength(1);
      }
    });
  });

  describe("onClaimed hand-off (S9, G1)", () => {
    it("is called exactly once, after commit, with the execution and task ids", async () => {
      const worker = await seedWorker();
      const repo = await seedRepo();
      const task = await seedTask({ state: "READY", repositoryId: repo });
      const observer = createDb(testDb.connectionString);
      const seen: Array<{ claim: ClaimedExecution; visible: boolean }> = [];
      try {
        const phase = createClaimPhase({
          runtimes: ["claude"],
          onClaimed: async (claim) => {
            // A different connection only sees committed rows.
            const row = await observer.query.executions.findFirst({
              where: (t, { eq }) => eq(t.id, claim.executionId),
            });
            seen.push({ claim, visible: row?.state === "ASSIGNED" });
          },
        });

        await phase.run(ctx(worker.id));
        await phase.run(ctx(worker.id));
        await waitFor(async () => (seen.length > 0 ? true : undefined), {
          what: "onClaimed",
        });
      } finally {
        await observer.$client.end({ timeout: 5 });
      }

      const [execution] = await executionsFor(task);
      expect(seen).toEqual([
        { claim: { executionId: execution!.id, taskId: task }, visible: true },
      ]);
    });

    it("claims at most one task per tick (G3)", async () => {
      const worker = await seedWorker({ maxConcurrent: 5 });
      const repo = await seedRepo({ maxWorktrees: 5 });
      await seedTask({ state: "READY", repositoryId: repo });
      await seedTask({ state: "READY", repositoryId: repo });
      const { calls, onClaimed } = recorder();

      await createClaimPhase({ runtimes: ["claude"], onClaimed }).run(ctx(worker.id));

      expect(calls).toHaveLength(1);
      const [row] = (await raw("select count(*)::int as n from executions")) as Array<{ n: number }>;
      expect(row!.n).toBe(1);
    });

    it("keeps the committed claim when the handler throws", async () => {
      const worker = await seedWorker();
      const repo = await seedRepo();
      const task = await seedTask({ state: "READY", repositoryId: repo });
      const phase = createClaimPhase({
        runtimes: ["claude"],
        onClaimed: () => {
          throw new Error("runner exploded");
        },
      });

      await expect(phase.run(ctx(worker.id))).resolves.toBeUndefined();

      expect(await taskState(task)).toBe("IMPLEMENTING");
      expect(
        records.some((r) => r.level === "error" && r.fields.taskId === task),
      ).toBe(true);
    });

    it("writes nothing without a handler, even with a claimable task", async () => {
      const worker = await seedWorker();
      const repo = await seedRepo();
      const task = await seedTask({ state: "READY", repositoryId: repo });
      const before = await writeSnapshot();

      const claim = createDefaultPhases({ runtimes: ["claude", "codex"] }).find(
        (p) => p.name === "claim",
      )!;
      await claim.run(ctx(worker.id));

      expect(await writeSnapshot()).toEqual(before);
      expect(await taskState(task)).toBe("READY");
    });
  });
});

describe("promotion then claim in one tick (design.md §6 order)", () => {
  it("claims a task promoted earlier in the same tick", async () => {
    const worker = await seedWorker();
    const repo = await seedRepo();
    const task = await seedTask({ state: "SPEC_APPROVED", repositoryId: repo });
    const { calls, onClaimed } = recorder();
    const phases = createDefaultPhases({ runtimes: ["claude"], onClaimed });

    for (const phase of phases) await phase.run(ctx(worker.id));

    expect(calls.map((c) => c.taskId)).toEqual([task]);
    expect(await taskState(task)).toBe("IMPLEMENTING");
  });
});
