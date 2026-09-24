import {
  agentWorkers,
  executions,
  projects,
  repositories,
  tasks,
  type Db,
} from "@orchestra/db";

/**
 * Seed helpers for the admin routes tests (`admin.test.ts`). Own file per
 * GOT.20's `owned_paths`: `apps/api/test/harness.ts` is out of scope (it is
 * shared with the concurrent GOT.21 task), so these do not touch it.
 */

export interface SeedProjectOptions {
  key: string;
  name?: string;
}

export interface SeededProject {
  id: string;
  key: string;
}

export async function seedProject(
  db: Db,
  options: SeedProjectOptions,
): Promise<SeededProject> {
  const [row] = await db
    .insert(projects)
    .values({
      key: options.key,
      name: options.name ?? `${options.key} project`,
      jiraJql: `project = ${options.key}`,
    })
    .returning({ id: projects.id, key: projects.key });
  if (!row) throw new Error("seedProject: insert returned no row");
  return row;
}

export interface SeedRepositoryOptions {
  projectId: string;
  name?: string;
}

export interface SeededRepository {
  id: string;
  projectId: string;
  name: string;
}

export async function seedRepository(
  db: Db,
  options: SeedRepositoryOptions,
): Promise<SeededRepository> {
  const [row] = await db
    .insert(repositories)
    .values({
      projectId: options.projectId,
      name: options.name ?? "seed-repo",
      gitUrl: "git@example.com:goopter/seed-repo.git",
      defaultBranch: "main",
      defaultRuntime: "claude",
    })
    .returning({
      id: repositories.id,
      projectId: repositories.projectId,
      name: repositories.name,
    });
  if (!row) throw new Error("seedRepository: insert returned no row");
  return row;
}

export interface SeedTaskOptions {
  projectId: string;
  repositoryId?: string | null;
  jiraKey: string;
}

export async function seedTask(
  db: Db,
  options: SeedTaskOptions,
): Promise<{ id: string }> {
  const when = new Date("2026-01-01T00:00:00Z");
  const [row] = await db
    .insert(tasks)
    .values({
      projectId: options.projectId,
      repositoryId: options.repositoryId ?? null,
      jiraKey: options.jiraKey,
      jiraSummary: `Summary for ${options.jiraKey}`,
      jiraPriority: 3,
      jiraCreatedAt: when,
      jiraSyncedAt: when,
      state: "NEEDS_SPEC",
    })
    .returning({ id: tasks.id });
  if (!row) throw new Error("seedTask: insert returned no row");
  return row;
}

export interface SeedAgentWorkerOptions {
  host: string;
  maxConcurrent: number;
  lastHeartbeatAt: Date;
}

export async function seedAgentWorker(
  db: Db,
  options: SeedAgentWorkerOptions,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(agentWorkers)
    .values({
      host: options.host,
      capabilities: ["node"],
      maxConcurrent: options.maxConcurrent,
      workspaceRoot: "/srv/orchestra",
      lastHeartbeatAt: options.lastHeartbeatAt,
      startedAt: options.lastHeartbeatAt,
    })
    .returning({ id: agentWorkers.id });
  if (!row) throw new Error("seedAgentWorker: insert returned no row");
  return row;
}

export interface SeedExecutionOptions {
  taskId: string;
  host: string;
  state: "RUNNING" | "COMPLETED";
}

/** Inserts one execution already assigned to `host` (no `UPDATE` needed). */
export async function seedExecutionOnHost(
  db: Db,
  options: SeedExecutionOptions,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(executions)
    .values({
      taskId: options.taskId,
      role: "implementation",
      attempt: 1,
      state: options.state,
      runtime: "claude",
      model: "claude-sonnet-5",
      host: options.host,
    })
    .returning({ id: executions.id });
  if (!row) throw new Error("seedExecutionOnHost: insert returned no row");
  return row;
}
