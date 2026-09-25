import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { createApiClient, type BoardApiClient } from "../api/client.js";
import type { Issue, Notification, TaskCard } from "../api/types.js";
import { useRefetchOnReconnect } from "../board/useEventReconnect.js";
import { useLatestRequest } from "../board/useLatestRequest.js";
import { useEventStream, type EventSourceFactory } from "../sse/useEventStream.js";

export interface AttentionDrawerProps {
  /** Injectable for tests; defaults to a real createApiClient(). */
  client?: BoardApiClient;
  /** Injectable for tests; defaults to the real `EventSource`. */
  createEventSource?: EventSourceFactory;
}

const STREAM_TYPES = ["task.state_changed", "issue.created", "issue.resolved"] as const;

/**
 * Persistent right-hand drawer (design.md §14 Attention panel, spec §18),
 * shown on every page. Blocking issues, spec reviews requested, tasks
 * needing a human, tasks ready to merge, and unread notifications. `GET
 * /stream` has no replay (docs/build-order.md GOT.36 carry-forward), so
 * every one of the three subscribed event types refetches all three lists
 * rather than patching from the event payload, and a reconnect does the
 * same.
 */
export function AttentionDrawer({ client, createEventSource }: AttentionDrawerProps = {}) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const [open, setOpen] = useState(false);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [tasks, setTasks] = useState<TaskCard[] | null>(null);
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { begin, isCurrent } = useLatestRequest();

  const fetchAll = useCallback(async () => {
    const generation = begin();
    try {
      const [issueRows, taskRows, notificationRows] = await Promise.all([
        apiClient.listIssues({ status: "OPEN", blocking: true }),
        apiClient.listTasks({ attention: true }),
        apiClient.listNotifications(),
      ]);
      if (!isCurrent(generation)) return;
      setIssues(issueRows);
      setTasks(taskRows);
      setNotifications(notificationRows);
      setError(null);
    } catch (err) {
      if (!isCurrent(generation)) return;
      setError(err instanceof Error ? err.message : "Failed to load attention items.");
    }
  }, [apiClient, begin, isCurrent]);

  const fetchNotifications = useCallback(async () => {
    const generation = begin();
    try {
      const notificationRows = await apiClient.listNotifications();
      if (!isCurrent(generation)) return;
      setNotifications(notificationRows);
      setError(null);
    } catch (err) {
      if (!isCurrent(generation)) return;
      setError(err instanceof Error ? err.message : "Failed to load notifications.");
    }
  }, [apiClient, begin, isCurrent]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const eventSourceAvailable = createEventSource !== undefined || typeof EventSource !== "undefined";

  const { status } = useEventStream("/api/stream", {
    types: STREAM_TYPES,
    createEventSource,
    enabled: eventSourceAvailable,
    onEvent: () => void fetchAll(),
  });

  useRefetchOnReconnect(status, () => void fetchAll());

  const handleMarkRead = useCallback(
    async (id: string) => {
      try {
        await apiClient.markNotificationRead(id);
        await fetchNotifications();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to mark the notification as read.");
      }
    },
    [apiClient, fetchNotifications],
  );

  const taskById = useMemo(() => new Map((tasks ?? []).map((task) => [task.id, task])), [tasks]);
  const blockingIssues = issues ?? [];
  const specReviews = (tasks ?? []).filter((task) => task.state === "SPEC_REVIEW");
  const needsHuman = (tasks ?? []).filter((task) => task.state === "NEEDS_HUMAN");
  const readyForMerge = (tasks ?? []).filter((task) => task.state === "READY_FOR_MERGE");
  const unread = (notifications ?? []).filter((notification) => notification.readAt === null);

  const count = blockingIssues.length + specReviews.length + needsHuman.length + readyForMerge.length + unread.length;

  return (
    <aside aria-label="Attention">
      <button type="button" aria-expanded={open} onClick={() => setOpen((prev) => !prev)}>
        Attention <span data-testid="attention-count">{count}</span>
      </button>
      {open && (
        <div>
          {error && <p role="alert">{error}</p>}

          <section aria-label="Blocking issues">
            <h2>Blocking issues</h2>
            {blockingIssues.length === 0 ? (
              <p>No blocking issues.</p>
            ) : (
              <ul>
                {blockingIssues.map((issue) => {
                  const task = taskById.get(issue.taskId);
                  return (
                    <li key={issue.id}>
                      <Link to={`/issues/${issue.id}`}>
                        {task ? `${task.jiraKey}: ${issue.title}` : issue.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-label="Spec reviews requested">
            <h2>Spec reviews requested</h2>
            {specReviews.length === 0 ? (
              <p>No spec reviews requested.</p>
            ) : (
              <ul>
                {specReviews.map((task) => (
                  <li key={task.id}>
                    <Link to={`/tasks/${task.id}/spec`}>{task.jiraKey}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Needs human">
            <h2>Needs human</h2>
            {needsHuman.length === 0 ? (
              <p>No tasks need a human.</p>
            ) : (
              <ul>
                {needsHuman.map((task) => (
                  <li key={task.id}>
                    <Link to={`/tasks/${task.id}`}>{task.jiraKey}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Ready for merge">
            <h2>Ready for merge</h2>
            {readyForMerge.length === 0 ? (
              <p>No tasks ready for merge.</p>
            ) : (
              <ul>
                {readyForMerge.map((task) => (
                  <li key={task.id}>
                    <Link to={`/tasks/${task.id}`}>{task.jiraKey}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Unread notifications">
            <h2>Unread notifications</h2>
            {unread.length === 0 ? (
              <p>No unread notifications.</p>
            ) : (
              <ul>
                {unread.map((notification) => (
                  <li key={notification.id}>
                    {notification.title}
                    <button type="button" onClick={() => void handleMarkRead(notification.id)}>
                      Mark read
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {count === 0 && <p>Nothing needs attention.</p>}
        </div>
      )}
    </aside>
  );
}
