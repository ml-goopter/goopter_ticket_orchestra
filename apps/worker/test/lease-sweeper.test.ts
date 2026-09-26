import type { ExecutionState, TaskState } from "@orchestra/core";
import {
  agentWorkers,
  executions,
  projects,
  taskLeases,
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
import { loadConfig } from "../src/config.js";
import type { LogFields, Logger } from "../src/logger.js";
import { createDefaultPhases } from "../src/phases/index.js";
import {
  DEAD_HOST_AFTER_MS,
  createLeaseSweeperPhase,
  type ExpiredLease,
} from "../src/sweeper/index.js";
import type { TickContext } from "../src/tick.js";
import { startTestDb, type TestDb } from "./harness.js";

/**
 * design.md §6.5 lease sweeper and the §6.1 dead-host command release,
 * against a real Postgres. The phase's `now` is the fake clock: nothing
 * here depends on the wall clock. Reads use drizzle's relational API on the
 * `Db` handle and raw SQL through postgres-js, because `apps/**` may not
 * import drizzle-orm.
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
const MINUTE = 60 * 1000;
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

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
  options: { heartbeatAt?: Date } = {},
): Promise<{ id: string; host: string }> {
  const host = `sweep-host-${++seq}`;
  const [row] = await db
    .insert(agentWorkers)
    .values({
      host,
      capabilities: ["node"],
      maxConcurrent: 2,
      workspaceRoot: "/tmp/orchestra",
      lastHeartbeatAt: options.heartbeatAt ?? NOW,
    })
    .returning({ id: agentWorkers.id });
  return { id: row!.id, host };
}

async function seedTask(state: TaskState = "IMPLEMENTING"): Promise<string> {
  const n = ++seq;
  const [project] = await db
    .insert(projects)
    .values({ key: `SWP${n}`, name: `sweep ${n}`, jiraJql: `project = SWP${n}` })
    .returning({ id: projects.id });
  const [row] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      jiraKey: `SWP-${n}`,
      jiraSummary: `task ${n}`,
      jiraPriority: 3,
      jiraCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
      jiraSyncedAt: NOW,
      state,
    })
    .returning({ id: tasks.id });
  return row!.id;
}

async function seedExecution(options: {
  taskId: string;
  state: ExecutionState;
  worker?: { id: string; host: string } | null;
}): Promise<string> {
  const [row] = await db
    .insert(executions)
    .values({
      taskId: options.taskId,
      role: "implementation",
      attempt: 1,
      state: options.state,
      runtime: "claude",
      model: "claude-opus",
      workerId: options.worker?.id ?? null,
      host: options.worker?.host ?? null,
      worktreePath: "/tmp/orchestra/wt",
      branch: "orchestra/branch",
      // A live agent-tools token (§8), unique per row.
      toolsTokenHash: `token-hash-${++seq}`,
    })
    .returning({ id: executions.id });
  return row!.id;
}

async function seedLease(
  taskId: string,
  executionId: string,
  workerId: string,
  expiresAt: Date,
): Promise<string> {
  const [row] = await db
    .insert(taskLeases)
    .values({ taskId, executionId, workerId, acquiredAt: at(-10 * MINUTE), expiresAt })
    .returning({ id: taskLeases.id });
  return row!.id;
}

/** A task in `taskState` with one execution in `state` and a lease. */
async function seedLeased(options: {
  state: ExecutionState;
  worker: { id: string; host: string };
  expiresAt: Date;
  taskState?: TaskState;
}) {
  const taskId = await seedTask(options.taskState);
  const executionId = await seedExecution({
    taskId,
    state: options.state,
    worker: options.worker,
  });
  const leaseId = await seedLease(
    taskId,
    executionId,
    options.worker.id,
    options.expiresAt,
  );
  return { taskId, executionId, leaseId };
}

const execution = async (id: string) =>
  (await db.query.executions.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
const taskState = async (id: string) =>
  (await db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!
    .state;
const leasesFor = (taskId: string) =>
  db.query.taskLeases.findMany({ where: (t, { eq }) => eq(t.taskId, taskId) });
const auditFor = (entityId: string) =>
  db.query.auditEvents.findMany({
    where: (t, { eq }) => eq(t.entityId, entityId),
    orderBy: (t, { asc }) => [asc(t.id)],
  });
const eventsFor = (executionId: string) =>
  db.query.executionEvents.findMany({
    where: (t, { eq }) => eq(t.executionId, executionId),
    orderBy: (t, { asc }) => [asc(t.id)],
  });

const config = loadConfig({ DATABASE_URL: "postgres://localhost/unused" });

function ctx(workerId: string, now: Date = NOW): TickContext {
  return { db, workerId, config, now, tick: 1, logger };
}

/** The sweeping worker: a fresh heartbeat, so it is never dead itself. */
const sweeper = () => seedWorker();

async function expectSwept(
  ids: { taskId: string; executionId: string },
  sweeperId: string,
  leaseWorkerId: string,
  taskBefore: TaskState,
): Promise<void> {
  const row = await execution(ids.executionId);
  expect(row.state).toBe("FAILED");
  expect(row.endReason).toBe("lease_expired");
  expect(row.endedAt?.toISOString()).toBe(NOW.toISOString());
  expect(row.endDetail).toContain(leaseWorkerId);
  expect(row.endDetail).toContain("expired");
  // §8: the token is revoked when the execution leaves RUNNING.
  expect(row.toolsTokenHash).toBeNull();
  // §6.5: the worktree stays on the dead host.
  expect(row.worktreePath).toBe("/tmp/orchestra/wt");
  expect(row.branch).toBe("orchestra/branch");

  const audit = await auditFor(ids.executionId);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    entityType: "execution",
    toState: "FAILED",
    trigger: "execution.failed",
    actorKind: "worker",
    actorId: sweeperId,
  });

  const failed = (await eventsFor(ids.executionId)).filter(
    (e) => e.type === "execution.failed",
  );
  expect(failed).toHaveLength(1);

  expect(await leasesFor(ids.taskId)).toHaveLength(0);
  // Q10: the retry policy (GOT.43) owns the task; the sweeper leaves it.
  expect(await taskState(ids.taskId)).toBe(taskBefore);
  expect(await auditFor(ids.taskId)).toHaveLength(0);
}

// ----------------------------------------------------------- lease sweeper

describe("lease sweeper (design.md §6.5)", () => {
  it("AC1 fails a RUNNING execution whose lease expired and deletes the lease", async () => {
    const me = await sweeper();
    const dead = await seedWorker({ heartbeatAt: at(-3 * MINUTE) });
    const ids = await seedLeased({
      state: "RUNNING",
      worker: dead,
      expiresAt: at(-1),
    });

    await createLeaseSweeperPhase().run(ctx(me.id));

    await expectSwept(ids, me.id, dead.id, "IMPLEMENTING");
    const warn = records.find(
      (r) => r.level === "warn" && r.fields.executionId === ids.executionId,
    );
    expect(warn?.msg).toMatch(/retry policy/);
    expect(warn?.fields.taskId).toBe(ids.taskId);
  });

  it("AC2 fails an ASSIGNED execution whose lease expired", async () => {
    const me = await sweeper();
    const dead = await seedWorker();
    const ids = await seedLeased({
      state: "ASSIGNED",
      worker: dead,
      expiresAt: at(-5 * MINUTE),
      taskState: "IMPLEMENTING",
    });

    await createLeaseSweeperPhase().run(ctx(me.id));

    await expectSwept(ids, me.id, dead.id, "IMPLEMENTING");
    const audit = await auditFor(ids.executionId);
    expect(audit[0]!.fromState).toBe("ASSIGNED");
  });

  it("AC3 leaves an expired lease alone when its execution is WAITING_FOR_USER or COMPLETED", async () => {
    const me = await sweeper();
    const other = await seedWorker();
    const waiting = await seedLeased({
      state: "WAITING_FOR_USER",
      worker: other,
      expiresAt: at(-10 * MINUTE),
    });
    const completed = await seedLeased({
      state: "COMPLETED",
      worker: other,
      expiresAt: at(-10 * MINUTE),
      taskState: "CI_RUNNING",
    });

    await createLeaseSweeperPhase().run(ctx(me.id));

    expect((await execution(waiting.executionId)).state).toBe("WAITING_FOR_USER");
    expect((await execution(completed.executionId)).state).toBe("COMPLETED");
    expect(await leasesFor(waiting.taskId)).toHaveLength(1);
    expect(await leasesFor(completed.taskId)).toHaveLength(1);
    expect(await auditFor(waiting.executionId)).toHaveLength(0);
    expect(await auditFor(completed.executionId)).toHaveLength(0);
  });

  it("AC4 leaves an unexpired lease alone, including one expiring exactly now", async () => {
    const me = await sweeper();
    const other = await seedWorker();
    const future = await seedLeased({
      state: "RUNNING",
      worker: other,
      expiresAt: at(2 * MINUTE),
    });
    const boundary = await seedLeased({
      state: "RUNNING",
      worker: other,
      expiresAt: NOW,
    });

    await createLeaseSweeperPhase().run(ctx(me.id));

    for (const ids of [future, boundary]) {
      expect((await execution(ids.executionId)).state).toBe("RUNNING");
      expect(await leasesFor(ids.taskId)).toHaveLength(1);
      expect(await auditFor(ids.executionId)).toHaveLength(0);
    }
  });

  it("AC5 leaves a lease renewed between the select and the lock", async () => {
    const me = await sweeper();
    const other = await seedWorker();
    const ids = await seedLeased({
      state: "RUNNING",
      worker: other,
      expiresAt: at(-1 * MINUTE),
    });
    const renewed = at(5 * MINUTE);

    const seen: ExpiredLease[] = [];
    const phase = createLeaseSweeperPhase({
      // The runner's §6.4 renewal commits after the select, before the lock.
      beforeLock: async (lease) => {
        seen.push(lease);
        await raw("update task_leases set expires_at = $1 where id = $2", [
          renewed.toISOString(),
          lease.leaseId,
        ]);
      },
    });
    await phase.run(ctx(me.id));

    expect(seen.map((l) => l.leaseId)).toEqual([ids.leaseId]);
    expect((await execution(ids.executionId)).state).toBe("RUNNING");
    const [lease] = await leasesFor(ids.taskId);
    expect(lease?.expiresAt.toISOString()).toBe(renewed.toISOString());
    expect(await auditFor(ids.executionId)).toHaveLength(0);
    // Left alone by the re-check, not by the error path.
    expect(records.filter((r) => r.level === "error")).toEqual([]);
  });

  it("AC5 leaves a lease whose execution ended between the select and the lock", async () => {
    const me = await sweeper();
    const other = await seedWorker();
    const ids = await seedLeased({
      state: "RUNNING",
      worker: other,
      expiresAt: at(-1 * MINUTE),
    });

    await createLeaseSweeperPhase({
      beforeLock: async () => {
        await raw("update executions set state = 'COMPLETED' where id = $1", [
          ids.executionId,
        ]);
      },
    }).run(ctx(me.id));

    expect((await execution(ids.executionId)).state).toBe("COMPLETED");
    expect(await leasesFor(ids.taskId)).toHaveLength(1);
    expect(await auditFor(ids.executionId)).toHaveLength(0);
    expect(records.filter((r) => r.level === "error")).toEqual([]);
  });

  it("skips a lease whose task row another transaction holds, without blocking", async () => {
    const me = await sweeper();
    const other = await seedWorker();
    const ids = await seedLeased({
      state: "RUNNING",
      worker: other,
      expiresAt: at(-1 * MINUTE),
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.$client.begin(async (sql) => {
      await sql`select id from tasks where id = ${ids.taskId} for update`;
      locked();
      await held;
    });
    await isLocked;

    try {
      await createLeaseSweeperPhase().run(ctx(me.id));
    } finally {
      release();
      await holder;
    }

    expect((await execution(ids.executionId)).state).toBe("RUNNING");
    expect(await leasesFor(ids.taskId)).toHaveLength(1);
    expect(records.filter((r) => r.level === "error")).toEqual([]);

    // The next tick, with the lock gone, sweeps it.
    await createLeaseSweeperPhase().run(ctx(me.id));
    expect((await execution(ids.executionId)).state).toBe("FAILED");
  });

  it("AC8 a failure on one lease is logged and the next lease is still swept", async () => {
    const me = await sweeper();
    const other = await seedWorker();
    const broken = await seedLeased({
      state: "RUNNING",
      worker: other,
      expiresAt: at(-10 * MINUTE),
    });
    const good = await seedLeased({
      state: "RUNNING",
      worker: other,
      expiresAt: at(-1 * MINUTE),
    });

    const order: string[] = [];
    await createLeaseSweeperPhase({
      beforeLock: async (lease) => {
        order.push(lease.executionId);
        if (lease.executionId === broken.executionId) {
          throw new Error("forced failure");
        }
      },
    }).run(ctx(me.id));

    expect(order).toEqual([broken.executionId, good.executionId]);
    expect((await execution(broken.executionId)).state).toBe("RUNNING");
    expect(await leasesFor(broken.taskId)).toHaveLength(1);
    await expectSwept(good, me.id, other.id, "IMPLEMENTING");

    const error = records.find((r) => r.level === "error");
    expect(error?.fields.executionId).toBe(broken.executionId);
    expect(String(error?.fields.err)).toContain("forced failure");
  });

  it("a second run sweeps nothing more", async () => {
    const me = await sweeper();
    const other = await seedWorker();
    const ids = await seedLeased({
      state: "RUNNING",
      worker: other,
      expiresAt: at(-1 * MINUTE),
    });

    await createLeaseSweeperPhase().run(ctx(me.id));
    await createLeaseSweeperPhase().run(ctx(me.id, at(MINUTE)));

    await expectSwept(ids, me.id, other.id, "IMPLEMENTING");
  });
});

// ------------------------------------------------------ dead-host release

describe("dead-host command release (design.md §6.1)", () => {
  it("defines a dead host as 15 minutes without a heartbeat", () => {
    expect(DEAD_HOST_AFTER_MS).toBe(15 * 60 * 1000);
  });

  it("AC6 releases WAITING_FOR_USER and COMPLETED executions on a dead host only", async () => {
    const me = await sweeper();
    const dead = await seedWorker({ heartbeatAt: at(-16 * MINUTE) });
    const alive = await seedWorker({ heartbeatAt: at(-5 * MINUTE) });

    const waitingDead = await seedExecution({
      taskId: await seedTask(),
      state: "WAITING_FOR_USER",
      worker: dead,
    });
    const completedDead = await seedExecution({
      taskId: await seedTask("CI_RUNNING"),
      state: "COMPLETED",
      worker: dead,
    });
    const waitingAlive = await seedExecution({
      taskId: await seedTask(),
      state: "WAITING_FOR_USER",
      worker: alive,
    });
    // RUNNING on the dead host with an unexpired lease: the lease pass
    // leaves it, and this pass must not touch it either.
    const running = await seedLeased({
      state: "RUNNING",
      worker: dead,
      expiresAt: at(MINUTE),
    });
    const failedDead = await seedExecution({
      taskId: await seedTask(),
      state: "FAILED",
      worker: dead,
    });

    await createLeaseSweeperPhase().run(ctx(me.id));

    for (const id of [waitingDead, completedDead]) {
      const row = await execution(id);
      expect(row.host).toBeNull();
      expect(row.workerId).toBeNull();
      // Release is not a state move, so it revokes no token.
      expect(row.toolsTokenHash).not.toBeNull();
      // Release is not a state move and writes no event (§6.1).
      expect(await auditFor(id)).toHaveLength(0);
      expect(await eventsFor(id)).toHaveLength(0);
    }
    expect((await execution(waitingDead)).state).toBe("WAITING_FOR_USER");
    expect((await execution(completedDead)).state).toBe("COMPLETED");
    expect((await execution(waitingDead)).worktreePath).toBe("/tmp/orchestra/wt");

    for (const [id, worker] of [
      [waitingAlive, alive],
      [running.executionId, dead],
      [failedDead, dead],
    ] as const) {
      const row = await execution(id);
      expect(row.host).toBe(worker.host);
      expect(row.workerId).toBe(worker.id);
    }
    expect((await execution(running.executionId)).state).toBe("RUNNING");

    const info = records.filter(
      (r) => r.level === "info" && r.fields.host === dead.host,
    );
    expect(info.map((r) => r.fields.executionId).sort()).toEqual(
      [waitingDead, completedDead].sort(),
    );

    // Idempotent: a second run releases nothing and logs no release.
    records.length = 0;
    const before = await raw(
      "select id, host, worker_id, state from executions order by id",
    );
    await createLeaseSweeperPhase().run(ctx(me.id));
    expect(
      await raw("select id, host, worker_id, state from executions order by id"),
    ).toEqual(before);
    expect(records.filter((r) => r.fields.executionId !== undefined)).toEqual([]);
  });

  it("treats exactly 15 minutes without a heartbeat as alive", async () => {
    const me = await sweeper();
    const edge = await seedWorker({ heartbeatAt: at(-DEAD_HOST_AFTER_MS) });
    const id = await seedExecution({
      taskId: await seedTask(),
      state: "WAITING_FOR_USER",
      worker: edge,
    });

    await createLeaseSweeperPhase().run(ctx(me.id));

    expect((await execution(id)).host).toBe(edge.host);
  });

  it("leaves an execution whose host heartbeated between the dead-host select and the update", async () => {
    const me = await sweeper();
    const dead = await seedWorker({ heartbeatAt: at(-16 * MINUTE) });
    const id = await seedExecution({
      taskId: await seedTask(),
      state: "WAITING_FOR_USER",
      worker: dead,
    });

    const seen: string[] = [];
    await createLeaseSweeperPhase({
      // The dead host comes back: its heartbeat commits after the select.
      beforeRelease: async (candidate) => {
        seen.push(candidate.executionId);
        await raw("update agent_workers set last_heartbeat_at = $1 where id = $2", [
          NOW.toISOString(),
          dead.id,
        ]);
      },
    }).run(ctx(me.id));

    expect(seen).toEqual([id]);
    const row = await execution(id);
    expect(row.host).toBe(dead.host);
    expect(row.workerId).toBe(dead.id);
    expect(records.filter((r) => r.fields.executionId === id)).toEqual([]);
  });

  it("leaves an execution that moved to RUNNING between the dead-host select and the update", async () => {
    const me = await sweeper();
    const dead = await seedWorker({ heartbeatAt: at(-16 * MINUTE) });
    const id = await seedExecution({
      taskId: await seedTask(),
      state: "WAITING_FOR_USER",
      worker: dead,
    });

    const seen: string[] = [];
    await createLeaseSweeperPhase({
      // A resume commits the move to RUNNING after the select.
      beforeRelease: async (candidate) => {
        seen.push(candidate.executionId);
        await raw("update executions set state = 'RUNNING' where id = $1", [id]);
      },
    }).run(ctx(me.id));

    expect(seen).toEqual([id]);
    const row = await execution(id);
    expect(row.state).toBe("RUNNING");
    expect(row.host).toBe(dead.host);
    expect(row.workerId).toBe(dead.id);
    expect(records.filter((r) => r.fields.executionId === id)).toEqual([]);
  });

  it("AC7 never releases this worker's own executions, even with a stale heartbeat row", async () => {
    const me = await seedWorker({ heartbeatAt: at(-60 * MINUTE) });
    const id = await seedExecution({
      taskId: await seedTask(),
      state: "WAITING_FOR_USER",
      worker: me,
    });

    await createLeaseSweeperPhase().run(ctx(me.id));

    const row = await execution(id);
    expect(row.host).toBe(me.host);
    expect(row.workerId).toBe(me.id);
  });
});

// --------------------------------------------------------------- registry

describe("phase registry (AC9)", () => {
  it("registers the lease sweeper in its slot, every tick, and it sweeps", async () => {
    const phases = createDefaultPhases();
    const phase = phases.find((p) => p.name === "lease_sweeper")!;
    expect(phases.map((p) => p.name).indexOf("lease_sweeper")).toBe(
      phases.map((p) => p.name).indexOf("claim") + 1,
    );
    expect(phase.every ?? 1).toBe(1);

    const me = await sweeper();
    const other = await seedWorker();
    const ids = await seedLeased({
      state: "RUNNING",
      worker: other,
      expiresAt: at(-1),
    });
    await phase.run(ctx(me.id));
    await expectSwept(ids, me.id, other.id, "IMPLEMENTING");
  });
});
