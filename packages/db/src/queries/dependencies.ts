import type { TaskState } from "@orchestra/core";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { taskDependencies, tasks } from "../schema/tasks.js";
import type { DbOrTx, Tx } from "../transition.js";

/**
 * One dependency of a task, joined against the depended-on task's current
 * state (design.md §5.3: `SPEC_APPROVED -> READY/BLOCKED` reads exactly
 * this) so the api and the scheduler never need a second round trip.
 */
export interface DependencyRow {
  taskId: string;
  jiraKey: string;
  state: TaskState;
}

/** `task_dependencies` rows for `taskId`, ordered by the depended-on task's Jira key. */
export async function listDependencies(
  db: DbOrTx,
  taskId: string,
): Promise<DependencyRow[]> {
  const rows = await db
    .select({
      taskId: tasks.id,
      jiraKey: tasks.jiraKey,
      state: tasks.state,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(eq(taskDependencies.taskId, taskId))
    .orderBy(asc(tasks.jiraKey));

  return rows;
}

/**
 * Replaces every `task_dependencies` row for `taskId` with `dependsOnTaskIds`
 * (design.md §12.2 PATCH). Delete-then-insert inside the caller's
 * transaction, so a concurrent reader never observes a partial set.
 *
 * Deduped before insert: `(taskId, dependsOnTaskId)` is the primary key, so
 * a caller-supplied duplicate would otherwise hit a duplicate-key violation
 * and turn into a 500. The route also rejects duplicate Jira keys outright
 * (400), but this guards every other caller of `replaceDependencies` too.
 */
export async function replaceDependencies(
  tx: Tx,
  taskId: string,
  dependsOnTaskIds: string[],
): Promise<void> {
  await tx.delete(taskDependencies).where(eq(taskDependencies.taskId, taskId));
  const uniqueIds = [...new Set(dependsOnTaskIds)];
  if (uniqueIds.length === 0) {
    return;
  }
  await tx
    .insert(taskDependencies)
    .values(uniqueIds.map((dependsOnTaskId) => ({ taskId, dependsOnTaskId })));
}

/**
 * Fixed key for `pg_advisory_xact_lock`, used by `lockDependencyGraph`
 * below. Arbitrary: the only requirement is that every caller pass the same
 * constant, since the lock is keyed on this value, not on any row.
 */
const DEPENDENCY_GRAPH_LOCK_KEY = 847_302_559_104;

/**
 * Takes a transaction-scoped Postgres advisory lock (`pg_advisory_xact_lock`)
 * over the entire `task_dependencies` graph (design.md §12.2 PATCH). Call
 * this as the first statement of the PATCH transaction whenever the request
 * touches `dependencies`, before `setRuntimeOverride` and before
 * `wouldCreateCycle`. The lock releases automatically at COMMIT or ROLLBACK.
 *
 * Replaces the previous `lockTasksForUpdate`, which took `SELECT ... FOR
 * UPDATE` row locks on just `taskId` and its direct `dependsOn` ids. That
 * was broken two ways:
 *
 * - It ran after `setRuntimeOverride`'s `UPDATE tasks`, so two opposing
 *   PATCHes could row-lock in different orders and deadlock (Postgres
 *   40P01) instead of serialising.
 * - Two transactions with *disjoint* lock sets (task A locking {A, B}, task
 *   C locking {C, D}) could each pass `wouldCreateCycle` against a graph
 *   that did not yet include the other's edge and jointly commit a cycle
 *   neither one could see on its own (e.g. a four-node loop A->B->C->D->A).
 *
 * A single whole-graph lock has neither problem: it is not a row lock, so
 * there is no per-row acquisition order to deadlock on, and it admits only
 * one dependency-mutating PATCH at a time regardless of which tasks it
 * touches, so `wouldCreateCycle` always runs against the fully-committed
 * graph.
 */
export async function lockDependencyGraph(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${DEPENDENCY_GRAPH_LOCK_KEY})`,
  );
}

export interface ResolveTaskIdsByJiraKeyResult {
  /** Jira key -> task id, for every key that matched a task. */
  found: Map<string, string>;
  /** Keys with no matching task, in input order. */
  unknown: string[];
}

/** Resolves a list of Jira keys to task ids, reporting any that do not exist. */
export async function resolveTaskIdsByJiraKey(
  db: DbOrTx,
  keys: string[],
): Promise<ResolveTaskIdsByJiraKeyResult> {
  if (keys.length === 0) {
    return { found: new Map(), unknown: [] };
  }

  const rows = await db
    .select({ id: tasks.id, jiraKey: tasks.jiraKey })
    .from(tasks)
    .where(inArray(tasks.jiraKey, keys));

  const found = new Map(rows.map((row) => [row.jiraKey, row.id]));
  const unknown = keys.filter((key) => !found.has(key));
  return { found, unknown };
}

export interface CycleResult {
  /** Task ids around the cycle, starting and ending at `taskId`. */
  taskIds: string[];
  /** Same nodes, as Jira keys, for a readable error message. */
  jiraKeys: string[];
}

/**
 * Checks whether making `taskId` depend on every id in `dependsOnTaskIds`
 * would create a cycle in `task_dependencies` (design.md §4.2 ER diagram,
 * §12.2 PATCH). A self-dependency (`taskId` in `dependsOnTaskIds`) is
 * treated as a one-node cycle and rejected here too, even though the
 * database also has a `CHECK` constraint for it, so the api can return a
 * single consistent error shape instead of a raw constraint violation.
 *
 * Walks the existing graph with a bounded BFS from each candidate towards
 * `taskId`: if `taskId` is already reachable from a candidate by following
 * `depends_on` edges, adding `taskId -> candidate` would close a loop.
 * `visited` bounds the walk to the number of tasks that exist, so a
 * (supposedly impossible, since this function is what prevents them)
 * pre-existing cycle in the data cannot make this loop forever.
 */
export async function wouldCreateCycle(
  db: DbOrTx,
  taskId: string,
  dependsOnTaskIds: string[],
): Promise<CycleResult | null> {
  if (dependsOnTaskIds.length === 0) {
    return null;
  }

  for (const candidate of dependsOnTaskIds) {
    if (candidate === taskId) {
      return toCycleResult(db, [taskId, taskId]);
    }
  }

  const edges = await db
    .select({
      taskId: taskDependencies.taskId,
      dependsOnTaskId: taskDependencies.dependsOnTaskId,
    })
    .from(taskDependencies);

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.taskId) ?? [];
    list.push(edge.dependsOnTaskId);
    adjacency.set(edge.taskId, list);
  }

  for (const candidate of dependsOnTaskIds) {
    const path = findPath(adjacency, candidate, taskId);
    if (path) {
      return toCycleResult(db, [taskId, ...path]);
    }
  }

  return null;
}

/** Shortest path from `from` to `to` following `depends_on` edges, or null. */
function findPath(
  adjacency: Map<string, string[]>,
  from: string,
  to: string,
): string[] | null {
  const queue: string[][] = [[from]];
  const visited = new Set<string>([from]);

  while (queue.length > 0) {
    const path = queue.shift()!;
    const node = path[path.length - 1]!;
    if (node === to) {
      return path;
    }
    for (const next of adjacency.get(node) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...path, next]);
      }
    }
  }

  return null;
}

async function toCycleResult(
  db: DbOrTx,
  taskIds: string[],
): Promise<CycleResult> {
  const uniqueIds = [...new Set(taskIds)];
  const rows = await db
    .select({ id: tasks.id, jiraKey: tasks.jiraKey })
    .from(tasks)
    .where(inArray(tasks.id, uniqueIds));
  const byId = new Map(rows.map((row) => [row.id, row.jiraKey]));
  return {
    taskIds,
    jiraKeys: taskIds.map((id) => byId.get(id) ?? id),
  };
}

/** Sets `tasks.runtime_override` directly (design.md §12.2 PATCH, §18). */
export async function setRuntimeOverride(
  tx: Tx,
  taskId: string,
  runtimeOverride: "claude" | "codex" | null,
): Promise<void> {
  await tx
    .update(tasks)
    .set({ runtimeOverride, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
}
