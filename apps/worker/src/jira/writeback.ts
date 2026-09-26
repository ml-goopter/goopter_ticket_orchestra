import {
  getSpecApprovalDisplayName,
  listJiraWritebackEvents,
  maxExecutionEventId,
  type Db,
  type JiraWritebackEventRow,
} from "@orchestra/db";
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
 * Handles one event: builds its comment, dedupes against the ticket's
 * existing comments by marker, then posts. Returns `true` when the event is
 * done — posted, already posted, or intentionally skipped (nothing to say,
 * or the ticket is gone) — and `false` when the Jira call failed and the
 * event must be retried on the next run (design.md §11.1 C11).
 */
async function handleWritebackEvent(
  db: Db,
  client: JiraClient,
  config: WorkerConfig,
  logger: Logger,
  event: JiraWritebackEventRow,
): Promise<boolean> {
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
    return false;
  }
  if (!comment) return true;

  const marker = writebackMarker(comment.kind, event.taskId);

  let ticket;
  try {
    ticket = await client.getIssue(event.jiraKey);
  } catch (err) {
    if (err instanceof JiraApiError && err.status === 404) {
      logger.warn(
        { eventId: String(event.id), jiraKey: event.jiraKey, kind: comment.kind },
        "jira writeback: ticket not found; event skipped",
      );
      return true;
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
    return false;
  }

  if (ticket.comments.some((c) => c.body.includes(marker))) {
    return true;
  }

  try {
    await client.addComment(event.jiraKey, `${comment.text}\n${marker}`);
  } catch (err) {
    if (err instanceof JiraApiError && err.status === 404) {
      logger.warn(
        { eventId: String(event.id), jiraKey: event.jiraKey, kind: comment.kind },
        "jira writeback: ticket not found on comment post; event skipped",
      );
      return true;
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
    return false;
  }

  return true;
}

export interface RunJiraWritebackOptions {
  db: Db;
  client: JiraClient;
  config: WorkerConfig;
  logger: Logger;
  /** Exclusive lower bound: `execution_events.id` already handled. */
  cursor: bigint;
}

/**
 * Runs one pass: loads events after `cursor`, handles each in order, and
 * returns the cursor to use for the next pass. Stops at the first event
 * whose Jira call fails, so the cursor never advances past an event that
 * was not handled (design.md §11.1 C11) — later events in this same batch
 * are simply retried, in order, on the next pass.
 */
export async function runJiraWriteback(
  options: RunJiraWritebackOptions,
): Promise<{ cursor: bigint }> {
  const { db, client, config, logger } = options;
  let cursor = options.cursor;

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
    const handled = await handleWritebackEvent(db, client, config, logger, event);
    if (!handled) break;
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

      const result = await runJiraWriteback({ db, client, config, logger, cursor });
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
