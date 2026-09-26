import {
  getSpecApprovalDisplayName,
  listJiraWritebackEvents,
  maxExecutionEventId,
  type Db,
  type JiraWritebackEventRow,
} from "@orchestra/db";
import { z } from "zod";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { JiraApiError, createJiraClient, type JiraClient } from "./client.js";

/**
 * Jira comment write-back (design.md §11.1 write-back table). An
 * independent loop, like the poller, not a tick phase (design.md §6 fixes
 * the phase list).
 *
 * Trigger detection is an in-memory cursor over `execution_events.id`
 * (C11): at startup the cursor is the current max id, so a fresh worker
 * never replays history. This protects against a *missed* trigger only if
 * the worker never restarts between the trigger and the comment; the
 * per-kind marker in the comment body is what protects against a
 * *duplicate* comment across restarts, retries and concurrent workers.
 */

export const DEFAULT_JIRA_WRITEBACK_INTERVAL_MS = 15_000;
export const DEFAULT_JIRA_WRITEBACK_JITTER_RATIO = 0.1;
export const JIRA_WRITEBACK_BATCH_LIMIT = 200;

/**
 * Consecutive failures allowed for one event before it is skipped rather
 * than retried forever (coordinator decision C14, F1 part 2). A success or
 * a skip clears the count.
 */
export const MAX_EVENT_ATTEMPTS = 5;

/**
 * Minimal per-type payload shape the write-back loop needs before it makes
 * any db or Jira call (C14, F1 part 1). Unknown extra fields are ignored;
 * only the fields `buildWritebackComment` reads are required.
 */
const SPEC_APPROVED_PAYLOAD_SCHEMA = z.object({
  revision_id: z.string().uuid(),
  version: z.number().int(),
});
const PULL_REQUEST_CREATED_PAYLOAD_SCHEMA = z.object({
  url: z.string(),
});
const TASK_STATE_CHANGED_PAYLOAD_SCHEMA = z.object({
  to: z.string(),
});

function payloadSchemaFor(type: JiraWritebackEventRow["type"]) {
  switch (type) {
    case "spec.approved":
      return SPEC_APPROVED_PAYLOAD_SCHEMA;
    case "pull_request.created":
      return PULL_REQUEST_CREATED_PAYLOAD_SCHEMA;
    case "task.state_changed":
      return TASK_STATE_CHANGED_PAYLOAD_SCHEMA;
  }
}

/** One `[orchestra:<kind>:<task id>]` marker per kind, per task, for the life of the task (C12). */
export type WritebackKind =
  | "spec_approved"
  | "pr_created"
  | "ready_for_merge"
  | "needs_human";

/** The dedupe marker for one kind and task (design.md §11.1). */
export function writebackMarker(kind: WritebackKind, taskId: string): string {
  return `[orchestra:${kind}:${taskId}]`;
}

interface WritebackComment {
  kind: WritebackKind;
  /** Text only; the marker line is appended by the caller. */
  text: string;
}

/**
 * Builds the comment text for one trigger event (design.md §11.1 table),
 * or null when the event carries nothing to report (E.g. `READY_FOR_MERGE`
 * with no PR row yet, which should not happen but must not throw).
 */
async function buildWritebackComment(
  db: Db,
  event: JiraWritebackEventRow,
  config: WorkerConfig,
): Promise<WritebackComment | null> {
  const link = config.publicUrl ? `${config.publicUrl}/tasks/${event.taskId}` : undefined;
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  if (event.type === "spec.approved") {
    const version = payload["version"];
    const revisionId = payload["revision_id"];
    const actor = payload["actor"] as { id?: string | null } | undefined;
    const displayName =
      typeof revisionId === "string"
        ? await getSpecApprovalDisplayName(db, revisionId, actor?.id ?? null)
        : null;
    const text = `Specification v ${String(version)} approved by ${displayName ?? "Unknown"}.${
      link ? ` ${link}` : ""
    }`;
    return { kind: "spec_approved", text };
  }

  if (event.type === "pull_request.created") {
    const url = typeof payload["url"] === "string" ? (payload["url"] as string) : event.pullRequestUrl;
    if (!url) return null;
    return { kind: "pr_created", text: `Pull request opened: ${url}` };
  }

  // task.state_changed; listJiraWritebackEvents already filtered `to` to
  // READY_FOR_MERGE or NEEDS_HUMAN.
  const to = payload["to"];
  if (to === "READY_FOR_MERGE") {
    if (!event.pullRequestUrl) return null;
    return {
      kind: "ready_for_merge",
      text: `CI passed. Ready for merge: ${event.pullRequestUrl}`,
    };
  }
  if (to === "NEEDS_HUMAN") {
    const payloadReason = typeof payload["reason"] === "string" ? (payload["reason"] as string) : undefined;
    const reason = event.needsHumanReason ?? payloadReason ?? "see the task page";
    const text = `Automation stopped: ${reason}.${link ? ` ${link}` : ""}`;
    return { kind: "needs_human", text };
  }

  return null;
}

/**
 * Outcome of handling one event: `"done"` when the event needs no further
 * attention — posted, already posted, intentionally skipped (nothing to
 * say, the ticket is gone, or the payload failed validation) — and
 * `"retry"` when a transient failure (db error, Jira 5xx or network) means
 * the event must be retried, bounded by `MAX_EVENT_ATTEMPTS` (design.md
 * §11.1 C11, C14).
 */
type WritebackEventOutcome = "done" | "retry";

/**
 * Handles one event: validates its payload, builds its comment, dedupes
 * against the ticket's existing comments by marker, then posts.
 */
async function handleWritebackEvent(
  db: Db,
  client: JiraClient,
  config: WorkerConfig,
  logger: Logger,
  event: JiraWritebackEventRow,
): Promise<WritebackEventOutcome> {
  const schema = payloadSchemaFor(event.type);
  const parsed = schema.safeParse(event.payload ?? {});
  if (!parsed.success) {
    logger.warn(
      {
        eventId: String(event.id),
        jiraKey: event.jiraKey,
        type: event.type,
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      },
      "jira writeback: event payload failed validation; event skipped",
    );
    return "done";
  }

  let comment: WritebackComment | null;
  try {
    comment = await buildWritebackComment(db, event, config);
  } catch (err) {
    logger.error(
      {
        eventId: String(event.id),
        jiraKey: event.jiraKey,
        err: err instanceof Error ? err.message : String(err),
      },
      "jira writeback: building the comment failed; retrying next run",
    );
    return "retry";
  }
  if (!comment) return "done";

  const marker = writebackMarker(comment.kind, event.taskId);

  let ticket;
  try {
    ticket = await client.getIssue(event.jiraKey);
    if (ticket.comments.some((c) => c.body.includes(marker))) {
      return "done";
    }
  } catch (err) {
    if (err instanceof JiraApiError && err.status === 404) {
      logger.warn(
        { eventId: String(event.id), jiraKey: event.jiraKey, kind: comment.kind },
        "jira writeback: ticket not found; event skipped",
      );
      return "done";
    }
    logger.error(
      {
        eventId: String(event.id),
        jiraKey: event.jiraKey,
        kind: comment.kind,
        err: err instanceof Error ? err.message : String(err),
      },
      "jira writeback: fetching ticket comments failed; retrying next run",
    );
    return "retry";
  }

  try {
    await client.addComment(event.jiraKey, `${comment.text}\n${marker}`);
  } catch (err) {
    if (err instanceof JiraApiError && err.status === 404) {
      logger.warn(
        { eventId: String(event.id), jiraKey: event.jiraKey, kind: comment.kind },
        "jira writeback: ticket not found on comment post; event skipped",
      );
      return "done";
    }
    logger.error(
      {
        eventId: String(event.id),
        jiraKey: event.jiraKey,
        kind: comment.kind,
        err: err instanceof Error ? err.message : String(err),
      },
      "jira writeback: posting comment failed; retrying next run",
    );
    return "retry";
  }

  return "done";
}

export interface RunJiraWritebackOptions {
  db: Db;
  client: JiraClient;
  config: WorkerConfig;
  logger: Logger;
  /** Exclusive lower bound: `execution_events.id` already handled. */
  cursor: bigint;
  /**
   * Consecutive-failure counts, keyed by `String(event.id)`. Carried across
   * runs by the caller's loop state (`startJiraWriteback`); a fresh `Map`
   * when omitted, mutated in place (C14, F1 part 2).
   */
  attempts?: Map<string, number>;
}

/**
 * Runs one pass: loads events after `cursor`, handles each in order, and
 * returns the cursor to use for the next pass. A malformed payload is
 * skipped immediately (the cursor advances). A transient failure retries
 * the same event on later passes, up to `MAX_EVENT_ATTEMPTS` consecutive
 * failures, after which it is skipped too so later events are never
 * stalled forever by one poison event (design.md §11.1 C11, C14).
 */
export async function runJiraWriteback(
  options: RunJiraWritebackOptions,
): Promise<{ cursor: bigint }> {
  const { db, client, config, logger } = options;
  let cursor = options.cursor;
  const attempts = options.attempts ?? new Map<string, number>();

  let events: JiraWritebackEventRow[];
  try {
    events = await listJiraWritebackEvents(db, cursor, JIRA_WRITEBACK_BATCH_LIMIT);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "listing jira writeback events failed",
    );
    return { cursor };
  }

  for (const event of events) {
    const key = String(event.id);
    const outcome = await handleWritebackEvent(db, client, config, logger, event);

    if (outcome === "retry") {
      const failureCount = (attempts.get(key) ?? 0) + 1;
      if (failureCount < MAX_EVENT_ATTEMPTS) {
        attempts.set(key, failureCount);
        break;
      }
      logger.error(
        { eventId: key, jiraKey: event.jiraKey, attempts: failureCount },
        "jira writeback: event exceeded max attempts; event skipped",
      );
      attempts.delete(key);
      cursor = event.id;
      continue;
    }

    attempts.delete(key);
    cursor = event.id;
  }

  return { cursor };
}

export interface StartJiraWritebackOptions {
  db: Db;
  config: WorkerConfig;
  logger: Logger;
  intervalMs?: number;
  jitterRatio?: number;
  /** Injectable for tests; defaults to a real client built from `config`. */
  client?: JiraClient;
}

export type StopJiraWriteback = () => Promise<void>;

/**
 * Starts the Jira write-back loop (design.md §11.1): every `intervalMs`
 * with up to `jitterRatio` jitter, posts at most one comment per trigger
 * per task. Missing credentials log one warning and return a no-op stop
 * function, matching the poller (E4).
 */
export function startJiraWriteback(
  options: StartJiraWritebackOptions,
): StopJiraWriteback {
  const {
    db,
    config,
    logger,
    intervalMs = DEFAULT_JIRA_WRITEBACK_INTERVAL_MS,
    jitterRatio = DEFAULT_JIRA_WRITEBACK_JITTER_RATIO,
  } = options;

  if (!config.jiraBaseUrl || !config.jiraEmail || !config.jiraApiToken) {
    logger.warn(
      {},
      "JIRA_BASE_URL, JIRA_EMAIL or JIRA_API_TOKEN is missing; Jira writeback not started",
    );
    return async () => {};
  }

  const client =
    options.client ??
    createJiraClient({
      baseUrl: config.jiraBaseUrl,
      email: config.jiraEmail,
      apiToken: config.jiraApiToken,
    });

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  // Undefined until the first run initializes it to the current max id
  // (C11): no historical replay on a fresh worker.
  let cursor: bigint | undefined;
  // Consecutive-failure counts per event id, carried across runs (C14).
  const attempts = new Map<string, number>();

  function scheduleNext(): void {
    if (stopped) return;
    const jitter = intervalMs * jitterRatio * Math.random();
    timer = setTimeout(() => void run(), intervalMs + jitter);
  }

  async function run(): Promise<void> {
    if (stopped) return;
    inFlight = (async () => {
      if (cursor === undefined) {
        try {
          cursor = await maxExecutionEventId(db);
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            "reading initial jira writeback cursor failed",
          );
          return;
        }
      }

      const result = await runJiraWriteback({ db, client, config, logger, cursor, attempts });
      cursor = result.cursor;
    })();

    try {
      await inFlight;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "jira writeback: run failed; scheduling next run",
      );
    } finally {
      inFlight = undefined;
      scheduleNext();
    }
  }

  scheduleNext();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
  };
}
