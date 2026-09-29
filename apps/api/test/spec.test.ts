import type { SpecContent } from "@orchestra/core";
import {
  executionCommands,
  listDependencies,
  lockDependencyGraph,
  lockTaskForPromotion,
  repositories,
  specificationRevisions,
  transition,
} from "@orchestra/db";
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
let fxOther: Fixtures;
let cookie: string;

const REPO = "spc-repo";
const OTHER_PROJECT_REPO = "osp-repo";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  h = await startTestDb();
  clock = createClock(new Date("2026-01-01T00:00:00Z"));
  app = await buildTestApp(h, clock);
  fx = await seedFixtures(h.db, "SPC");
  fxOther = await seedFixtures(h.db, "OSP");
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

let keyCounter = 100;
function nextKey(): string {
  keyCounter += 1;
  return `SPC-${keyCounter}`;
}

async function newTask(
  state: Parameters<typeof seedTask>[2]["state"],
  extra: Partial<Parameters<typeof seedTask>[2]> = {},
): Promise<{ id: string; key: string }> {
  const key = nextKey();
  const id = await seedTask(h.db, fx, { jiraKey: key, state, ...extra });
  return { id, key };
}

/** Inserts a repository under `fx`'s project that isn't shared with other tests. */
async function newRepo(name: string): Promise<string> {
  const [row] = await h.db
    .insert(repositories)
    .values({
      projectId: fx.projectId,
      name,
      gitUrl: `git@example.com:goopter/${name}.git`,
      defaultBranch: "main",
      defaultRuntime: "claude",
    })
    .returning({ id: repositories.id });
  return row!.id;
}

function content(overrides: Partial<SpecContent> = {}): SpecContent {
  return {
    repository: REPO,
    objective: "Do the thing",
    scope: ["scope"],
    out_of_scope: ["not that"],
    requirements: ["req"],
    acceptance_criteria: ["ac"],
    validation: ["run tests"],
    constraints: ["none"],
    dependencies: [],
    ...overrides,
  };
}

async function seedRevision(
  taskId: string,
  version: number,
  status: "draft" | "approved" | "superseded",
  body: unknown,
): Promise<string> {
  const [row] = await h.db
    .insert(specificationRevisions)
    .values({ taskId, version, status, content: body })
    .returning({ id: specificationRevisions.id });
  return row!.id;
}

async function setApprovedRevision(
  taskId: string,
  revisionId: string,
): Promise<void> {
  await h.sql`update tasks set approved_revision_id = ${revisionId} where id = ${taskId}`;
}

function post(url: string, payload?: unknown, withCookie = true) {
  return app.inject({
    method: "POST",
    url,
    headers: withCookie ? { cookie } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

function put(url: string, payload: unknown, withCookie = true) {
  return app.inject({
    method: "PUT",
    url,
    headers: withCookie ? { cookie } : {},
    payload: payload as object,
  });
}

async function taskRow(taskId: string) {
  const [row] = await h.sql<
    {
      state: string;
      repository_id: string | null;
      runtime_override: string | null;
      approved_revision_id: string | null;
    }[]
  >`select state, repository_id, runtime_override, approved_revision_id from tasks where id = ${taskId}`;
  return row!;
}

async function commands(taskId: string) {
  return h.sql<
    {
      type: string;
      execution_id: string | null;
      created_by: string | null;
      payload: Record<string, unknown>;
    }[]
  >`select type, execution_id, created_by, payload from execution_commands where task_id = ${taskId} order by created_at, id`;
}

async function revisions(taskId: string) {
  return h.sql<
    {
      id: string;
      version: number;
      status: string;
      content: SpecContent;
      created_by: string | null;
    }[]
  >`select id, version, status, content, created_by from specification_revisions where task_id = ${taskId} order by version`;
}

async function eventTypes(taskId: string): Promise<string[]> {
  const rows = await h.sql<{ type: string }[]>`
    select type from execution_events where task_id = ${taskId} order by id`;
  return rows.map((r) => r.type);
}

async function eventRows(taskId: string) {
  return h.sql<
    { type: string; execution_id: string | null; payload: Record<string, unknown> }[]
  >`select type, execution_id, payload from execution_events where task_id = ${taskId} order by id`;
}

async function auditTriggers(entityId: string): Promise<string[]> {
  const rows = await h.sql<{ trigger: string }[]>`
    select trigger from audit_events where entity_id = ${entityId} order by id`;
  return rows.map((r) => r.trigger);
}

async function dependencyIds(taskId: string): Promise<string[]> {
  const rows = await h.sql<{ depends_on_task_id: string }[]>`
    select depends_on_task_id from task_dependencies where task_id = ${taskId} order by depends_on_task_id`;
  return rows.map((r) => r.depends_on_task_id);
}

async function approvals(taskId: string) {
  return h.sql<
    { revision_id: string; approved_by: string; runtime: string }[]
  >`select a.revision_id, a.approved_by, a.runtime from specification_approvals a
    join specification_revisions r on r.id = a.revision_id where r.task_id = ${taskId}`;
}

async function executionRow(executionId: string) {
  const [row] = await h.sql<
    { state: string; ended_at: Date | null; tools_token_hash: string | null }[]
  >`select state, ended_at, tools_token_hash from executions where id = ${executionId}`;
  return row!;
}

/** Everything any spec route could write for a task, for "nothing written" checks. */
async function snapshot(taskId: string) {
  return {
    task: await taskRow(taskId),
    revisions: (await revisions(taskId)).map((r) => ({
      id: r.id,
      status: r.status,
      content: r.content,
    })),
    approvals: await approvals(taskId),
    dependencies: await dependencyIds(taskId),
    commands: await commands(taskId),
    events: await eventTypes(taskId),
    audits: await auditTriggers(taskId),
  };
}

describe("POST /api/tasks/:id/spec/session (P1)", () => {
  it("moves NEEDS_SPEC to SPEC_IN_PROGRESS, locks the given repository, and enqueues exactly one start_spec_session", async () => {
    const { id } = await newTask("NEEDS_SPEC");
    const res = await post(`/api/tasks/${id}/spec/session`, {
      repository_id: fx.repositoryId,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ from: "NEEDS_SPEC", to: "SPEC_IN_PROGRESS" });

    expect(await taskRow(id)).toMatchObject({
      state: "SPEC_IN_PROGRESS",
      repository_id: fx.repositoryId,
    });
    const cmds = await commands(id);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({
      type: "start_spec_session",
      execution_id: null,
      created_by: fx.userId,
    });
    expect(await auditTriggers(id)).toEqual(["spec.session_started"]);
  });

  it("GOT.80 D3: uses the chosen repository even when another repository of the project sorts first alphabetically", async () => {
    const earlier = await newRepo("aaa-earlier-repo");
    const { id } = await newTask("NEEDS_SPEC");
    const res = await post(`/api/tasks/${id}/spec/session`, {
      repository_id: fx.repositoryId,
    });
    expect(res.statusCode).toBe(200);
    expect((await taskRow(id)).repository_id).toBe(fx.repositoryId);
    expect((await taskRow(id)).repository_id).not.toBe(earlier);
  });

  it("GOT.80 D3: returns 422 REPOSITORY_REQUIRED when repository_id is missing on the first start, and writes nothing", async () => {
    const { id } = await newTask("NEEDS_SPEC");
    const before = await snapshot(id);
    const res = await post(`/api/tasks/${id}/spec/session`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("REPOSITORY_REQUIRED");
    expect(await snapshot(id)).toEqual(before);
  });

  it("GOT.80 D3: returns 422 REPOSITORY_NOT_IN_PROJECT for a repository from another project, and writes nothing", async () => {
    const { id } = await newTask("NEEDS_SPEC");
    const before = await snapshot(id);
    const res = await post(`/api/tasks/${id}/spec/session`, {
      repository_id: fxOther.repositoryId,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("REPOSITORY_NOT_IN_PROJECT");
    expect(await snapshot(id)).toEqual(before);
  });

  it("GOT.80 D3: returns 422 REPOSITORY_NOT_IN_PROJECT for an unknown repository_id, and writes nothing", async () => {
    const { id } = await newTask("NEEDS_SPEC");
    const before = await snapshot(id);
    const res = await post(`/api/tasks/${id}/spec/session`, {
      repository_id: UNKNOWN_ID,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("REPOSITORY_NOT_IN_PROJECT");
    expect(await snapshot(id)).toEqual(before);
  });

  it.each(["SPEC_REVIEW", "READY", "IMPLEMENTING", "DONE"] as const)(
    "returns 409 from %s and writes nothing",
    async (state) => {
      const { id } = await newTask(state);
      const before = await snapshot(id);
      const res = await post(`/api/tasks/${id}/spec/session`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");
      expect(await snapshot(id)).toEqual(before);
    },
  );

  it("restarts from SPEC_IN_PROGRESS with no live spec execution: enqueues start_spec_session, no task transition (C49)", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    const failed = await seedExecution(h.db, id, { role: "spec", state: "FAILED" });
    await seedExecution(h.db, id, { role: "spec", state: "COMPLETED", attempt: 2 });
    // A live implementation execution is not a spec session.
    await seedExecution(h.db, id, { role: "implementation", state: "WAITING_FOR_USER" });

    const res = await post(`/api/tasks/${id}/spec/session`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ from: "SPEC_IN_PROGRESS", to: "SPEC_IN_PROGRESS" });
    expect((await taskRow(id)).state).toBe("SPEC_IN_PROGRESS");
    expect(await commands(id)).toEqual([
      { type: "start_spec_session", execution_id: null, created_by: fx.userId, payload: {} },
    ]);
    expect(await auditTriggers(id)).toEqual([]);
    expect((await executionRow(failed)).state).toBe("FAILED");
  });

  it("GOT.80 D2: a restart may repeat the task's own repository_id", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    const res = await post(`/api/tasks/${id}/spec/session`, {
      repository_id: fx.repositoryId,
    });
    expect(res.statusCode).toBe(200);
    expect((await taskRow(id)).repository_id).toBe(fx.repositoryId);
  });

  it("GOT.80 D2: a restart with a different repository_id is 409 REPOSITORY_LOCKED and writes nothing", async () => {
    const other = await newRepo("session-restart-other-repo");
    const { id } = await newTask("SPEC_IN_PROGRESS");
    const before = await snapshot(id);
    const res = await post(`/api/tasks/${id}/spec/session`, {
      repository_id: other,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("REPOSITORY_LOCKED");
    expect(await snapshot(id)).toEqual(before);
  });

  it("returns 409 SPEC_SESSION_BUSY while a send-back resume of a COMPLETED spec execution is pending, then restarts once it completed (F1)", async () => {
    const { id } = await newTask("SPEC_REVIEW");
    await seedRevision(id, 1, "draft", content());
    await seedExecution(h.db, id, { role: "spec", state: "COMPLETED" });
    expect((await post(`/api/tasks/${id}/spec/send-back`)).statusCode).toBe(200);
    const before = await snapshot(id);

    const res = await post(`/api/tasks/${id}/spec/session`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SPEC_SESSION_BUSY");
    expect(await snapshot(id)).toEqual(before);

    // The worker skipped or handled it: no longer pending.
    await h.sql`update execution_commands set completed_at = now() where task_id = ${id}`;
    expect((await post(`/api/tasks/${id}/spec/session`)).statusCode).toBe(200);
  });

  it.each(["QUEUED", "ASSIGNED", "RUNNING", "WAITING_FOR_USER"] as const)(
    "returns 409 SPEC_SESSION_BUSY from SPEC_IN_PROGRESS with a %s spec execution and writes nothing (C49)",
    async (execState) => {
      const { id } = await newTask("SPEC_IN_PROGRESS");
      await seedExecution(h.db, id, { role: "spec", state: execState });
      const before = await snapshot(id);
      const res = await post(`/api/tasks/${id}/spec/session`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("SPEC_SESSION_BUSY");
      expect(await snapshot(id)).toEqual(before);
    },
  );

  // GOT.80 F1: the first start used to read the repository with an unlocked
  // `findRepositoryById`, then write `tasks.repository_id` in the same
  // transaction. A repository delete that locked and counted referencing
  // tasks first (seeing none, since the write had not happened yet) could
  // commit in between: the read had already seen the row, but the write's
  // own FK check then found it gone and raised an uncaught 23503, a 500.
  // Locking the repository the same way `deleteRepository` does (F1's fix)
  // makes the two interleavings below the only possible outcomes, and
  // neither is ever a 500. Both hold one side's transaction open so the
  // interleaving is deterministic rather than a matter of scheduling luck.
  describe("F1: first start racing a concurrent repository delete", () => {
    it("the delete's lock wins: it deletes and commits while the start is blocked, so the start sees the repository gone (422, never 500)", async () => {
      const repoId = await newRepo("race-first-start-delete-wins");
      const { id: taskId } = await newTask("NEEDS_SPEC");
      const before = await snapshot(taskId);

      let deleteLocked!: () => void;
      const deleteLockedPromise = new Promise<void>((resolve) => {
        deleteLocked = resolve;
      });
      let releaseDelete!: () => void;
      const releaseDeletePromise = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });

      // Mirrors deleteRepository: lock the row, then (nothing references it
      // yet) delete it, held open uncommitted.
      const deleteTx = h.sql.begin(async (sql) => {
        await sql`select id from repositories where id = ${repoId} for update`;
        deleteLocked();
        await releaseDeletePromise;
        await sql`delete from repositories where id = ${repoId}`;
      });
      deleteTx.catch(() => {});

      await deleteLockedPromise;

      const starting = post(`/api/tasks/${taskId}/spec/session`, {
        repository_id: repoId,
      });

      // The start's own `lockRepositoryById` conflicts with the delete
      // transaction's lock: it must still be pending while that transaction
      // holds it, so nothing is written yet.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await snapshot(taskId)).toEqual(before);

      releaseDelete();
      await deleteTx;

      const res = await starting;
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("REPOSITORY_NOT_IN_PROJECT");
      expect(await snapshot(taskId)).toEqual(before);
    });

    it("the start's lock wins: it commits the repository reference while a delete is blocked, so the delete sees the task and refuses (409, never 500)", async () => {
      const repoId = await newRepo("race-first-start-wins");
      const { id: taskId } = await newTask("NEEDS_SPEC");

      let repoLocked!: () => void;
      const repoLockedPromise = new Promise<void>((resolve) => {
        repoLocked = resolve;
      });
      let release!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Mirrors the fixed start route: lock the repository, then (as
      // `transition()` would) write it onto the task, held open uncommitted.
      const holder = h.sql.begin(async (sql) => {
        await sql`select id from repositories where id = ${repoId} for update`;
        repoLocked();
        await releasePromise;
        await sql`update tasks set repository_id = ${repoId} where id = ${taskId}`;
      });
      holder.catch(() => {});

      await repoLockedPromise;

      const deleting = app.inject({
        method: "DELETE",
        url: `/api/repositories/${repoId}`,
        headers: { cookie },
      });

      // deleteRepository's own `SELECT ... FOR UPDATE` conflicts with the
      // holder's lock: it must still be pending, so the repository is untouched.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        await h.sql`select id from repositories where id = ${repoId}`,
      ).toHaveLength(1);

      release();
      await holder;

      const res = await deleting;
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: "REFERENCED_BY_TASKS", task_count: 1 },
      });
      expect(
        await h.sql`select id from repositories where id = ${repoId}`,
      ).toHaveLength(1);
    });
  });

  // GOT.80 F2: a task left `SPEC_IN_PROGRESS` before D2 locked a repository
  // at session start has `repository_id` null. A restart used to refuse any
  // `repository_id` (even a valid one) with 409 REPOSITORY_LOCKED though
  // nothing was actually locked, leaving the task stuck forever.
  describe("F2: restarting a legacy task with no repository locked yet", () => {
    it("accepts and locks a repository_id, validated the same way the first start is", async () => {
      const { id } = await newTask("SPEC_IN_PROGRESS", { withRepository: false });
      const res = await post(`/api/tasks/${id}/spec/session`, {
        repository_id: fx.repositoryId,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ from: "SPEC_IN_PROGRESS", to: "SPEC_IN_PROGRESS" });
      expect((await taskRow(id)).repository_id).toBe(fx.repositoryId);
      // Now locked: a further restart with a different one is refused (D2).
      const other = await newRepo("legacy-restart-other-repo");
      const second = await post(`/api/tasks/${id}/spec/session`, {
        repository_id: other,
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe("REPOSITORY_LOCKED");
    });

    it("returns 422 REPOSITORY_NOT_IN_PROJECT for a repository from another project, and writes nothing", async () => {
      const { id } = await newTask("SPEC_IN_PROGRESS", { withRepository: false });
      const before = await snapshot(id);
      const res = await post(`/api/tasks/${id}/spec/session`, {
        repository_id: fxOther.repositoryId,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("REPOSITORY_NOT_IN_PROJECT");
      expect(await snapshot(id)).toEqual(before);
    });

    it("omitting repository_id restarts without setting one (unlike the first start, it is not required)", async () => {
      const { id } = await newTask("SPEC_IN_PROGRESS", { withRepository: false });
      const res = await post(`/api/tasks/${id}/spec/session`);
      expect(res.statusCode).toBe(200);
      expect((await taskRow(id)).repository_id).toBeNull();
    });

    it("a SPEC_REVIEW task with no repository is unstuck via send-back then a restart with repository_id", async () => {
      const { id } = await newTask("SPEC_REVIEW", { withRepository: false });
      await seedRevision(id, 1, "draft", content());

      const sentBack = await post(`/api/tasks/${id}/spec/send-back`);
      expect(sentBack.statusCode).toBe(200);
      expect((await taskRow(id)).state).toBe("SPEC_IN_PROGRESS");

      const res = await post(`/api/tasks/${id}/spec/session`, {
        repository_id: fx.repositoryId,
      });
      expect(res.statusCode).toBe(200);
      expect((await taskRow(id)).repository_id).toBe(fx.repositoryId);
    });

    // GOT.80-fix2 F6: the legacy-restart branch also reads the repository
    // with `lockRepositoryById` (~spec.ts:164) before writing
    // `tasks.repository_id`, the same lock `deleteRepository` takes. Same
    // race as F1's "delete wins" case above, through this branch instead.
    it("racing a concurrent repository delete: the delete's lock wins, so the restart sees the repository gone (422, never 500)", async () => {
      const repoId = await newRepo("race-f2-restart-delete-wins");
      const { id: taskId } = await newTask("SPEC_IN_PROGRESS", {
        withRepository: false,
      });
      const before = await snapshot(taskId);

      let deleteLocked!: () => void;
      const deleteLockedPromise = new Promise<void>((resolve) => {
        deleteLocked = resolve;
      });
      let releaseDelete!: () => void;
      const releaseDeletePromise = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });

      // Mirrors deleteRepository: lock the row, then (nothing references it
      // yet) delete it, held open uncommitted.
      const deleteTx = h.sql.begin(async (sql) => {
        await sql`select id from repositories where id = ${repoId} for update`;
        deleteLocked();
        await releaseDeletePromise;
        await sql`delete from repositories where id = ${repoId}`;
      });
      deleteTx.catch(() => {});

      await deleteLockedPromise;

      const restarting = post(`/api/tasks/${taskId}/spec/session`, {
        repository_id: repoId,
      });

      // The restart's own `lockRepositoryById` conflicts with the delete
      // transaction's lock: it must still be pending while that transaction
      // holds it, so nothing is written yet.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await snapshot(taskId)).toEqual(before);

      releaseDelete();
      await deleteTx;

      const res = await restarting;
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("REPOSITORY_NOT_IN_PROJECT");
      expect(await snapshot(taskId)).toEqual(before);
    });
  });
});

describe("POST /api/tasks/:id/spec/messages (P2)", () => {
  it.each(["RUNNING", "WAITING_FOR_USER"] as const)(
    "enqueues send_message on a %s spec execution",
    async (execState) => {
      const { id } = await newTask("SPEC_IN_PROGRESS");
      const execId = await seedExecution(h.db, id, {
        role: "spec",
        state: execState,
      });
      const res = await post(`/api/tasks/${id}/spec/messages`, {
        text: "please add a risk",
      });
      expect(res.statusCode).toBe(200);
      const cmds = await commands(id);
      expect(cmds).toHaveLength(1);
      expect(cmds[0]).toMatchObject({
        type: "send_message",
        execution_id: execId,
        created_by: fx.userId,
        payload: { text: "please add a risk" },
      });
    },
  );

  // GOT.57 AC1: the user's side of the chat turn is recorded as a
  // `spec.message` execution event, in the same transaction as the
  // `send_message` command, attached to the live spec execution.
  it.each(["RUNNING", "WAITING_FOR_USER"] as const)(
    "writes one spec.message event with the text and author, attached to the %s spec execution",
    async (execState) => {
      const { id } = await newTask("SPEC_IN_PROGRESS");
      const execId = await seedExecution(h.db, id, {
        role: "spec",
        state: execState,
      });
      const res = await post(`/api/tasks/${id}/spec/messages`, {
        text: "please add a risk",
      });
      expect(res.statusCode).toBe(200);
      expect(await eventRows(id)).toEqual([
        {
          type: "spec.message",
          execution_id: execId,
          payload: { text: "please add a risk", author_user_id: fx.userId },
        },
      ]);
    },
  );

  it("returns 409 without a live spec execution and writes nothing", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    await seedExecution(h.db, id, { role: "spec", state: "COMPLETED" });
    await seedExecution(h.db, id, { role: "implementation", state: "RUNNING" });
    const before = await snapshot(id);
    const res = await post(`/api/tasks/${id}/spec/messages`, { text: "hi" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NO_LIVE_SPEC_EXECUTION");
    expect(await snapshot(id)).toEqual(before);
    expect(await eventTypes(id)).toHaveLength(0);
  });

  it("returns 400 for an empty or missing text and writes no command or event", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    await seedExecution(h.db, id, { role: "spec", state: "RUNNING" });
    expect((await post(`/api/tasks/${id}/spec/messages`, { text: "" })).statusCode).toBe(400);
    expect((await post(`/api/tasks/${id}/spec/messages`, {})).statusCode).toBe(400);
    expect(await commands(id)).toHaveLength(0);
    expect(await eventTypes(id)).toHaveLength(0);
  });
});

describe("PUT /api/tasks/:id/spec/draft (P3)", () => {
  it("creates the draft at max(version) + 1, then updates the same row, each with a spec.revised event", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    await seedRevision(id, 1, "superseded", content());
    await seedRevision(id, 2, "approved", content());

    const first = await put(`/api/tasks/${id}/spec/draft`, {
      content: content({ objective: "first" }),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ version: 3, status: "draft" });

    const second = await put(`/api/tasks/${id}/spec/draft`, {
      content: content({ objective: "second" }),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      id: first.json().id,
      version: 3,
      status: "draft",
    });

    const drafts = (await revisions(id)).filter((r) => r.status === "draft");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.content.objective).toBe("second");
    expect(drafts[0]!.created_by).toBe(fx.userId);
    expect(await eventTypes(id)).toEqual(["spec.revised", "spec.revised"]);
    expect((await taskRow(id)).state).toBe("SPEC_IN_PROGRESS");
  });

  it("accepts an incomplete draft (empty lists) since approval rules do not apply", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    const res = await put(`/api/tasks/${id}/spec/draft`, {
      content: content({ scope: [], repository: "" }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("GOT.80 D2: a non-empty repository different from the task's locked repository is 422 REPOSITORY_LOCKED, writing nothing", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    const before = await snapshot(id);
    const res = await put(`/api/tasks/${id}/spec/draft`, {
      content: content({ repository: "not-the-locked-repo" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("REPOSITORY_LOCKED");
    expect(await snapshot(id)).toEqual(before);
  });

  it.each([
    ["missing content", {}],
    ["content missing fields", { content: { objective: "x" } }],
    ["wrong field type", { content: { ...content(), scope: "x" } }],
    ["unknown top-level key", { content: content(), extra: 1 }],
  ])("returns 400 for %s and writes nothing", async (_label, body) => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    const before = await snapshot(id);
    const res = await put(`/api/tasks/${id}/spec/draft`, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await snapshot(id)).toEqual(before);
  });

  it.each(["NEEDS_SPEC", "SPEC_REVIEW", "SPEC_APPROVED", "READY", "IMPLEMENTING"] as const)(
    "returns 409 in %s and writes nothing",
    async (state) => {
      const { id } = await newTask(state);
      const before = await snapshot(id);
      const res = await put(`/api/tasks/${id}/spec/draft`, { content: content() });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ILLEGAL_STATE");
      expect(await snapshot(id)).toEqual(before);
    },
  );
});

describe("POST /api/tasks/:id/spec/request-review and send-back (P4)", () => {
  it("moves to SPEC_REVIEW and completes the RUNNING spec execution", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    await seedRevision(id, 1, "draft", content());
    const specExec = await seedExecution(h.db, id, { role: "spec", state: "RUNNING" });
    await h.sql`update executions set tools_token_hash = 'abc' where id = ${specExec}`;
    const implExec = await seedExecution(h.db, id, {
      role: "implementation",
      state: "WAITING_FOR_USER",
    });

    const res = await post(`/api/tasks/${id}/spec/request-review`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ from: "SPEC_IN_PROGRESS", to: "SPEC_REVIEW" });

    expect((await taskRow(id)).state).toBe("SPEC_REVIEW");
    const spec = await executionRow(specExec);
    expect(spec.state).toBe("COMPLETED");
    expect(spec.ended_at).not.toBeNull();
    expect(spec.tools_token_hash).toBeNull();
    expect(await auditTriggers(specExec)).toEqual(["execution.completed"]);
    expect((await executionRow(implExec)).state).toBe("WAITING_FOR_USER");
    expect(await auditTriggers(id)).toEqual(["spec.review_requested"]);
  });

  it("moves to SPEC_REVIEW with no spec execution at all", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    await seedRevision(id, 1, "draft", content());
    const res = await post(`/api/tasks/${id}/spec/request-review`);
    expect(res.statusCode).toBe(200);
    expect((await taskRow(id)).state).toBe("SPEC_REVIEW");
  });

  it("moves to SPEC_REVIEW when the only spec executions have ended", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    await seedRevision(id, 1, "draft", content());
    const done = await seedExecution(h.db, id, { role: "spec", state: "COMPLETED" });
    const failed = await seedExecution(h.db, id, { role: "spec", state: "FAILED" });
    const res = await post(`/api/tasks/${id}/spec/request-review`);
    expect(res.statusCode).toBe(200);
    expect((await taskRow(id)).state).toBe("SPEC_REVIEW");
    expect((await executionRow(done)).state).toBe("COMPLETED");
    expect((await executionRow(failed)).state).toBe("FAILED");
  });

  it.each(["QUEUED", "ASSIGNED", "WAITING_FOR_USER"] as const)(
    "returns 409 SPEC_SESSION_BUSY with a %s spec execution and writes nothing",
    async (execState) => {
      const { id } = await newTask("SPEC_IN_PROGRESS");
      await seedRevision(id, 1, "draft", content());
      const specExec = await seedExecution(h.db, id, { role: "spec", state: execState });
      const before = await snapshot(id);
      const execBefore = await executionRow(specExec);
      const execAuditsBefore = await auditTriggers(specExec);

      const res = await post(`/api/tasks/${id}/spec/request-review`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("SPEC_SESSION_BUSY");
      expect(await snapshot(id)).toEqual(before);
      expect(await executionRow(specExec)).toEqual(execBefore);
      expect(await auditTriggers(specExec)).toEqual(execAuditsBefore);
    },
  );

  async function seedStartCommand(
    taskId: string,
    claimedAt: Date | null,
    completedAt: Date | null,
  ): Promise<void> {
    await h.db.insert(executionCommands).values({
      taskId,
      executionId: null,
      type: "start_spec_session",
      payload: {},
      createdBy: fx.userId,
      claimedAt,
      completedAt,
    });
  }

  async function commandTimes(taskId: string) {
    return h.sql<{ claimed_at: Date | null; completed_at: Date | null }[]>`
      select claimed_at, completed_at from execution_commands where task_id = ${taskId} order by created_at, id`;
  }

  it.each([
    ["unclaimed", null],
    ["claimed but not completed", new Date("2026-01-01T00:00:00Z")],
  ] as const)(
    "returns 409 SPEC_SESSION_BUSY with a %s start_spec_session command and writes nothing",
    async (_label, claimedAt) => {
      const { id } = await newTask("SPEC_IN_PROGRESS");
      await seedRevision(id, 1, "draft", content());
      await seedStartCommand(id, claimedAt, null);
      const before = await snapshot(id);
      const timesBefore = await commandTimes(id);

      const res = await post(`/api/tasks/${id}/spec/request-review`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("SPEC_SESSION_BUSY");
      expect(await snapshot(id)).toEqual(before);
      expect(await commandTimes(id)).toEqual(timesBefore);
    },
  );

  it("moves to SPEC_REVIEW when the start_spec_session command has completed", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    await seedRevision(id, 1, "draft", content());
    const at = new Date("2026-01-01T00:00:00Z");
    await seedStartCommand(id, at, at);
    const res = await post(`/api/tasks/${id}/spec/request-review`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ from: "SPEC_IN_PROGRESS", to: "SPEC_REVIEW" });
    expect((await taskRow(id)).state).toBe("SPEC_REVIEW");
  });

  it("returns 409 NO_DRAFT without a draft and writes nothing", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    await seedRevision(id, 1, "approved", content());
    await seedExecution(h.db, id, { role: "spec", state: "RUNNING" });
    const before = await snapshot(id);
    const res = await post(`/api/tasks/${id}/spec/request-review`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NO_DRAFT");
    expect(await snapshot(id)).toEqual(before);
  });

  it("returns 409 ILLEGAL_TRANSITION outside SPEC_IN_PROGRESS", async () => {
    const { id } = await newTask("SPEC_REVIEW");
    await seedRevision(id, 1, "draft", content());
    const res = await post(`/api/tasks/${id}/spec/request-review`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");
  });

  it("send-back returns SPEC_REVIEW to SPEC_IN_PROGRESS and enqueues send_message on the latest COMPLETED spec execution (C45)", async () => {
    const { id } = await newTask("SPEC_REVIEW");
    await seedRevision(id, 1, "draft", content());
    const older = await seedExecution(h.db, id, {
      role: "spec",
      state: "COMPLETED",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const specExec = await seedExecution(h.db, id, {
      role: "spec",
      state: "COMPLETED",
      attempt: 2,
      createdAt: new Date("2026-01-01T01:00:00Z"),
    });
    await seedExecution(h.db, id, {
      role: "spec",
      state: "FAILED",
      attempt: 3,
      createdAt: new Date("2026-01-01T02:00:00Z"),
    });
    await seedExecution(h.db, id, { role: "implementation", state: "COMPLETED" });
    const res = await post(`/api/tasks/${id}/spec/send-back`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ from: "SPEC_REVIEW", to: "SPEC_IN_PROGRESS" });
    expect(await auditTriggers(id)).toEqual(["spec.sent_back"]);
    expect(await commands(id)).toEqual([
      {
        type: "send_message",
        execution_id: specExec,
        created_by: fx.userId,
        payload: { text: "The specification was sent back for changes.", system: "sent_back" },
      },
    ]);
    // The route only enqueues; the worker moves the execution (C45).
    expect((await executionRow(specExec)).state).toBe("COMPLETED");
    expect((await executionRow(older)).state).toBe("COMPLETED");
    expect(await auditTriggers(specExec)).toEqual([]);
  });

  it("send-back with no COMPLETED spec execution (a hand-written draft) enqueues nothing", async () => {
    const { id } = await newTask("SPEC_REVIEW");
    await seedRevision(id, 1, "draft", content());
    await seedExecution(h.db, id, { role: "spec", state: "FAILED" });
    const res = await post(`/api/tasks/${id}/spec/send-back`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ from: "SPEC_REVIEW", to: "SPEC_IN_PROGRESS" });
    expect(await auditTriggers(id)).toEqual(["spec.sent_back"]);
    expect(await commands(id)).toHaveLength(0);
  });

  it("send-back returns 409 outside SPEC_REVIEW", async () => {
    const { id } = await newTask("SPEC_IN_PROGRESS");
    await seedExecution(h.db, id, { role: "spec", state: "COMPLETED" });
    const res = await post(`/api/tasks/${id}/spec/send-back`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");
    expect(await commands(id)).toHaveLength(0);
  });
});

describe("POST /api/tasks/:id/spec/approve (P5, P7)", () => {
  it("produces every approval effect and ends READY when all dependencies are DONE", async () => {
    const dep = await newTask("DONE");
    const { id } = await newTask("SPEC_REVIEW", {
      runtimeOverride: "claude",
    });
    const oldApproved = await seedRevision(id, 1, "approved", content());
    await setApprovedRevision(id, oldApproved);
    const draft = await seedRevision(id, 2, "draft", content({ dependencies: [dep.key] }));

    const res = await post(`/api/tasks/${id}/spec/approve`, { runtime: "codex" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      from: "SPEC_REVIEW",
      to: "READY",
      revisionId: draft,
    });

    const task = await taskRow(id);
    expect(task).toEqual({
      state: "READY",
      repository_id: fx.repositoryId,
      runtime_override: "codex",
      approved_revision_id: draft,
    });
    const revs = await revisions(id);
    expect(revs.map((r) => [r.id, r.status])).toEqual([
      [oldApproved, "superseded"],
      [draft, "approved"],
    ]);
    expect(await approvals(id)).toEqual([
      { revision_id: draft, approved_by: fx.userId, runtime: "codex" },
    ]);
    expect(await dependencyIds(id)).toEqual([dep.id]);
    expect(await eventTypes(id)).toContain("spec.approved");
    expect(await auditTriggers(id)).toEqual(["spec.approved", "dependency.satisfied"]);
    expect(await commands(id)).toHaveLength(0);
  });

  it("without body.runtime clears runtime_override and records the repository default runtime", async () => {
    const dep = await newTask("DONE");
    const { id } = await newTask("SPEC_REVIEW", { runtimeOverride: "codex" });
    const draft = await seedRevision(id, 1, "draft", content({ dependencies: [dep.key] }));

    const res = await post(`/api/tasks/${id}/spec/approve`);
    expect(res.statusCode).toBe(200);
    expect((await taskRow(id)).runtime_override).toBeNull();
    expect(await approvals(id)).toEqual([
      { revision_id: draft, approved_by: fx.userId, runtime: "claude" },
    ]);
  });

  it("replaces existing task_dependencies with the spec's dependencies", async () => {
    const oldDep = await newTask("DONE");
    const newDep = await newTask("DONE");
    const { id } = await newTask("SPEC_REVIEW");
    await seedDependency(h.db, id, oldDep.id);
    await seedRevision(id, 1, "draft", content({ dependencies: [newDep.key] }));
    const res = await post(`/api/tasks/${id}/spec/approve`);
    expect(res.statusCode).toBe(200);
    expect(await dependencyIds(id)).toEqual([newDep.id]);
  });

  it("any FAILED or CANCELLED dependency ends BLOCKED", async () => {
    const done = await newTask("DONE");
    const cancelled = await newTask("CANCELLED");
    const { id } = await newTask("SPEC_REVIEW");
    await seedRevision(id, 1, "draft", content({ dependencies: [done.key, cancelled.key] }));
    const res = await post(`/api/tasks/${id}/spec/approve`);
    expect(res.statusCode).toBe(200);
    expect(res.json().to).toBe("BLOCKED");
    expect(await auditTriggers(id)).toEqual(["spec.approved", "dependency.failed"]);
  });

  it("an unfinished dependency leaves the task SPEC_APPROVED", async () => {
    const done = await newTask("DONE");
    const running = await newTask("IMPLEMENTING");
    const { id } = await newTask("SPEC_REVIEW");
    await seedRevision(id, 1, "draft", content({ dependencies: [done.key, running.key] }));
    const res = await post(`/api/tasks/${id}/spec/approve`);
    expect(res.statusCode).toBe(200);
    expect(res.json().to).toBe("SPEC_APPROVED");
    expect((await taskRow(id)).state).toBe("SPEC_APPROVED");
    expect(await auditTriggers(id)).toEqual(["spec.approved"]);
  });

  describe("422 with nothing written", () => {
    async function expect422(
      draftContent: unknown,
      code: string,
      setup?: (taskId: string) => Promise<void>,
    ) {
      const { id } = await newTask("SPEC_REVIEW");
      const oldApproved = await seedRevision(id, 1, "approved", content());
      await setApprovedRevision(id, oldApproved);
      await seedRevision(id, 2, "draft", draftContent);
      if (setup) await setup(id);
      const before = await snapshot(id);
      const res = await post(`/api/tasks/${id}/spec/approve`, { runtime: "codex" });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe(code);
      expect(await snapshot(id)).toEqual(before);
      return res;
    }

    it("invalid content (an empty required list)", async () => {
      const dep = await newTask("DONE");
      const res = await expect422(
        content({ dependencies: [dep.key], acceptance_criteria: [] }),
        "SPEC_INVALID",
      );
      expect(res.json().error.message).toContain("acceptance_criteria");
    });

    it("content that fails the schema", async () => {
      await expect422({ objective: "only" }, "SPEC_INVALID");
    });

    it("unknown repository", async () => {
      const dep = await newTask("DONE");
      await expect422(
        content({ dependencies: [dep.key], repository: "no-such-repo" }),
        "SPEC_INVALID",
      );
    });

    it("a repository that exists only in another project", async () => {
      const dep = await newTask("DONE");
      await expect422(
        content({ dependencies: [dep.key], repository: OTHER_PROJECT_REPO }),
        "SPEC_INVALID",
      );
    });

    // GOT.80 F3: pre-GOT.80, approval resolved the draft's named repository
    // by looking it up within the task's project (`findProjectRepositoryByName`),
    // so naming any real repository of that project — not just the one the
    // task is locked to — resolved and let approval proceed (200). D2 ties
    // approval to the task's own locked repository by id instead, so this
    // now must fail even though the named repository genuinely exists in
    // the task's project: this test fails (wrongly passes/200s) against
    // that old name-lookup behaviour and only passes against the fix.
    it("a draft naming a second, existing repository of the task's own project (D2: locked by id, not any same-project name)", async () => {
      const secondRepoName = "spc-second-repo";
      await newRepo(secondRepoName);
      const dep = await newTask("DONE");
      await expect422(
        content({ dependencies: [dep.key], repository: secondRepoName }),
        "SPEC_INVALID",
      );
    });

    it("unknown dependency key", async () => {
      const res = await expect422(
        content({ dependencies: ["NOPE-999"] }),
        "UNKNOWN_DEPENDENCY",
      );
      expect(res.json().error.message).toContain("NOPE-999");
    });

    it("a dependency cycle", async () => {
      const other = await newTask("SPEC_APPROVED");
      await expect422(
        content({ dependencies: [other.key] }),
        "DEPENDENCY_CYCLE",
        (taskId) => seedDependency(h.db, other.id, taskId),
      );
    });
  });

  it.each(["SPEC_IN_PROGRESS", "SPEC_APPROVED", "READY", "IMPLEMENTING"] as const)(
    "returns 409 from %s with a valid draft and writes nothing",
    async (state) => {
      // An unfinished dependency: with a DONE one, a SPEC_APPROVED approve
      // would roll back on the later dependency.satisfied move and mask F1.
      const dep = await newTask("IMPLEMENTING");
      const { id } = await newTask(state);
      await seedRevision(id, 1, "draft", content({ dependencies: [dep.key] }));
      const before = await snapshot(id);
      const res = await post(`/api/tasks/${id}/spec/approve`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");
      const after = await snapshot(id);
      expect(after).toEqual(before);
      expect(after.task.state).toBe(state);
      expect(after.approvals).toEqual([]);
      expect(after.revisions.map((r) => r.status)).toEqual(["draft"]);
      expect(after.commands).toEqual([]);
      expect(after.dependencies).toEqual([]);
    },
  );

  it("an empty dependencies list with no paused execution ends READY with no dependency rows", async () => {
    const { id } = await newTask("SPEC_REVIEW");
    const draft = await seedRevision(id, 1, "draft", content({ dependencies: [] }));
    const res = await post(`/api/tasks/${id}/spec/approve`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      from: "SPEC_REVIEW",
      to: "READY",
      revisionId: draft,
    });
    expect((await taskRow(id)).state).toBe("READY");
    expect(await dependencyIds(id)).toEqual([]);
    expect(await auditTriggers(id)).toEqual(["spec.approved", "dependency.satisfied"]);
    expect(await commands(id)).toHaveLength(0);
  });

  it("returns 409 NO_DRAFT in SPEC_REVIEW without a draft", async () => {
    const { id } = await newTask("SPEC_REVIEW");
    const res = await post(`/api/tasks/${id}/spec/approve`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NO_DRAFT");
  });

  it("returns 400 for an invalid runtime", async () => {
    const { id } = await newTask("SPEC_REVIEW");
    const res = await post(`/api/tasks/${id}/spec/approve`, { runtime: "gpt" });
    expect(res.statusCode).toBe(400);
  });
});

describe("approve with a paused implementation execution (P6)", () => {
  it("moves to IMPLEMENTING and enqueues exactly one resume_with_revision", async () => {
    const dep = await newTask("IMPLEMENTING");
    const { id } = await newTask("SPEC_REVIEW");
    const oldApproved = await seedRevision(id, 1, "approved", content());
    await setApprovedRevision(id, oldApproved);
    const draft = await seedRevision(id, 2, "draft", content({ dependencies: [dep.key] }));
    const paused = await seedExecution(h.db, id, {
      role: "implementation",
      state: "WAITING_FOR_USER",
    });
    await seedExecution(h.db, id, { role: "spec", state: "COMPLETED" });

    const res = await post(`/api/tasks/${id}/spec/approve`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ from: "SPEC_REVIEW", to: "IMPLEMENTING" });

    expect((await taskRow(id)).state).toBe("IMPLEMENTING");
    expect(await auditTriggers(id)).toEqual(["spec.approved", "spec.approved"]);
    const cmds = await commands(id);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({
      type: "resume_with_revision",
      execution_id: paused,
      created_by: fx.userId,
      payload: { revision_id: draft },
    });
    expect((await executionRow(paused)).state).toBe("WAITING_FOR_USER");
  });
});

describe("POST /api/tasks/:id/spec/revise (P8)", () => {
  it.each(["SPEC_APPROVED", "READY"] as const)(
    "copies the approved content into a new draft from %s",
    async (state) => {
      const { id } = await newTask(state);
      await seedRevision(id, 1, "superseded", content({ objective: "v1" }));
      const approved = await seedRevision(id, 2, "approved", content({ objective: "v2" }));
      await setApprovedRevision(id, approved);

      const res = await post(`/api/tasks/${id}/spec/revise`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ from: state, to: "SPEC_IN_PROGRESS" });

      const revs = await revisions(id);
      expect(revs.map((r) => [r.version, r.status])).toEqual([
        [1, "superseded"],
        [2, "approved"],
        [3, "draft"],
      ]);
      expect(revs[2]!.content).toEqual(content({ objective: "v2" }));
      expect(revs[2]!.created_by).toBe(fx.userId);
      expect(res.json().revisionId).toBe(revs[2]!.id);
      const task = await taskRow(id);
      expect(task.state).toBe("SPEC_IN_PROGRESS");
      expect(task.approved_revision_id).toBe(approved);
      expect(await auditTriggers(id)).toEqual(["spec.revise"]);
    },
  );

  it.each(["NEEDS_SPEC", "SPEC_IN_PROGRESS", "SPEC_REVIEW", "BLOCKED", "IMPLEMENTING"] as const)(
    "returns 409 from %s and writes nothing",
    async (state) => {
      const { id } = await newTask(state);
      const approved = await seedRevision(id, 1, "approved", content());
      await setApprovedRevision(id, approved);
      const before = await snapshot(id);
      const res = await post(`/api/tasks/${id}/spec/revise`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");
      expect(await snapshot(id)).toEqual(before);
    },
  );
});

describe("auth and unknown task (P9)", () => {
  const routes: Array<[string, string, unknown]> = [
    ["POST", "session", undefined],
    ["POST", "messages", { text: "hi" }],
    ["PUT", "draft", { content: content() }],
    ["POST", "request-review", undefined],
    ["POST", "send-back", undefined],
    ["POST", "approve", {}],
    ["POST", "revise", undefined],
  ];

  it.each(routes)("%s %s returns 401 without a session", async (method, path, body) => {
    const res = await app.inject({
      method: method as "POST",
      url: `/api/tasks/${UNKNOWN_ID}/spec/${path}`,
      ...(body === undefined ? {} : { payload: body as object }),
    });
    expect(res.statusCode).toBe(401);
  });

  it.each(routes)("%s %s returns 404 for an unknown task", async (method, path, body) => {
    const res = await app.inject({
      method: method as "POST",
      url: `/api/tasks/${UNKNOWN_ID}/spec/${path}`,
      headers: { cookie },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for a non-UUID task id", async () => {
    const res = await post(`/api/tasks/not-a-uuid/spec/session`);
    expect(res.statusCode).toBe(400);
  });
});

describe("concurrency (P10)", () => {
  it("two concurrent approves produce exactly one approval; the other is 409", async () => {
    const dep = await newTask("DONE");
    const { id } = await newTask("SPEC_REVIEW");
    await seedRevision(id, 1, "draft", content({ dependencies: [dep.key] }));

    const [a, b] = await Promise.all([
      post(`/api/tasks/${id}/spec/approve`),
      post(`/api/tasks/${id}/spec/approve`),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await approvals(id)).toHaveLength(1);
    expect(await auditTriggers(id)).toEqual(["spec.approved", "dependency.satisfied"]);
  });

  it("approve racing the dependency PATCH on the same task completes without deadlock", async () => {
    for (let i = 0; i < 5; i += 1) {
      const dep = await newTask("DONE");
      const patchDep = await newTask("DONE");
      const { id } = await newTask("SPEC_REVIEW");
      await seedRevision(id, 1, "draft", content({ dependencies: [dep.key] }));

      const [approve, patch] = await Promise.all([
        post(`/api/tasks/${id}/spec/approve`, { runtime: "codex" }),
        app.inject({
          method: "PATCH",
          url: `/api/tasks/${id}`,
          headers: { cookie },
          payload: { runtime_override: "claude", dependencies: [patchDep.key] },
        }),
      ]);
      expect(approve.statusCode).toBe(200);
      expect(patch.statusCode).toBe(200);
      expect(await approvals(id)).toHaveLength(1);
      expect((await dependencyIds(id)).length).toBe(1);
    }
  });

  it("approve racing the scheduler's promotion on the same task completes without deadlock", async () => {
    // The promotion transaction as `apps/worker/src/scheduler/promotion.ts`
    // runs it: graph lock, task row SKIP LOCKED, dependency read, transition.
    const promote = (taskId: string) =>
      h.db.transaction(async (tx) => {
        await lockDependencyGraph(tx);
        if (!(await lockTaskForPromotion(tx, taskId))) return null;
        const deps = await listDependencies(tx, taskId);
        if (!deps.every((d) => d.state === "DONE")) return null;
        await transition(tx, {
          entity: "task",
          id: taskId,
          trigger: "dependency.satisfied",
          actor: { kind: "worker" },
        });
        return "dependency.satisfied";
      });

    for (let i = 0; i < 5; i += 1) {
      const dep = await newTask("DONE");
      const { id } = await newTask("SPEC_REVIEW");
      await seedRevision(id, 1, "draft", content({ dependencies: [dep.key] }));

      const [approve, promoted] = await Promise.all([
        post(`/api/tasks/${id}/spec/approve`),
        promote(id),
      ]);
      expect(approve.statusCode).toBe(200);
      expect(promoted).toBeNull();
      expect((await taskRow(id)).state).toBe("READY");
    }

    // A task left SPEC_APPROVED by approve is promotable afterwards, and a
    // promotion holding the graph lock makes approve wait, not deadlock.
    const pending = await newTask("IMPLEMENTING");
    const waiting = await newTask("SPEC_REVIEW");
    await seedRevision(waiting.id, 1, "draft", content({ dependencies: [pending.key] }));
    const other = await newTask("SPEC_APPROVED");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = h.db.transaction(async (tx) => {
      await lockDependencyGraph(tx);
      await lockTaskForPromotion(tx, other.id);
      await held;
    });
    const approving = post(`/api/tasks/${waiting.id}/spec/approve`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await taskRow(waiting.id)).state).toBe("SPEC_REVIEW");
    release();
    await holder;
    expect((await approving).statusCode).toBe(200);
    expect((await taskRow(waiting.id)).state).toBe("SPEC_APPROVED");
  });

  // GOT.52 F2, kept by GOT.80 D2: a repository delete committing mid-approve
  // used to surface as an uncaught FK violation (23503), a 500.
  // `lockRepositoryById` locks the row it resolves, the same lock
  // `deleteRepository` takes, so the two serialise instead. A task's
  // repository is now locked at session start, not written by approve, so
  // each test below seeds it directly and only mirrors approve's *read*
  // lock to force the interleaving deterministically.
  it("repository delete blocks behind an approval holding the repository lock, then sees the task and returns 409 (never 500)", async () => {
    const repoId = await newRepo("race-approve-wins-repo");
    const { id: taskId } = await newTask("SPEC_REVIEW");
    await h.sql`update tasks set repository_id = ${repoId} where id = ${taskId}`;

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = h.sql.begin(async (sql) => {
      // Mirrors lockRepositoryById's locked read.
      await sql`select id from repositories where id = ${repoId} for update`;
      await held;
    });

    const deleting = app.inject({
      method: "DELETE",
      url: `/api/repositories/${repoId}`,
      headers: { cookie },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      await h.sql`select id from repositories where id = ${repoId}`,
    ).toHaveLength(1);

    release();
    await holder;

    const res = await deleting;
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: "REFERENCED_BY_TASKS", task_count: 1 },
    });
    expect(
      await h.sql`select id from repositories where id = ${repoId}`,
    ).toHaveLength(1);
  });

  // GOT.80 D2 narrows this race: a task's repository is locked at session
  // start, always before it can reach SPEC_REVIEW, so `deleteRepository`'s
  // own count check now always sees it and blocks — the old "delete
  // actually wins and removes the row out from under a pending approval"
  // interleaving is no longer reachable. What remains to prove is the
  // reverse lock-acquisition order: another holder of the same row lock
  // (mirroring `deleteRepository`'s own `FOR UPDATE`) still lets approval
  // proceed cleanly once released (never a 500), and the repository is
  // still there and still refused for deletion afterward.
  it("the delete route's own lock wins first: approval still proceeds after release, and delete still refuses (never 500)", async () => {
    const repoId = await newRepo("race-delete-wins-repo");
    const { id: taskId } = await newTask("SPEC_REVIEW");
    await h.sql`update tasks set repository_id = ${repoId} where id = ${taskId}`;
    await seedRevision(taskId, 1, "draft", content({ repository: "race-delete-wins-repo" }));

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = h.sql.begin(async (sql) => {
      // Mirrors deleteRepository's locked read, taken before approve's.
      await sql`select id from repositories where id = ${repoId} for update`;
      await held;
    });

    const approving = post(`/api/tasks/${taskId}/spec/approve`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await taskRow(taskId)).state).toBe("SPEC_REVIEW");

    release();
    await holder;

    const res = await approving;
    expect(res.statusCode).toBe(200);

    // Approval never touches the repository reference (GOT.80 D2), so the
    // task still references it and delete still refuses.
    const deleting = await app.inject({
      method: "DELETE",
      url: `/api/repositories/${repoId}`,
      headers: { cookie },
    });
    expect(deleting.statusCode).toBe(409);
  });
});

// Keep the other project's repository name distinct from this project's so
// the cross-project 422 case is meaningful.
describe("fixtures", () => {
  it("the other project owns OTHER_PROJECT_REPO", async () => {
    const rows = await h.sql<{ project_id: string }[]>`
      select project_id from repositories where name = ${OTHER_PROJECT_REPO}`;
    expect(rows.map((r) => r.project_id)).toEqual([fxOther.projectId]);
  });
});
