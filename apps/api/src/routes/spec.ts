import {
  RuntimeSchema,
  SpecContentSchema,
  TransitionError,
  assertTransition,
  validateSpecForApproval,
  type TaskState,
  type Trigger,
} from "@orchestra/core";
import {
  NotFoundError,
  appendEvent,
  approveRevision,
  findProjectRepositoryByName,
  getRevisionByStatus,
  hasPendingSpecResume,
  hasPendingSpecSessionStart,
  insertDraftRevision,
  insertExecutionCommand,
  listDependencies,
  lockDependencyGraph,
  lockTaskExecutionIds,
  lockTaskForSpec,
  replaceDependencies,
  resolveTaskIdsByJiraKey,
  transition,
  updateDraftRevisionContent,
  wouldCreateCycle,
  type Actor,
  type LockedSpecTask,
  type Tx,
} from "@orchestra/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";

const TaskIdParamsSchema = z.object({ id: z.uuid() });

function parseTaskId(params: unknown): string {
  const parsed = TaskIdParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "id must be a UUID.");
  }
  return parsed.data.id;
}

const MessageBodySchema = z.object({ text: z.string().min(1) }).strict();
const DraftBodySchema = z.object({ content: SpecContentSchema }).strict();
const ApproveBodySchema = z
  .object({ runtime: RuntimeSchema.optional() })
  .strict();

/** Execution states that are not ended (§5.2): a spec session that can take a message. */
const LIVE_EXECUTION_STATES = [
  "QUEUED",
  "ASSIGNED",
  "RUNNING",
  "WAITING_FOR_USER",
] as const;

/** Live spec execution states that request-review cannot complete, so it refuses. */
const BUSY_SPEC_EXECUTION_STATES = ["QUEUED", "ASSIGNED", "WAITING_FOR_USER"] as const;

/** The `send_message` text the send-back route enqueues (GOT.37 C45). */
const SENT_BACK_TEXT = "The specification was sent back for changes.";

/** Dependency states that make an approved task `BLOCKED` (§6.2). */
const FAILED_DEPENDENCY_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "FAILED",
  "CANCELLED",
]);

/**
 * §6.2 dependency decision, the same rule the scheduler's promotion applies:
 * any `FAILED`/`CANCELLED` dependency blocks, all `DONE` (or none) is ready,
 * anything else waits in `SPEC_APPROVED`.
 */
function decideDependencies(
  states: readonly TaskState[],
): "dependency.satisfied" | "dependency.failed" | null {
  if (states.some((s) => FAILED_DEPENDENCY_STATES.has(s))) {
    return "dependency.failed";
  }
  if (states.every((s) => s === "DONE")) {
    return "dependency.satisfied";
  }
  return null;
}

/** Same mapping as the task routes: 404 for an unknown task, 409 for an illegal move. */
function rethrowTransitionError(err: unknown): never {
  if (err instanceof NotFoundError) {
    throw new AppError(404, "NOT_FOUND", err.message);
  }
  if (err instanceof TransitionError) {
    throw new AppError(409, "ILLEGAL_TRANSITION", err.message);
  }
  throw err;
}

function userActor(request: FastifyRequest): Actor {
  return { kind: "user", id: request.user!.id };
}

/**
 * Locks the task row and returns it, or throws 404. When `trigger` is given
 * the move is checked against the core table now, before any other read or
 * write, so a wrong state is a 409 and never a later validation error.
 */
async function lockTask(
  tx: Tx,
  taskId: string,
  trigger?: Trigger,
): Promise<LockedSpecTask> {
  const task = await lockTaskForSpec(tx, taskId);
  if (!task) {
    throw new NotFoundError("task", taskId);
  }
  if (trigger !== undefined) {
    assertTransition("task", task.state, trigger);
  }
  return task;
}

function requireDraft<T>(draft: T | null): T {
  if (!draft) {
    throw new AppError(409, "NO_DRAFT", "The task has no draft revision.");
  }
  return draft;
}

/**
 * Specification routes (design.md §12.3). Each runs in one transaction that
 * moves state only through `transition()` and writes any command it enqueues
 * alongside. Lock order: the dependency-graph advisory lock (approve only),
 * then the task row, then execution rows.
 */
export default async function specRoutes(app: FastifyInstance): Promise<void> {
  app.post("/tasks/:id/spec/session", async (request) => {
    const id = parseTaskId(request.params);
    const actor = userActor(request);
    try {
      return await app.db.transaction(async (tx) => {
        const task = await lockTask(tx, id);
        let result: { from: TaskState; to: TaskState };
        if (task.state === "SPEC_IN_PROGRESS") {
          // C49: restart a spec session that failed or was orphaned (for
          // example after a dead-host release), with no task transition.
          const live = await lockTaskExecutionIds(tx, id, "spec", LIVE_EXECUTION_STATES);
          // F1: a send-back not yet processed will resume the COMPLETED
          // session; a restart now would leave two live spec sessions.
          if (live.length > 0 || (await hasPendingSpecResume(tx, id))) {
            throw new AppError(
              409,
              "SPEC_SESSION_BUSY",
              "The task already has a live spec session.",
            );
          }
          result = { from: task.state, to: task.state };
        } else {
          result = await transition(tx, {
            entity: "task",
            id,
            trigger: "spec.session_started",
            actor,
          });
        }
        await insertExecutionCommand(tx, {
          taskId: id,
          executionId: null,
          type: "start_spec_session",
          payload: {},
          createdBy: actor.id!,
          now: app.now(),
        });
        return { from: result.from, to: result.to };
      });
    } catch (err) {
      rethrowTransitionError(err);
    }
  });

  app.post("/tasks/:id/spec/messages", async (request) => {
    const id = parseTaskId(request.params);
    const body = MessageBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw new AppError(400, "VALIDATION_ERROR", "text must be a non-empty string.");
    }
    const actor = userActor(request);
    try {
      return await app.db.transaction(async (tx) => {
        await lockTask(tx, id);
        const [executionId] = await lockTaskExecutionIds(
          tx,
          id,
          "spec",
          LIVE_EXECUTION_STATES,
        );
        if (!executionId) {
          throw new AppError(
            409,
            "NO_LIVE_SPEC_EXECUTION",
            "The task has no live spec execution to message.",
          );
        }
        const command = await insertExecutionCommand(tx, {
          taskId: id,
          executionId,
          type: "send_message",
          payload: { text: body.data.text },
          createdBy: actor.id!,
          now: app.now(),
        });
        return { commandId: command.id, executionId };
      });
    } catch (err) {
      rethrowTransitionError(err);
    }
  });

  app.put("/tasks/:id/spec/draft", async (request) => {
    const id = parseTaskId(request.params);
    const body = DraftBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Invalid specification content: ${body.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const actor = userActor(request);
    try {
      return await app.db.transaction(async (tx) => {
        const task = await lockTask(tx, id);
        if (task.state !== "SPEC_IN_PROGRESS") {
          throw new AppError(
            409,
            "ILLEGAL_STATE",
            `The draft can only be edited in SPEC_IN_PROGRESS, task is ${task.state}.`,
          );
        }
        const now = app.now();
        const existing = await getRevisionByStatus(tx, id, "draft");
        const revision = existing
          ? await updateDraftRevisionContent(tx, existing.id, body.data.content, now)
          : await insertDraftRevision(tx, {
              taskId: id,
              content: body.data.content,
              createdBy: actor.id!,
              now,
            });
        await appendEvent(tx, {
          taskId: id,
          type: "spec.revised",
          payload: {
            revision_id: revision.id,
            version: revision.version,
            actor: { kind: actor.kind, id: actor.id },
          },
        });
        return revision;
      });
    } catch (err) {
      rethrowTransitionError(err);
    }
  });

  app.post("/tasks/:id/spec/request-review", async (request) => {
    const id = parseTaskId(request.params);
    const actor = userActor(request);
    try {
      return await app.db.transaction(async (tx) => {
        await lockTask(tx, id, "spec.review_requested");
        requireDraft(await getRevisionByStatus(tx, id, "draft"));
        // A start_spec_session command not yet completed means a spec agent is
        // about to start and could overwrite the draft under review. Checked
        // before the execution read: once the command reads as completed, the
        // execution it created is visible to the next statement.
        if (await hasPendingSpecSessionStart(tx, id)) {
          throw new AppError(
            409,
            "SPEC_SESSION_BUSY",
            "The spec session is still starting. Review can be requested once it is running or has ended.",
          );
        }
        // Only a RUNNING spec execution can be completed here (§5.2). Any other
        // live one would survive approval and keep the scheduler from ever
        // promoting or claiming the task, so refuse before any write.
        const busy = await lockTaskExecutionIds(tx, id, "spec", BUSY_SPEC_EXECUTION_STATES);
        if (busy.length > 0) {
          throw new AppError(
            409,
            "SPEC_SESSION_BUSY",
            "The spec session is queued, assigned or waiting for the user. Review can be requested once it is running or has ended.",
          );
        }
        const result = await transition(tx, {
          entity: "task",
          id,
          trigger: "spec.review_requested",
          actor,
        });
        const running = await lockTaskExecutionIds(tx, id, "spec", ["RUNNING"]);
        for (const executionId of running) {
          await transition(tx, {
            entity: "execution",
            id: executionId,
            trigger: "execution.completed",
            actor,
            // §8: the agent-tools token is revoked when an execution leaves RUNNING.
            set: { endedAt: app.now(), toolsTokenHash: null },
          });
        }
        return { from: result.from, to: result.to };
      });
    } catch (err) {
      rethrowTransitionError(err);
    }
  });

  app.post("/tasks/:id/spec/send-back", async (request) => {
    const id = parseTaskId(request.params);
    const actor = userActor(request);
    try {
      return await app.db.transaction(async (tx) => {
        // `transition()` locks the task row before the execution rows below.
        const result = await transition(tx, {
          entity: "task",
          id,
          trigger: "spec.sent_back",
          actor,
        });
        // §5.2 "sending the spec back to draft resumes it" (C45): the worker
        // moves the most recent COMPLETED spec execution back to RUNNING and
        // resumes its session. With none (a hand-written draft), nothing is
        // enqueued and the user edits the draft by hand.
        const completed = await lockTaskExecutionIds(tx, id, "spec", ["COMPLETED"]);
        const latest = completed[completed.length - 1];
        if (latest) {
          await insertExecutionCommand(tx, {
            taskId: id,
            executionId: latest,
            type: "send_message",
            payload: { text: SENT_BACK_TEXT, system: "sent_back" },
            createdBy: actor.id!,
            now: app.now(),
          });
        }
        return { from: result.from, to: result.to };
      });
    } catch (err) {
      rethrowTransitionError(err);
    }
  });

  app.post("/tasks/:id/spec/approve", async (request) => {
    const id = parseTaskId(request.params);
    const body = ApproveBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "runtime must be 'claude' or 'codex' when given.",
      );
    }
    const requestedRuntime = body.data.runtime;
    const actor = userActor(request);

    try {
      return await app.db.transaction(async (tx) => {
        // J5 lock order: graph advisory lock, task row, execution rows.
        await lockDependencyGraph(tx);
        const task = await lockTask(tx, id);
        // Core also allows spec.approved from SPEC_APPROVED (the paused-execution
        // edge), so the route admits only SPEC_REVIEW, before any other read or write.
        if (task.state !== "SPEC_REVIEW") {
          throw new AppError(
            409,
            "ILLEGAL_TRANSITION",
            `Specification can only be approved in SPEC_REVIEW, task is ${task.state}.`,
          );
        }
        const draft = requireDraft(await getRevisionByStatus(tx, id, "draft"));

        // Validation first: every 422 below is thrown before any write.
        const draftContent = draft.content as { repository?: unknown };
        const repository =
          typeof draftContent?.repository === "string"
            ? await findProjectRepositoryByName(
                tx,
                task.projectId,
                draftContent.repository,
              )
            : null;
        const validation = validateSpecForApproval(
          draft.content,
          (name) => repository !== null && repository.name === name,
        );
        if (!validation.ok) {
          throw new AppError(
            422,
            "SPEC_INVALID",
            `Specification cannot be approved: ${validation.errors.join("; ")}`,
          );
        }
        const spec = validation.content;

        const { found, unknown } = await resolveTaskIdsByJiraKey(
          tx,
          spec.dependencies,
        );
        if (unknown.length > 0) {
          throw new AppError(
            422,
            "UNKNOWN_DEPENDENCY",
            `Unknown Jira key(s): ${unknown.join(", ")}`,
          );
        }
        const dependsOnTaskIds = spec.dependencies.map((key) => found.get(key)!);
        const cycle = await wouldCreateCycle(tx, id, dependsOnTaskIds);
        if (cycle) {
          throw new AppError(
            422,
            "DEPENDENCY_CYCLE",
            `dependency cycle: ${cycle.jiraKeys.join(" -> ")}`,
          );
        }

        const now = app.now();
        const runtime = requestedRuntime ?? repository!.defaultRuntime;
        await approveRevision(tx, {
          taskId: id,
          revisionId: draft.id,
          approvedBy: actor.id!,
          runtime,
          now,
        });
        const approved = await transition(tx, {
          entity: "task",
          id,
          trigger: "spec.approved",
          actor,
          set: {
            repositoryId: repository!.id,
            runtimeOverride: requestedRuntime ?? null,
            approvedRevisionId: draft.id,
          },
        });
        await replaceDependencies(tx, id, dependsOnTaskIds);
        await appendEvent(tx, {
          taskId: id,
          type: "spec.approved",
          payload: {
            revision_id: draft.id,
            version: draft.version,
            runtime,
            actor: { kind: actor.kind, id: actor.id },
          },
        });

        let to: TaskState = approved.to;
        const [pausedExecutionId] = await lockTaskExecutionIds(
          tx,
          id,
          "implementation",
          ["WAITING_FOR_USER"],
        );
        if (pausedExecutionId) {
          // J4 / §10.4: approval of a revision with a paused execution resumes it.
          const resumed = await transition(tx, {
            entity: "task",
            id,
            trigger: "spec.approved",
            actor,
          });
          await insertExecutionCommand(tx, {
            taskId: id,
            executionId: pausedExecutionId,
            type: "resume_with_revision",
            payload: { revision_id: draft.id },
            createdBy: actor.id!,
            now,
          });
          to = resumed.to;
        } else {
          const dependencies = await listDependencies(tx, id);
          const trigger = decideDependencies(dependencies.map((d) => d.state));
          if (trigger !== null) {
            to = (await transition(tx, { entity: "task", id, trigger, actor })).to;
          }
        }

        return { from: approved.from, to, revisionId: draft.id };
      });
    } catch (err) {
      rethrowTransitionError(err);
    }
  });

  app.post("/tasks/:id/spec/revise", async (request) => {
    const id = parseTaskId(request.params);
    const actor = userActor(request);
    try {
      return await app.db.transaction(async (tx) => {
        await lockTask(tx, id, "spec.revise");
        const approved = await getRevisionByStatus(tx, id, "approved");
        if (!approved) {
          throw new AppError(
            409,
            "NO_APPROVED_REVISION",
            "The task has no approved revision to revise.",
          );
        }
        if (await getRevisionByStatus(tx, id, "draft")) {
          throw new AppError(409, "DRAFT_EXISTS", "The task already has a draft revision.");
        }
        const draft = await insertDraftRevision(tx, {
          taskId: id,
          content: approved.content,
          createdBy: actor.id!,
          now: app.now(),
        });
        const result = await transition(tx, {
          entity: "task",
          id,
          trigger: "spec.revise",
          actor,
        });
        return { from: result.from, to: result.to, revisionId: draft.id };
      });
    } catch (err) {
      rethrowTransitionError(err);
    }
  });
}
