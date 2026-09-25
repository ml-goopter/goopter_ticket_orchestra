import {
  failJiraTaskNotFound,
  listJiraProjects,
  listNonTerminalJiraTasks,
  upsertJiraTask,
  type Actor,
  type Db,
  type JiraProjectRow,
} from "@orchestra/db";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { createJiraClient, type JiraClient } from "./client.js";

/** design.md §11.1, E5: every 60 seconds, up to 10% jitter. */
export const DEFAULT_JIRA_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_JIRA_POLL_JITTER_RATIO = 0.1;

export interface PollProjectOptions {
  db: Db;
  project: JiraProjectRow;
  client: JiraClient;
  actor: Actor;
  logger: Logger;
  now?: () => Date;
  /** Checked before each 404 check; lets `stop()` cut a cycle short (F2 regression). */
  shouldStop?: () => boolean;
}

/**
 * Polls one project (design.md §11.1). Runs the project's JQL with
 * `ORDER BY created ASC` appended (E1), upserts every result, then checks
 * every non-terminal task whose key the search did not return: a 404 moves
 * it to `FAILED` (E3), anything else — including a transient error on that
 * one lookup — leaves it untouched.
 *
 * A failure fetching the search results itself (network error, non-2xx) is
 * logged and ends this project's poll here; it never touches the database
 * and never stops the caller from moving on to the next project (E5, C6).
 */
export async function pollProject(options: PollProjectOptions): Promise<void> {
  const {
    db,
    project,
    client,
    actor,
    logger,
    now = () => new Date(),
    shouldStop = () => false,
  } = options;
  const jql = `${project.jiraJql} ORDER BY created ASC`;

  let issues;
  try {
    issues = await client.search(jql);
  } catch (err) {
    logger.error(
      {
        projectId: project.id,
        projectKey: project.key,
        err: err instanceof Error ? err.message : String(err),
      },
      "jira search failed for project",
    );
    return;
  }

  const seenKeys = new Set(issues.map((issue) => issue.key));
  const syncedAt = now();

  for (const issue of issues) {
    try {
      await db.transaction((tx) =>
        upsertJiraTask(
          tx,
          {
            projectId: project.id,
            jiraKey: issue.key,
            summary: issue.summary,
            priority: issue.priority,
            createdAt: issue.createdAt,
            syncedAt,
          },
          actor,
        ),
      );
    } catch (err) {
      logger.error(
        {
          projectId: project.id,
          jiraKey: issue.key,
          err: err instanceof Error ? err.message : String(err),
        },
        "jira task upsert failed",
      );
    }
  }

  const nonTerminal = await listNonTerminalJiraTasks(db, project.id);
  for (const task of nonTerminal) {
    if (shouldStop()) return;
    if (seenKeys.has(task.jiraKey)) continue;

    let exists: boolean;
    try {
      exists = await client.issueExists(task.jiraKey);
    } catch (err) {
      logger.warn(
        {
          projectId: project.id,
          jiraKey: task.jiraKey,
          err: err instanceof Error ? err.message : String(err),
        },
        "jira 404 check failed; task left untouched",
      );
      continue;
    }

    if (exists) continue;

    try {
      await db.transaction((tx) =>
        failJiraTaskNotFound(tx, {
          taskId: task.id,
          jiraKey: task.jiraKey,
          actor,
        }),
      );
      logger.info(
        { projectId: project.id, jiraKey: task.jiraKey, taskId: task.id },
        "jira task failed: ticket returned 404",
      );
    } catch (err) {
      logger.error(
        {
          projectId: project.id,
          jiraKey: task.jiraKey,
          err: err instanceof Error ? err.message : String(err),
        },
        "failing jira task after 404 failed",
      );
    }
  }
}

export interface StartJiraPollerOptions {
  db: Db;
  config: WorkerConfig;
  workerId: string;
  logger: Logger;
  intervalMs?: number;
  jitterRatio?: number;
  now?: () => Date;
  /** Injectable for tests; defaults to a real client built from `config`. */
  client?: JiraClient;
}

export type StopJiraPoller = () => Promise<void>;

/**
 * Starts the Jira poller: one loop, every `intervalMs` with up to
 * `jitterRatio` jitter, polling every project in sequence (design.md §11.1,
 * E5). Missing credentials log one warning and return a no-op stop function;
 * the worker still starts (E4).
 */
export function startJiraPoller(options: StartJiraPollerOptions): StopJiraPoller {
  const {
    db,
    config,
    workerId,
    logger,
    intervalMs = DEFAULT_JIRA_POLL_INTERVAL_MS,
    jitterRatio = DEFAULT_JIRA_POLL_JITTER_RATIO,
    now = () => new Date(),
  } = options;

  if (!config.jiraBaseUrl || !config.jiraEmail || !config.jiraApiToken) {
    logger.warn(
      {},
      "JIRA_BASE_URL, JIRA_EMAIL or JIRA_API_TOKEN is missing; Jira poller not started",
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

  const actor: Actor = { kind: "worker", id: workerId };

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  function scheduleNext(): void {
    if (stopped) return;
    const jitter = intervalMs * jitterRatio * Math.random();
    timer = setTimeout(() => void run(), intervalMs + jitter);
  }

  async function run(): Promise<void> {
    if (stopped) return;
    inFlight = (async () => {
      let projects;
      try {
        projects = await listJiraProjects(db);
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "listing jira projects failed",
        );
        return;
      }

      for (const project of projects) {
        if (stopped) break;
        try {
          await pollProject({
            db,
            project,
            client,
            actor,
            logger,
            now,
            shouldStop: () => stopped,
          });
        } catch (err) {
          logger.error(
            {
              projectId: project.id,
              projectKey: project.key,
              err: err instanceof Error ? err.message : String(err),
            },
            "jira poll failed for project",
          );
        }
      }
    })();

    try {
      await inFlight;
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
