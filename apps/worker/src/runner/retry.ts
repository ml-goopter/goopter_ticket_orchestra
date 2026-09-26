import { classifyRetriable } from "@orchestra/adapters";
import { resolveTransition, type EndReason } from "@orchestra/core";
import {
  appendEvent,
  countProtocolViolations,
  insertNotification,
  insertRetryExecution,
  loadFailurePolicyContext,
  setNeedsHumanReasonIfMissing,
  transition,
  type Actor,
  type FailurePolicyContext,
  type Tx,
} from "@orchestra/db";
import type { Logger } from "../logger.js";

/**
 * Failure classification and retry policy (design.md §9.5, §6.5). The class
 * is decided from how the execution ended, never from agent prose.
 */

export type FailureClass = "infrastructure" | "protocol" | "business" | "user";

/**
 * - `retry`: new execution with backoff (infrastructure, retriable).
 * - `nudge`: new execution resumed with a protocol nudge (protocol).
 * - `escalate`: the task goes NEEDS_HUMAN (terminal infrastructure, business).
 * - `none`: nothing (user).
 */
export type FailureAction = "retry" | "nudge" | "escalate" | "none";

export interface FailureClassification {
  class: FailureClass;
  action: FailureAction;
}

/** `30 s * 2^n` (§9.5): the base. */
export const INFRA_RETRY_BACKOFF_BASE_MS = 30_000;

/** Longest `needs_human_reason` and notification title the policy writes. */
const REASON_MAX_CHARS = 500;
const TITLE_MAX_CHARS = 200;

/** Default missing call when a protocol violation's detail names none. */
const DEFAULT_MISSING_TOOL_CALL = "report_pr_created or report_failed";

/** Task states a retry execution may run in (§9.5; the starter's filter). */
const RETRYABLE_TASK_STATES = new Set(["IMPLEMENTING", "REVIEWING"]);

/**
 * The backoff before an infrastructure retry, `n` being the retries the
 * failed execution had already used.
 */
export function infraRetryBackoffMs(retriesUsed: number): number {
  return INFRA_RETRY_BACKOFF_BASE_MS * 2 ** retriesUsed;
}

/**
 * The runner stores an adapter error's `end_detail` as JSON
 * `{ message, retriable }`. Any other text (for example "claude adapter not
 * available") is classified by the adapter's terminal patterns.
 */
function parseAdapterError(detail: string | null): {
  message: string;
  retriable: boolean;
} {
  const text = detail ?? "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { retriable?: unknown }).retriable === "boolean"
    ) {
      const { message, retriable } = parsed as {
        message?: unknown;
        retriable: boolean;
      };
      return {
        message: typeof message === "string" ? message : text,
        retriable,
      };
    }
  } catch {
    // Not JSON: fall through.
  }
  return { message: text, retriable: classifyRetriable(text) };
}

/** design.md §9.5 table. Pure. */
export function classifyFailure(
  endReason: EndReason,
  endDetail: string | null,
): FailureClassification {
  switch (endReason) {
    case "adapter_error":
      return parseAdapterError(endDetail).retriable
        ? { class: "infrastructure", action: "retry" }
        : { class: "infrastructure", action: "escalate" };
    case "process_crash":
    case "lease_expired":
    case "agent_hung":
    case "setup_failed":
      return { class: "infrastructure", action: "retry" };
    case "protocol_violation":
      return { class: "protocol", action: "nudge" };
    case "agent_gave_up":
    case "budget_exceeded":
      return { class: "business", action: "escalate" };
    case "cancelled":
      return { class: "user", action: "none" };
    default: {
      const exhaustive: never = endReason;
      throw new Error(`unclassified end reason: ${String(exhaustive)}`);
    }
  }
}

/** The protocol nudge marker in an `execution.queued` payload (C26). */
export interface QueuedNudge {
  kind: "protocol_nudge";
  missing_tool_call: string;
}

/** `execution.queued` payload of a retry execution (§9.6). */
export interface RetryQueuedPayload {
  attempt: number;
  /** The failed execution this one retries. */
  retry_of: string;
  /** ISO instant before which no starter takes the row. */
  not_before: string;
  nudge?: QueuedNudge;
}

/** Reads a retry's `execution.queued` payload; null when it is not one. */
export function parseRetryQueuedPayload(payload: unknown): RetryQueuedPayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.attempt !== "number" ||
    typeof p.retry_of !== "string" ||
    typeof p.not_before !== "string"
  ) {
    return null;
  }
  const out: RetryQueuedPayload = {
    attempt: p.attempt,
    retry_of: p.retry_of,
    not_before: p.not_before,
  };
  const nudge = p.nudge as Record<string, unknown> | undefined;
  if (
    nudge &&
    nudge.kind === "protocol_nudge" &&
    typeof nudge.missing_tool_call === "string"
  ) {
    out.nudge = { kind: "protocol_nudge", missing_tool_call: nudge.missing_tool_call };
  }
  return out;
}

export type FailurePolicyOutcome =
  | { kind: "none" }
  /** The task was already NEEDS_HUMAN with no reason; one was set. */
  | { kind: "reason_set" }
  | { kind: "retry"; executionId: string; notBefore: Date; nudge: boolean }
  | { kind: "escalated"; reason: string; taskMoved: boolean };

export interface ApplyFailurePolicyInput extends FailurePolicyContext {
  endReason: EndReason;
  endDetail: string | null;
  actor: Actor;
  now: Date;
  logger?: Logger;
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** One line naming the failure: `<end_reason>: <detail message>`. */
function describeFailure(endReason: EndReason, endDetail: string | null): string {
  const message =
    endReason === "adapter_error"
      ? parseAdapterError(endDetail).message
      : (endDetail ?? "");
  const firstLine = message.trim().split("\n")[0] ?? "";
  return firstLine === "" ? endReason : `${endReason}: ${firstLine}`;
}

/** `expected <calls>` in the protocol violation detail, else the default. */
function missingToolCall(endDetail: string | null): string {
  const match = /expected (.+)$/.exec(endDetail ?? "");
  return match?.[1]?.trim() || DEFAULT_MISSING_TOOL_CALL;
}

/**
 * Task -> NEEDS_HUMAN (`task.escalated`) with `reason`, plus a broadcast
 * `needs_human` notification. A task with no escalation edge (a spec
 * execution's SPEC_IN_PROGRESS) is not moved: the notification and a log
 * line are the record.
 */
async function escalate(
  tx: Tx,
  input: ApplyFailurePolicyInput,
  reason: string,
): Promise<FailurePolicyOutcome> {
  const { task, execution, actor } = input;
  const clipped = clip(reason, REASON_MAX_CHARS);
  const taskMoved = resolveTransition("task", task.state, "task.escalated").ok;
  if (taskMoved) {
    await transition(tx, {
      entity: "task",
      id: task.id,
      trigger: "task.escalated",
      actor,
      set: { needsHumanReason: clipped },
    });
  } else {
    input.logger?.warn(
      { taskId: task.id, executionId: execution.id, taskState: task.state, reason: clipped },
      "execution failed and needs a human, but the task has no escalation edge; not moved",
    );
  }
  await insertNotification(tx, {
    userId: null,
    taskId: task.id,
    kind: "needs_human",
    title: clip(`${task.jiraKey} needs a human: ${clipped}`, TITLE_MAX_CHARS),
  });
  return { kind: "escalated", reason: clipped, taskMoved };
}

/**
 * A new `QUEUED` execution of the same task, role, runtime, model,
 * specification revision and branch, `attempt + 1`, no host, the failed
 * session id copied so the starter can try to resume it, then its
 * `execution.queued` event and a broadcast `execution_failed` notification.
 */
async function queueRetry(
  tx: Tx,
  input: ApplyFailurePolicyInput,
  options: { infraRetriesUsed: number; notBefore: Date; nudge?: QueuedNudge },
): Promise<FailurePolicyOutcome> {
  const { execution, task, endReason } = input;
  const attempt = execution.attempt + 1;
  const { id } = await insertRetryExecution(tx, {
    taskId: task.id,
    role: execution.role,
    attempt,
    runtime: execution.runtime,
    model: execution.model,
    specRevisionId: execution.specRevisionId,
    branch: execution.branch,
    sessionId: execution.sessionId,
    infraRetriesUsed: options.infraRetriesUsed,
  });
  const payload: RetryQueuedPayload = {
    attempt,
    retry_of: execution.id,
    not_before: options.notBefore.toISOString(),
    ...(options.nudge ? { nudge: options.nudge } : {}),
  };
  await appendEvent(tx, {
    taskId: task.id,
    executionId: id,
    type: "execution.queued",
    payload,
  });
  await insertNotification(tx, {
    userId: null,
    taskId: task.id,
    kind: "execution_failed",
    title: clip(
      `${task.jiraKey} attempt ${execution.attempt} failed (${endReason}); retrying as attempt ${attempt}`,
      TITLE_MAX_CHARS,
    ),
  });
  return {
    kind: "retry",
    executionId: id,
    notBefore: options.notBefore,
    nudge: options.nudge !== undefined,
  };
}

/** Whether a retry row for this execution could ever be started (§9.5). */
function retryable(input: ApplyFailurePolicyInput): boolean {
  return (
    input.execution.role === "implementation" &&
    RETRYABLE_TASK_STATES.has(input.task.state)
  );
}

/**
 * design.md §9.5, applied once an execution has ended FAILED. Call inside
 * the transaction that made the FAILED transition, after the task row and
 * then the execution row are locked, with `task` read under that lock.
 * Every write it makes is in `tx`; the "nothing" branches write nothing.
 *
 * - user: nothing.
 * - a task already NEEDS_HUMAN (report_failed, a round limit): nothing,
 *   except a missing `needs_human_reason` is set.
 * - business: escalate (report_failed has already done so when it can).
 * - infrastructure terminal: escalate with the failure.
 * - infrastructure retriable: a retry below `max_infra_retries`, backoff
 *   `30 s * 2^n`; otherwise escalate "infrastructure retries exhausted".
 * - protocol (C26): a retry with the nudge marker while the task's
 *   protocol violations, this one included, are within
 *   `max_protocol_retries`; no backoff and no infrastructure retry used.
 *   Otherwise escalate "protocol retries exhausted".
 *
 * Only an implementation execution of an IMPLEMENTING or REVIEWING task is
 * retried, since the starter runs nothing else; any other retriable
 * failure escalates.
 */
export async function applyFailurePolicy(
  tx: Tx,
  input: ApplyFailurePolicyInput,
): Promise<FailurePolicyOutcome> {
  const { execution, task, project, endReason, endDetail, now } = input;
  const classified = classifyFailure(endReason, endDetail);
  if (classified.action === "none") return { kind: "none" };

  const failure = describeFailure(endReason, endDetail);

  if (task.state === "NEEDS_HUMAN") {
    const set = await setNeedsHumanReasonIfMissing(
      tx,
      task.id,
      clip(failure, REASON_MAX_CHARS),
    );
    return set ? { kind: "reason_set" } : { kind: "none" };
  }

  switch (classified.action) {
    case "escalate":
      if (classified.class === "business") {
        return resolveTransition("task", task.state, "task.escalated").ok
          ? escalate(tx, input, failure)
          : { kind: "none" };
      }
      return escalate(tx, input, `Infrastructure failure, not retriable: ${failure}`);

    case "retry": {
      const used = execution.infraRetriesUsed;
      if (used >= project.maxInfraRetries) {
        return escalate(
          tx,
          input,
          `infrastructure retries exhausted (${project.maxInfraRetries}); last failure ${failure}`,
        );
      }
      if (!retryable(input)) {
        return escalate(tx, input, `Infrastructure failure, cannot be retried: ${failure}`);
      }
      return queueRetry(tx, input, {
        infraRetriesUsed: used + 1,
        notBefore: new Date(now.getTime() + infraRetryBackoffMs(used)),
      });
    }

    case "nudge": {
      const violations = await countProtocolViolations(tx, task.id);
      if (violations > project.maxProtocolRetries) {
        return escalate(
          tx,
          input,
          `protocol retries exhausted (${project.maxProtocolRetries}); last failure ${failure}`,
        );
      }
      if (!retryable(input)) {
        return escalate(tx, input, `Protocol violation, cannot be retried: ${failure}`);
      }
      return queueRetry(tx, input, {
        infraRetriesUsed: execution.infraRetriesUsed,
        notBefore: now,
        nudge: { kind: "protocol_nudge", missing_tool_call: missingToolCall(endDetail) },
      });
    }
  }
}

export interface RunFailurePolicyInput {
  executionId: string;
  endReason: EndReason;
  endDetail: string | null;
  actor: Actor;
  now: Date;
  logger?: Logger;
}

/**
 * Loads the execution, task and project, then `applyFailurePolicy`. Same
 * precondition: task, then execution, already locked in `tx`.
 */
export async function runFailurePolicy(
  tx: Tx,
  input: RunFailurePolicyInput,
): Promise<FailurePolicyOutcome> {
  const context = await loadFailurePolicyContext(tx, input.executionId);
  if (!context) return { kind: "none" };
  const outcome = await applyFailurePolicy(tx, { ...context, ...input });
  if (outcome.kind !== "none") {
    input.logger?.info(
      {
        taskId: context.task.id,
        executionId: input.executionId,
        endReason: input.endReason,
        outcome: outcome.kind,
        ...(outcome.kind === "retry" ? { retryExecutionId: outcome.executionId } : {}),
      },
      "failure policy applied",
    );
  }
  return outcome;
}
