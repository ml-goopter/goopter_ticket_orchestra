import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);

  const close = useCallback(() => setOpen(false), []);

  // Focus moves into the panel on open, and back to the trigger on close
  // (not on initial mount, which is why this tracks the prior open state
  // rather than reacting to `!open` directly).
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      panelRef.current?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, close]);

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
      <button
        ref={triggerRef}
        type="button"
        className="attention-trigger__button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((prev) => !prev)}
      >
        Attention{" "}
        <span className="badge badge--attention attention-trigger__count" data-testid="attention-count">
          {count}
        </span>
      </button>
      {open && (
        <>
          <div className="drawer__backdrop" onClick={close} />
          <div className="drawer" role="dialog" aria-label="Attention" aria-modal="true" ref={panelRef} tabIndex={-1}>
            <div className="drawer__header">
              <h2 className="drawer__title">Attention</h2>
              <button type="button" className="drawer__close" aria-label="Close" onClick={close}>
                &times;
              </button>
            </div>
            <div className="drawer__body">
              {error && (
                <p className="alert alert--error" role="alert">
                  {error}
                </p>
              )}

              <section className="drawer__section" aria-label="Blocking issues">
                <h2>Blocking issues</h2>
                {blockingIssues.length === 0 ? (
                  <p>No blocking issues.</p>
                ) : (
                  <ul className="drawer__list">
                    {blockingIssues.map((issue) => {
                      const task = taskById.get(issue.taskId);
                      return (
                        <li className="drawer__list-item" key={issue.id}>
                          <Link className="drawer__item-title" to={`/issues/${issue.id}`}>
                            {task ? `${task.jiraKey}: ${issue.title}` : issue.title}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="drawer__section" aria-label="Spec reviews requested">
                <h2>Spec reviews requested</h2>
                {specReviews.length === 0 ? (
                  <p>No spec reviews requested.</p>
                ) : (
                  <ul className="drawer__list">
                    {specReviews.map((task) => (
                      <li className="drawer__list-item" key={task.id}>
                        <Link className="drawer__item-title" to={`/tasks/${task.id}/spec`}>
                          {task.jiraKey}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="drawer__section" aria-label="Needs human">
                <h2>Needs human</h2>
                {needsHuman.length === 0 ? (
                  <p>No tasks need a human.</p>
                ) : (
                  <ul className="drawer__list">
                    {needsHuman.map((task) => (
                      <li className="drawer__list-item" key={task.id}>
                        <Link className="drawer__item-title" to={`/tasks/${task.id}`}>
                          {task.jiraKey}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="drawer__section" aria-label="Ready for merge">
                <h2>Ready for merge</h2>
                {readyForMerge.length === 0 ? (
                  <p>No tasks ready for merge.</p>
                ) : (
                  <ul className="drawer__list">
                    {readyForMerge.map((task) => (
                      <li className="drawer__list-item" key={task.id}>
                        <Link className="drawer__item-title" to={`/tasks/${task.id}`}>
                          {task.jiraKey}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="drawer__section" aria-label="Unread notifications">
                <h2>Unread notifications</h2>
                {unread.length === 0 ? (
                  <p>No unread notifications.</p>
                ) : (
                  <ul className="drawer__list">
                    {unread.map((notification) => {
                      const task = taskById.get(notification.taskId);
                      const href = notification.issueId
                        ? `/issues/${notification.issueId}`
                        : `/tasks/${notification.taskId}`;
                      return (
                        <li className="drawer__list-item" key={notification.id}>
                          <span className="drawer__item-text">
                            <Link className="drawer__item-title" to={href}>
                              {notification.title}
                            </Link>
                            {task && <span className="drawer__item-meta">{task.jiraKey}</span>}
                          </span>
                          <button
                            type="button"
                            className="drawer__item-action"
                            onClick={() => void handleMarkRead(notification.id)}
                          >
                            Mark read
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {count === 0 && <p>Nothing needs attention.</p>}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
