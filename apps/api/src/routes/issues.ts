import {
  IssueStatusSchema,
  ResolutionKindSchema,
  TransitionError,
  assertTransition,
  type IssueStatus,
  type ResolutionKind,
} from "@orchestra/core";
import {
  NotFoundError,
  appendEvent,
  getIssueDetail,
  getIssueLocation,
  getRevisionByStatus,
  insertDraftRevision,
  insertExecutionCommand,
  insertIssueMessage,
  insertTaskDecision,
  listIssues,
  lockExecutionForTool,
  lockIssue,
  lockTaskForSpec,
  resolveIssue,
  supersedeOtherOpenIssues,
  transition,
  type Actor,
  type IssueLocation,
  type IssueRow,
  type LockedSpecTask,
  type Tx,
} from "@orchestra/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";

const IssueIdParamsSchema = z.object({ id: z.uuid() });

function parseIssueId(params: unknown): string {
  const parsed = IssueIdParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "id must be a UUID.");
  }
  return parsed.data.id;
}

const IssueListQuerySchema = z.object({
  status: z.string().optional(),
  blocking: z.string().optional(),
});

const MessageBodySchema = z.object({ text: z.string().min(1) }).strict();

const ResolveBodySchema = z
  .object({
    kind: ResolutionKindSchema,
    decision: z.string().min(1),
    clarification: z.string().optional(),
    chosen_option: z.string().optional(),
  })
  .strict();

/** Same mapping as the spec/task routes: 404 for an unknown task or execution, 409 for an illegal move. */
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

interface LockedIssueChain {
  location: IssueLocation;
  task: LockedSpecTask;
  execution: { state: string };
  issue: IssueRow;
}

/**
 * Locks the task row, then the issue's execution row, then the issue row
 * itself (design.md §10.2-§10.4 lock order), and throws 404 for an unknown
 * issue. Both `/messages` and `/resolve` start with this.
 */
async function lockIssueChain(tx: Tx, issueId: string): Promise<LockedIssueChain> {
  const location = await getIssueLocation(tx, issueId);
  if (!location) {
    throw new AppError(404, "NOT_FOUND", `issue not found: ${issueId}`);
  }
  const task = await lockTaskForSpec(tx, location.taskId);
  if (!task) {
    throw new NotFoundError("task", location.taskId);
  }
  const execution = await lockExecutionForTool(tx, location.executionId);
  if (!execution) {
    throw new NotFoundError("execution", location.executionId);
  }
  const issue = await lockIssue(tx, issueId);
  if (!issue) {
    throw new AppError(404, "NOT_FOUND", `issue not found: ${issueId}`);
  }
  return { location, task, execution, issue };
}

/**
 * The common write of every resolve path (design.md §10.3, §10.4, §10.5):
 * marks the issue `RESOLVED`, inserts its `task_decisions` row and appends
 * `issue.resolved`. Caller already holds the issue and execution locks.
 */
async function writeResolution(
  tx: Tx,
  params: {
    issue: IssueRow;
    location: IssueLocation;
    kind: ResolutionKind;
    decision: string;
    clarification: string | undefined;
    chosenOption: string | undefined;
    resolvedBy: string;
    now: Date;
  },
): Promise<{ id: string }> {
  await resolveIssue(tx, {
    issueId: params.issue.id,
    resolutionKind: params.kind,
    resolution: params.decision,
    resolvedBy: params.resolvedBy,
    now: params.now,
  });
  const decisionRow = await insertTaskDecision(tx, {
    taskId: params.location.taskId,
    issueId: params.issue.id,
    decision: params.decision,
    clarification: params.clarification ?? null,
    chosenOption: params.chosenOption ?? null,
    decidedBy: params.resolvedBy,
    now: params.now,
  });
  await appendEvent(tx, {
    taskId: params.location.taskId,
    executionId: params.location.executionId,
    type: "issue.resolved",
    payload: {
      issue_id: params.issue.id,
      decision_id: decisionRow.id,
      kind: params.kind,
      blocking: params.issue.blocking,
    },
  });
  return decisionRow;
}

/**
 * Copies the approved content, appending a block with the decision text
 * (always present verbatim), the clarification and the chosen option when
 * given, to `notes` (design.md §10.4). Any prior notes are kept, separated
 * by a blank line.
 */
function buildRevisedContent(
  approvedContent: unknown,
  decision: string,
  clarification: string | undefined,
  chosenOption: string | undefined,
): unknown {
  const base = (
    approvedContent && typeof approvedContent === "object" ? approvedContent : {}
  ) as Record<string, unknown>;
  const existingNotes = typeof base["notes"] === "string" ? (base["notes"] as string) : "";

  const lines = [`Issue resolution: ${decision}`];
  if (chosenOption !== undefined) {
    lines.push(`Chosen option: ${chosenOption}`);
  }
  if (clarification !== undefined) {
    lines.push(`Clarification: ${clarification}`);
  }
  const block = lines.join("\n");

  return { ...base, notes: existingNotes ? `${existingNotes}\n\n${block}` : block };
}

/**
 * Issue and decision routes (design.md §10.2-§10.5, §12.4). `/messages`
 * and `/resolve` each run in one transaction, lock order task -> execution
 * -> issue, and write nothing on any 4xx path.
 */
export default async function issuesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const parsed = IssueListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "invalid query parameters.");
    }
    const { status, blocking } = parsed.data;

    let statusFilter: IssueStatus | undefined;
    if (status !== undefined) {
      const statusResult = IssueStatusSchema.safeParse(status);
      if (!statusResult.success) {
        throw new AppError(400, "VALIDATION_ERROR", `Unknown status: ${status}`);
      }
      statusFilter = statusResult.data;
    }

    let blockingFilter: boolean | undefined;
    if (blocking !== undefined) {
      if (blocking !== "1" && blocking !== "0") {
        throw new AppError(400, "VALIDATION_ERROR", "blocking must be '1' or '0'.");
      }
      blockingFilter = blocking === "1";
    }

    return listIssues(app.db, { status: statusFilter, blocking: blockingFilter });
  });

  app.get("/:id", async (request) => {
    const id = parseIssueId(request.params);
    const detail = await getIssueDetail(app.db, id);
    if (!detail) {
      throw new AppError(404, "NOT_FOUND", `issue not found: ${id}`);
    }
    return {
      issue: detail.issue,
      messages: detail.messages,
      execution: detail.execution,
      task: { id: detail.task.id, jira_key: detail.task.jiraKey, state: detail.task.state },
      decision: detail.decision,
    };
  });

  app.post("/:id/messages", async (request) => {
    const id = parseIssueId(request.params);
    const body = MessageBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw new AppError(400, "VALIDATION_ERROR", "text must be a non-empty string.");
    }
    const actor = userActor(request);

    try {
      return await app.db.transaction(async (tx) => {
        const { location, execution, issue } = await lockIssueChain(tx, id);

        if (issue.status !== "OPEN") {
          throw new AppError(409, "ISSUE_NOT_OPEN", `Issue is ${issue.status}, not OPEN.`);
        }
        if (execution.state !== "WAITING_FOR_USER") {
          throw new AppError(
            409,
            "EXECUTION_NOT_WAITING",
            `The issue's execution is ${execution.state}, not WAITING_FOR_USER.`,
          );
        }

        const now = app.now();
        const message = await insertIssueMessage(tx, {
          issueId: id,
          userId: actor.id!,
          body: body.data.text,
          now,
        });
        const command = await insertExecutionCommand(tx, {
          taskId: location.taskId,
          executionId: location.executionId,
          type: "send_message",
          payload: { issue_id: id, text: body.data.text },
          createdBy: actor.id!,
          now,
        });
        await appendEvent(tx, {
          taskId: location.taskId,
          executionId: location.executionId,
          type: "issue.message",
          payload: { issue_id: id, message_id: message.id, author_kind: "user" },
        });

        return { messageId: message.id, commandId: command.id, executionId: location.executionId };
      });
    } catch (err) {
      rethrowTransitionError(err);
    }
  });

  app.post("/:id/resolve", async (request) => {
    const id = parseIssueId(request.params);
    const body = ResolveBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Invalid resolution: ${body.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const { kind, decision, clarification, chosen_option: chosenOption } = body.data;
    const actor = userActor(request);

    try {
      return await app.db.transaction(async (tx) => {
        const { location, task, execution, issue } = await lockIssueChain(tx, id);

        if (issue.status !== "OPEN") {
          throw new AppError(409, "ISSUE_NOT_OPEN", `Issue is ${issue.status}, not OPEN.`);
        }

        const now = app.now();

        if (!issue.blocking) {
          if (kind !== "clarification") {
            throw new AppError(
              409,
              "ILLEGAL_RESOLUTION",
              "A non-blocking issue can only be resolved as a clarification.",
            );
          }
          const decisionRow = await writeResolution(tx, {
            issue,
            location,
            kind,
            decision,
            clarification,
            chosenOption,
            resolvedBy: actor.id!,
            now,
          });
          return {
            issueId: id,
            decisionId: decisionRow.id,
            kind,
            commandId: null,
            task: null,
            revisionId: null,
          };
        }

        if (kind === "clarification") {
          if (execution.state !== "WAITING_FOR_USER") {
            throw new AppError(
              409,
              "EXECUTION_NOT_WAITING",
              `The issue's execution is ${execution.state}, not WAITING_FOR_USER.`,
            );
          }
          const decisionRow = await writeResolution(tx, {
            issue,
            location,
            kind,
            decision,
            clarification,
            chosenOption,
            resolvedBy: actor.id!,
            now,
          });
          const command = await insertExecutionCommand(tx, {
            taskId: location.taskId,
            executionId: location.executionId,
            type: "resume_with_decision",
            payload: { issue_id: id, decision_id: decisionRow.id },
            createdBy: actor.id!,
            now,
          });
          return {
            issueId: id,
            decisionId: decisionRow.id,
            kind,
            commandId: command.id,
            task: null,
            revisionId: null,
          };
        }

        // Blocking spec_revision: checked in this order, before any write
        // (design.md §10.4).
        assertTransition("task", task.state, "issue.resolved.spec_revision");
        if (execution.state !== "WAITING_FOR_USER") {
          throw new AppError(
            409,
            "EXECUTION_NOT_WAITING",
            `The issue's execution is ${execution.state}, not WAITING_FOR_USER.`,
          );
        }
        const approved = await getRevisionByStatus(tx, location.taskId, "approved");
        if (!approved) {
          throw new AppError(
            409,
            "NO_APPROVED_REVISION",
            "The task has no approved revision to revise.",
          );
        }
        if (await getRevisionByStatus(tx, location.taskId, "draft")) {
          throw new AppError(409, "DRAFT_EXISTS", "The task already has a draft revision.");
        }

        const decisionRow = await writeResolution(tx, {
          issue,
          location,
          kind,
          decision,
          clarification,
          chosenOption,
          resolvedBy: actor.id!,
          now,
        });

        const draft = await insertDraftRevision(tx, {
          taskId: location.taskId,
          content: buildRevisedContent(approved.content, decision, clarification, chosenOption),
          createdBy: actor.id!,
          now,
        });
        const result = await transition(tx, {
          entity: "task",
          id: location.taskId,
          trigger: "issue.resolved.spec_revision",
          actor,
        });
        await appendEvent(tx, {
          taskId: location.taskId,
          executionId: null,
          type: "spec.revised",
          payload: {
            revision_id: draft.id,
            version: draft.version,
            source: "issue_resolution",
            issue_id: id,
          },
        });

        const supersededIds = await supersedeOtherOpenIssues(tx, {
          executionId: location.executionId,
          excludeIssueId: id,
          now,
        });
        for (const supersededId of supersededIds) {
          await appendEvent(tx, {
            taskId: location.taskId,
            executionId: location.executionId,
            type: "issue.resolved",
            payload: { issue_id: supersededId, status: "SUPERSEDED", superseded_by: id },
          });
        }

        return {
          issueId: id,
          decisionId: decisionRow.id,
          kind,
          commandId: null,
          task: { from: result.from, to: result.to },
          revisionId: draft.id,
        };
      });
    } catch (err) {
      rethrowTransitionError(err);
    }
  });
}
