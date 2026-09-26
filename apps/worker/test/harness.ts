import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type {
  EndReason,
  ExecutionState,
  Runtime,
  TaskState,
} from "@orchestra/core";
import {
  agentWorkers,
  createDb,
  executions,
  projects,
  repositories,
  runMigrations,
  specificationRevisions,
  tasks,
  type Db,
} from "@orchestra/db";

export interface TestDb {
  /** Drizzle client, the same type `createDb` hands back. */
  db: Db;
  connectionString: string;
  stop(): Promise<void>;
}

/**
 * Starts a throwaway `postgres:17` container and applies the committed
 * migrations. Mirrors `packages/db/test/harness.ts` deliberately: the worker
 * copies the pattern rather than importing test files across packages.
 * `vitest.config.ts` disables file parallelism so containers never race.
 */
export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer =
    await new PostgreSqlContainer("postgres:17").start();
  const connectionString = container.getConnectionUri();
  await runMigrations(connectionString);
  const db = createDb(connectionString);
  return {
    db,
    connectionString,
    async stop() {
      await db.$client.end({ timeout: 5 });
      await container.stop();
    },
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns a value, or throws after `timeoutMs`. */
export async function waitFor<T>(
  check: () => Promise<T | undefined>,
  { timeoutMs = 10000, everyMs = 100, what = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(everyMs);
  }
}

// ------------------------------------------------------------ seed helpers

/** Approved specification content every seeded task runs against. */
export const SEED_SPEC = {
  repository: "repo",
  objective: "Make receipts print in the device language",
  scope: ["receipt printer"],
  out_of_scope: ["email receipts"],
  requirements: ["use device locale"],
  acceptance_criteria: ["receipt uses locale"],
  validation: ["unit test"],
  constraints: ["no new deps"],
  dependencies: [],
};

let seedSeq = 0;

/**
 * Inserts the `agent_workers` row for `host`, or returns the existing one.
 */
export async function seedWorkerRow(
  db: Db,
  options: {
    host: string;
    maxConcurrent?: number;
    capabilities?: string[];
    workspaceRoot?: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(agentWorkers)
    .values({
      host: options.host,
      capabilities: options.capabilities ?? [],
      maxConcurrent: options.maxConcurrent ?? 4,
      workspaceRoot: options.workspaceRoot ?? "/tmp/orchestra",
    })
    .onConflictDoNothing()
    .returning({ id: agentWorkers.id });
  if (row) return row.id;
  const existing = await db.query.agentWorkers.findFirst({
    where: (w, { eq }) => eq(w.host, options.host),
  });
  return existing!.id;
}

export interface SeededTask {
  projectId: string;
  repositoryId: string;
  repositoryName: string;
  taskId: string;
  jiraKey: string;
  revisionId: string;
}

/** A project, repository, task in `taskState` and its approved revision. */
export async function seedTaskRow(
  db: Db,
  options: {
    taskState?: TaskState;
    maxInfraRetries?: number;
    maxProtocolRetries?: number;
    requiredCapability?: string | null;
    maxConcurrentWorktrees?: number;
    runtime?: Runtime;
    needsHumanReason?: string | null;
  } = {},
): Promise<SeededTask> {
  const n = ++seedSeq;
  const now = new Date("2026-09-25T10:00:00.000Z");
  const [project] = await db
    .insert(projects)
    .values({
      key: `RTY${n}`,
      name: `retry ${n}`,
      jiraJql: `project = RTY${n}`,
      ...(options.maxInfraRetries !== undefined
        ? { maxInfraRetries: options.maxInfraRetries }
        : {}),
      ...(options.maxProtocolRetries !== undefined
        ? { maxProtocolRetries: options.maxProtocolRetries }
        : {}),
    })
    .returning({ id: projects.id });
  const repositoryName = `retry-repo-${n}`;
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: repositoryName,
      gitUrl: `git@example.com:${repositoryName}.git`,
      defaultBranch: "main",
      defaultRuntime: options.runtime ?? "claude",
      defaultModel: "claude-opus-test",
      maxConcurrentWorktrees: options.maxConcurrentWorktrees ?? 4,
      requiredCapability: options.requiredCapability ?? null,
    })
    .returning({ id: repositories.id });
  const jiraKey = `RTY-${n}`;
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project!.id,
      repositoryId: repo!.id,
      jiraKey,
      jiraSummary: `Retry task ${n}`,
      jiraPriority: 1,
      jiraCreatedAt: now,
      jiraSyncedAt: now,
      state: options.taskState ?? "IMPLEMENTING",
      needsHumanReason: options.needsHumanReason ?? null,
    })
    .returning({ id: tasks.id });
  const [revision] = await db
    .insert(specificationRevisions)
    .values({ taskId: task!.id, version: 2, status: "approved", content: SEED_SPEC })
    .returning({ id: specificationRevisions.id });
  await db.$client.unsafe(
    "update tasks set approved_revision_id = $1 where id = $2",
    [revision!.id, task!.id],
  );
  return {
    projectId: project!.id,
    repositoryId: repo!.id,
    repositoryName,
    taskId: task!.id,
    jiraKey,
    revisionId: revision!.id,
  };
}

/** One `executions` row with the given columns. */
export async function seedExecutionRow(
  db: Db,
  options: {
    taskId: string;
    state: ExecutionState;
    role?: "spec" | "implementation";
    attempt?: number;
    runtime?: Runtime;
    specRevisionId?: string | null;
    workerId?: string | null;
    host?: string | null;
    sessionId?: string | null;
    branch?: string | null;
    worktreePath?: string | null;
    infraRetriesUsed?: number;
    endReason?: EndReason | null;
    endDetail?: string | null;
    endedAt?: Date | null;
  },
): Promise<string> {
  const [row] = await db
    .insert(executions)
    .values({
      taskId: options.taskId,
      role: options.role ?? "implementation",
      attempt: options.attempt ?? 1,
      state: options.state,
      runtime: options.runtime ?? "claude",
      model: "claude-opus-test",
      specRevisionId: options.specRevisionId ?? null,
      workerId: options.workerId ?? null,
      host: options.host ?? null,
      sessionId: options.sessionId ?? null,
      branch: options.branch ?? null,
      worktreePath: options.worktreePath ?? null,
      infraRetriesUsed: options.infraRetriesUsed ?? 0,
      endReason: options.endReason ?? null,
      endDetail: options.endDetail ?? null,
      endedAt: options.endedAt ?? null,
    })
    .returning({ id: executions.id });
  return row!.id;
}
