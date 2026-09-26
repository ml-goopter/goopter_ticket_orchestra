import { eq, sql } from "drizzle-orm";
import { appendEvent } from "../events.js";
import { executions } from "../schema/executions.js";
import { projects } from "../schema/projects.js";
import { tasks } from "../schema/tasks.js";
import { NotFoundError, transition, type Actor, type Tx } from "../transition.js";
import { lockExecutionForTool, lockTaskForTool } from "./agent-tools.js";
import { insertExecutionCommand } from "./spec.js";

/**
 * The `ci.failed` side effects (design.md §5.3, §11.2, GOT.39 C16), shared
 * by the GitHub poller (GOT.46) and anything else that observes a failed
 * check run.
 */

export interface CiFailedCheck {
  name: string;
  url: string;
  /** Tail of the check's log; the resume prompt keeps up to 200 lines (§9.2). */
  log_excerpt: string;
}

export interface ApplyCiFailureInput {
  taskId: string;
  executionId: string;
  pullRequestId: string;
  headSha: string;
  checks: readonly CiFailedCheck[];
  actor: Actor;
  now: Date;
}

/** Payload of the `resume_with_ci_failure` command this enqueues. */
export interface ResumeWithCiFailurePayload {
  pull_request_id: string;
  head_sha: string;
  round: number;
  checks: CiFailedCheck[];
}

export interface ApplyCiFailureResult {
  /** `executions.ci_rounds` after the increment. */
  round: number;
  /** True when the round exceeded `max_ci_rounds` and the task went NEEDS_HUMAN. */
  escalated: boolean;
  /** The enqueued command, or null when escalated. */
  commandId: string | null;
}

/**
 * Runs inside the caller's transaction. Locks the task, then the execution
 * (carry-forward lock order), then: task CI_RUNNING -> IMPLEMENTING
 * (`ci.failed`), `executions.ci_rounds++` in place, a `ci.failed` event with
 * the check names and urls. If the new round exceeds the project's
 * `max_ci_rounds`, the task goes NEEDS_HUMAN (`task.escalated`) with
 * `needs_human_reason` and nothing is enqueued; otherwise a
 * `resume_with_ci_failure` command is. A task not in CI_RUNNING throws
 * `TransitionError` and the transaction writes nothing.
 */
export async function applyCiFailure(
  tx: Tx,
  input: ApplyCiFailureInput,
): Promise<ApplyCiFailureResult> {
  if (!(await lockTaskForTool(tx, input.taskId))) {
    throw new NotFoundError("task", input.taskId);
  }
  if (!(await lockExecutionForTool(tx, input.executionId))) {
    throw new NotFoundError("execution", input.executionId);
  }

  await transition(tx, {
    entity: "task",
    id: input.taskId,
    trigger: "ci.failed",
    actor: input.actor,
  });

  const [counted] = await tx
    .update(executions)
    .set({ ciRounds: sql`${executions.ciRounds} + 1` })
    .where(eq(executions.id, input.executionId))
    .returning({ ciRounds: executions.ciRounds });
  const round = counted!.ciRounds;

  await appendEvent(tx, {
    taskId: input.taskId,
    executionId: input.executionId,
    type: "ci.failed",
    payload: {
      pull_request_id: input.pullRequestId,
      head_sha: input.headSha,
      round,
      checks: input.checks.map((c) => ({ name: c.name, url: c.url })),
    },
  });

  const [limits] = await tx
    .select({ maxCiRounds: projects.maxCiRounds })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, input.taskId));
  const max = limits!.maxCiRounds;

  if (round > max) {
    await transition(tx, {
      entity: "task",
      id: input.taskId,
      trigger: "task.escalated",
      actor: input.actor,
      set: {
        needsHumanReason: `CI round limit exceeded: round ${round} > max_ci_rounds ${max}`,
      },
    });
    return { round, escalated: true, commandId: null };
  }

  const payload: ResumeWithCiFailurePayload = {
    pull_request_id: input.pullRequestId,
    head_sha: input.headSha,
    round,
    checks: input.checks.map((c) => ({
      name: c.name,
      url: c.url,
      log_excerpt: c.log_excerpt,
    })),
  };
  const command = await insertExecutionCommand(tx, {
    taskId: input.taskId,
    executionId: input.executionId,
    type: "resume_with_ci_failure",
    payload,
    createdBy: null,
    now: input.now,
  });
  return { round, escalated: false, commandId: command.id };
}
