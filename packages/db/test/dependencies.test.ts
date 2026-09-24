import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ZERO_TASK_COST,
  getTaskAggregate,
  listActiveExecutionIds,
  listBoardRuntimes,
  listDependencies,
  lockDependencyGraph,
  replaceDependencies,
  resolveProjectFilter,
  resolveTaskIdsByJiraKey,
  setRuntimeOverride,
  sumTaskCost,
  wouldCreateCycle,
} from "../src/queries/index.js";
import * as schema from "../src/schema/index.js";
import {
  seedExecution,
  seedFixtures,
  seedTask,
  sleep,
  startTestDb,
  type Fixtures,
  type TestDb,
} from "./harness.js";

let h: TestDb;
let fx: Fixtures;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await startTestDb();
  fx = await seedFixtures(h.db, "DEP");

  ids.a = await seedTask(h.db, fx, { jiraKey: "DEP-A", state: "READY" });
  ids.b = await seedTask(h.db, fx, { jiraKey: "DEP-B", state: "READY" });
  ids.c = await seedTask(h.db, fx, { jiraKey: "DEP-C", state: "DONE" });
  ids.noRepo = await seedTask(h.db, fx, {
    jiraKey: "DEP-D",
    state: "NEEDS_SPEC",
    withRepository: false,
  });

  // A depends on C, to exercise listDependencies/replaceDependencies.
  await h.db
    .insert(schema.taskDependencies)
    .values({ taskId: ids.a!, dependsOnTaskId: ids.c! });

  // Cost fixtures: two executions on A.
  ids.aExec1 = await seedExecution(h.db, ids.a!, { state: "COMPLETED" });
  ids.aExec2 = await seedExecution(h.db, ids.a!, {
    state: "COMPLETED",
    attempt: 2,
  });
  await h.db
    .update(schema.executions)
    .set({
      costUsd: "1.500000",
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 50,
    })
    .where(eq(schema.executions.id, ids.aExec1!));
  await h.db
    .update(schema.executions)
    .set({
      costUsd: "0.250000",
      inputTokens: 20,
      cachedInputTokens: 0,
      outputTokens: 5,
    })
    .where(eq(schema.executions.id, ids.aExec2!));

  ids.aWaiting = await seedExecution(h.db, ids.a!, {
    state: "WAITING_FOR_USER",
    attempt: 3,
  });
  ids.aQueued = await seedExecution(h.db, ids.a!, {
    state: "QUEUED",
    attempt: 4,
  });

  await h.db
    .update(schema.tasks)
    .set({ runtimeOverride: "codex" })
    .where(eq(schema.tasks.id, ids.b!));
}, 180000);

afterAll(async () => {
  await h?.stop();
});

describe("listDependencies / replaceDependencies", () => {
  it("returns the depended-on task with its jira key and state", async () => {
    const rows = await listDependencies(h.db, ids.a!);
    expect(rows).toEqual([{ taskId: ids.c, jiraKey: "DEP-C", state: "DONE" }]);
  });

  it("replaces the full set atomically", async () => {
    await h.db.transaction(async (tx) => {
      await replaceDependencies(tx, ids.a!, [ids.b!]);
    });
    const rows = await listDependencies(h.db, ids.a!);
    expect(rows).toEqual([{ taskId: ids.b, jiraKey: "DEP-B", state: "READY" }]);

    // restore original dependency set for later tests
    await h.db.transaction(async (tx) => {
      await replaceDependencies(tx, ids.a!, [ids.c!]);
    });
  });

  it("dedupes duplicate dependsOnTaskIds instead of a duplicate-key insert", async () => {
    await h.db.transaction(async (tx) => {
      await replaceDependencies(tx, ids.a!, [ids.b!, ids.b!]);
    });
    expect(await listDependencies(h.db, ids.a!)).toEqual([
      { taskId: ids.b, jiraKey: "DEP-B", state: "READY" },
    ]);

    // restore original dependency set for later tests
    await h.db.transaction(async (tx) => {
      await replaceDependencies(tx, ids.a!, [ids.c!]);
    });
  });

  it("clears all dependencies when given an empty list", async () => {
    await h.db.transaction(async (tx) => {
      await replaceDependencies(tx, ids.b!, [ids.c!]);
    });
    expect(await listDependencies(h.db, ids.b!)).toHaveLength(1);

    await h.db.transaction(async (tx) => {
      await replaceDependencies(tx, ids.b!, []);
    });
    expect(await listDependencies(h.db, ids.b!)).toEqual([]);
  });
});

describe("resolveTaskIdsByJiraKey", () => {
  it("resolves known keys and reports unknown ones", async () => {
    const result = await resolveTaskIdsByJiraKey(h.db, [
      "DEP-A",
      "DEP-NOPE",
      "DEP-C",
    ]);
    expect(result.found.get("DEP-A")).toBe(ids.a);
    expect(result.found.get("DEP-C")).toBe(ids.c);
    expect(result.unknown).toEqual(["DEP-NOPE"]);
  });

  it("returns empty results for an empty key list", async () => {
    const result = await resolveTaskIdsByJiraKey(h.db, []);
    expect(result.found.size).toBe(0);
    expect(result.unknown).toEqual([]);
  });
});

describe("wouldCreateCycle", () => {
  it("returns null when there is no cycle", async () => {
    expect(await wouldCreateCycle(h.db, ids.b!, [ids.c!])).toBeNull();
  });

  it("rejects a self-dependency", async () => {
    const result = await wouldCreateCycle(h.db, ids.a!, [ids.a!]);
    expect(result).not.toBeNull();
    expect(result!.taskIds).toEqual([ids.a, ids.a]);
  });

  it("detects a direct two-node cycle (A->B then B->A)", async () => {
    // A currently depends on C. Make A depend on B as well, then check
    // whether B->A would close a loop.
    await h.db.transaction(async (tx) => {
      await replaceDependencies(tx, ids.a!, [ids.c!, ids.b!]);
    });

    const result = await wouldCreateCycle(h.db, ids.b!, [ids.a!]);
    expect(result).not.toBeNull();
    expect(result!.jiraKeys).toEqual(["DEP-B", "DEP-A", "DEP-B"]);

    // restore
    await h.db.transaction(async (tx) => {
      await replaceDependencies(tx, ids.a!, [ids.c!]);
    });
  });

  it("detects a transitive cycle (A->B->C then C->A)", async () => {
    await h.db.transaction(async (tx) => {
      await replaceDependencies(tx, ids.a!, [ids.b!]);
      await replaceDependencies(tx, ids.b!, [ids.c!]);
    });

    const result = await wouldCreateCycle(h.db, ids.c!, [ids.a!]);
    expect(result).not.toBeNull();
    expect(result!.taskIds[0]).toBe(ids.c);
    expect(result!.taskIds[result!.taskIds.length - 1]).toBe(ids.c);

    // restore
    await h.db.transaction(async (tx) => {
      await replaceDependencies(tx, ids.a!, [ids.c!]);
      await replaceDependencies(tx, ids.b!, []);
    });
  });
});

describe("lockDependencyGraph + wouldCreateCycle concurrency (F3, F6, F7, F8)", () => {
  /**
   * Mirrors the PATCH route's transaction body exactly (apps/api's
   * routes/tasks.ts): advisory lock on the whole graph first, then read the
   * aggregate, then the `runtime_override` UPDATE, then the cycle check,
   * then (in these tests only) an injected delay standing in for network
   * latency, then the replace. Rewritten for F7: the old helper skipped the
   * pre-lock aggregate read and the `runtime_override` UPDATE, so it could
   * not have caught F6 (those two statements running before the lock is
   * exactly what deadlocked two opposing PATCHes under `lockTasksForUpdate`).
   */
  async function patchDependenciesEquivalent(
    taskId: string,
    dependsOnIds: string[],
    delayAfterCheckMs: number,
  ): Promise<void> {
    await h.db.transaction(async (tx) => {
      await lockDependencyGraph(tx);
      await getTaskAggregate(tx, taskId);
      await setRuntimeOverride(tx, taskId, null);
      const cycle = await wouldCreateCycle(tx, taskId, dependsOnIds);
      if (cycle) {
        throw new Error(`cycle: ${cycle.jiraKeys.join(" -> ")}`);
      }
      if (delayAfterCheckMs > 0) {
        await sleep(delayAfterCheckMs);
      }
      await replaceDependencies(tx, taskId, dependsOnIds);
    });
  }

  it("serialises two opposing two-node PATCH-equivalent transactions: exactly one commits, the other fails the cycle check (not a deadlock), no cycle results", async () => {
    const xId = await seedTask(h.db, fx, { jiraKey: "DEP-X", state: "READY" });
    const yId = await seedTask(h.db, fx, { jiraKey: "DEP-Y", state: "READY" });

    // X->[Y] acquires the advisory lock first and holds it (via the
    // post-check delay) long enough that Y->[X] is forced to wait on
    // lockDependencyGraph rather than reading a pre-commit graph.
    const first = patchDependenciesEquivalent(xId, [yId], 300);
    await sleep(50);
    const second = patchDependenciesEquivalent(yId, [xId], 0);

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain(
      "cycle",
    );

    const xDeps = await listDependencies(h.db, xId);
    const yDeps = await listDependencies(h.db, yId);
    expect(xDeps.length + yDeps.length).toBe(1);
  });

  it("serialises a four-node disjoint-lock-set cycle (F8): A=[B] with existing B->C, concurrently C=[D] with existing D->A", async () => {
    const aId = await seedTask(h.db, fx, { jiraKey: "DEP-4A", state: "READY" });
    const bId = await seedTask(h.db, fx, { jiraKey: "DEP-4B", state: "READY" });
    const cId = await seedTask(h.db, fx, { jiraKey: "DEP-4C", state: "READY" });
    const dId = await seedTask(h.db, fx, { jiraKey: "DEP-4D", state: "READY" });

    // Pre-existing edges: B->C and D->A. Neither transaction below touches
    // these tasks' own dependency sets, only A's and C's, so a per-row lock
    // scoped to {taskId, ...dependsOn} (the old `lockTasksForUpdate`) would
    // take disjoint lock sets {A, B} and {C, D} and let both run
    // concurrently. If A=[B] and C=[D] both commit, the graph gains A->B and
    // C->D on top of the existing B->C and D->A, closing the four-node loop
    // A->B->C->D->A.
    await h.db.transaction(async (tx) => {
      await replaceDependencies(tx, bId, [cId]);
      await replaceDependencies(tx, dId, [aId]);
    });

    const first = patchDependenciesEquivalent(aId, [bId], 300);
    await sleep(50);
    const second = patchDependenciesEquivalent(cId, [dId], 0);

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain(
      "cycle",
    );

    // The graph must stay acyclic: from every node, walking `depends_on`
    // edges must never lead back to that same node.
    const allIds = [aId, bId, cId, dId];
    const edgesByTask = new Map<string, string[]>();
    for (const id of allIds) {
      edgesByTask.set(
        id,
        (await listDependencies(h.db, id)).map((row) => row.taskId),
      );
    }
    for (const start of allIds) {
      const visited = new Set<string>([start]);
      const queue = [...(edgesByTask.get(start) ?? [])];
      while (queue.length > 0) {
        const node = queue.shift()!;
        expect(node).not.toBe(start);
        if (!visited.has(node)) {
          visited.add(node);
          queue.push(...(edgesByTask.get(node) ?? []));
        }
      }
    }
  });
});

describe("sumTaskCost", () => {
  it("sums cost and tokens across a task's executions", async () => {
    const result = await sumTaskCost(h.db, [ids.a!, ids.noRepo!]);
    expect(result.get(ids.a!)).toEqual({
      costUsd: 1.75,
      inputTokens: 120,
      cachedInputTokens: 10,
      outputTokens: 55,
    });
    expect(result.has(ids.noRepo!)).toBe(false);
  });

  it("returns an empty map for an empty task id list", async () => {
    expect((await sumTaskCost(h.db, [])).size).toBe(0);
  });

  it("ZERO_TASK_COST is the documented fallback shape", () => {
    expect(ZERO_TASK_COST).toEqual({
      costUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("listBoardRuntimes", () => {
  it("prefers runtime_override over the repository default", async () => {
    const result = await listBoardRuntimes(h.db, [ids.a!, ids.b!, ids.noRepo!]);
    expect(result.get(ids.a!)).toBe("claude");
    expect(result.get(ids.b!)).toBe("codex");
    expect(result.get(ids.noRepo!)).toBeNull();
  });
});

describe("listActiveExecutionIds", () => {
  it("returns only executions in an active state", async () => {
    const result = await listActiveExecutionIds(h.db, ids.a!);
    expect(new Set(result)).toEqual(new Set([ids.aWaiting, ids.aQueued]));
  });
});

describe("resolveProjectFilter", () => {
  it("resolves by project key", async () => {
    expect(await resolveProjectFilter(h.db, "DEP")).toBe(fx.projectId);
  });

  it("resolves by project id", async () => {
    expect(await resolveProjectFilter(h.db, fx.projectId)).toBe(fx.projectId);
  });

  it("returns null for an unknown key or malformed id", async () => {
    expect(await resolveProjectFilter(h.db, "NOPE")).toBeNull();
    expect(await resolveProjectFilter(h.db, "not-a-uuid")).toBeNull();
  });
});

describe("setRuntimeOverride", () => {
  it("sets and clears runtime_override", async () => {
    await h.db.transaction(async (tx) => {
      await setRuntimeOverride(tx, ids.c!, "codex");
    });
    const [row] = await h.db
      .select({ runtimeOverride: schema.tasks.runtimeOverride })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ids.c!));
    expect(row!.runtimeOverride).toBe("codex");

    await h.db.transaction(async (tx) => {
      await setRuntimeOverride(tx, ids.c!, null);
    });
    const [cleared] = await h.db
      .select({ runtimeOverride: schema.tasks.runtimeOverride })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ids.c!));
    expect(cleared!.runtimeOverride).toBeNull();
  });
});
