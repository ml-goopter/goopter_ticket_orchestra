import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Link } from "react-router";
import { createApiClient, type BoardApiClient } from "../api/client.js";
import type { Issue, Notification, TaskCard } from "../api/types.js";
import { formatAge } from "../board/format.js";
import { useRefetchOnReconnect } from "../board/useEventReconnect.js";
import { useLatestRequest } from "../board/useLatestRequest.js";
import { useEventStream, type EventSourceFactory } from "../sse/useEventStream.js";

/** One of the panel's five sections, keyed the same way in every prop/state below. */
export type AttentionSection = "blocking" | "specReviews" | "needsHuman" | "readyForMerge" | "unread";

/** Per-section counts plus the sidebar's total badge (design.md §14, UR1). */
export interface AttentionCounts {
  blocking: number;
  specReviews: number;
  needsHuman: number;
  readyForMerge: number;
  unread: number;
  total: number;
}

export const ZERO_ATTENTION_COUNTS: AttentionCounts = {
  blocking: 0,
  specReviews: 0,
  needsHuman: 0,
  readyForMerge: 0,
  unread: 0,
  total: 0,
};

/** Imperative API the sidebar (layout/AppLayout.tsx) opens the panel through. */
export interface AttentionDrawerHandle {
  /**
   * Opens the panel. `section`, when given, scrolls that section into
   * view; omitted opens at the top. `opener`, when given, is the element
   * focus returns to when the panel closes (design.md §14 dialog focus
   * rules) -- the sidebar passes whichever of its six buttons was clicked,
   * since any of them can open the same panel.
   */
  open: (section?: AttentionSection, opener?: HTMLElement | null) => void;
}

export interface AttentionDrawerProps {
  /** Injectable for tests, forwarded to `AttentionDrawer`; defaults to a real createApiClient(). */
  client?: BoardApiClient;
  /** Injectable for tests; defaults to the real `EventSource`. */
  createEventSource?: EventSourceFactory;
  /** Called with the latest counts on every fetch, so the sidebar can render them. */
  onCountsChange?: (counts: AttentionCounts) => void;
  /** Called whenever the panel opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** Current time, injected so item age is deterministic in tests. */
  now?: Date;
  ref?: Ref<AttentionDrawerHandle>;
}

const STREAM_TYPES = ["task.state_changed", "issue.created", "issue.resolved"] as const;

const SECTION_IDS: Record<AttentionSection, string> = {
  blocking: "attention-blocking",
  specReviews: "attention-spec-reviews",
  needsHuman: "attention-needs-human",
  readyForMerge: "attention-ready-for-merge",
  unread: "attention-unread",
};

/**
 * Slide-over attention panel (design.md §14 Attention panel, spec §18),
 * opened from the sidebar's "Attention" row or one of its five sub-rows
 * (layout/AppLayout.tsx holds the trigger buttons and the sidebar's own
 * count badges; this component owns the data fetch, the panel's content,
 * and its own open/close/focus behaviour). Blocking issues, spec reviews
 * requested, tasks needing a human, tasks ready to merge, and unread
 * notifications. `GET /stream` has no replay (docs/build-order.md GOT.36
 * carry-forward), so every one of the three subscribed event types
 * refetches all three lists rather than patching from the event payload,
 * and a reconnect does the same.
 */
export function AttentionDrawer({
  client,
  createEventSource,
  onCountsChange,
  onOpenChange,
  now,
  ref,
}: AttentionDrawerProps = {}) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const [open, setOpen] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<AttentionSection | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [tasks, setTasks] = useState<TaskCard[] | null>(null);
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { begin, isCurrent } = useLatestRequest();
  const openerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);

  const close = useCallback(() => setOpen(false), []);

  useImperativeHandle(
    ref,
    () => ({
      open: (section, opener) => {
        openerRef.current = opener ?? null;
        setScrollTarget(section ?? null);
        setOpen(true);
      },
    }),
    [],
  );

  useEffect(() => {
    onOpenChange?.(open);
    // `onOpenChange` is intentionally not a dependency: callers pass a new
    // function identity on every render (e.g. an inline `setState`), and
    // depending on it would refire this on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focus moves into the panel on open, and back to whichever element
  // opened it on close (not on initial mount, which is why this tracks the
  // prior open state rather than reacting to `!open` directly).
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      panelRef.current?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      openerRef.current?.focus();
    }
  }, [open]);

  // Scrolls the requested section into view once the panel (and its
  // sections) are in the DOM.
  useEffect(() => {
    if (!open || !scrollTarget) return;
    const id = SECTION_IDS[scrollTarget];
    const element = panelRef.current?.querySelector<HTMLElement>(`#${id}`);
    element?.scrollIntoView?.({ block: "start" });
  }, [open, scrollTarget]);

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

  const counts = useMemo<AttentionCounts>(
    () => ({
      blocking: blockingIssues.length,
      specReviews: specReviews.length,
      needsHuman: needsHuman.length,
      readyForMerge: readyForMerge.length,
      unread: unread.length,
      total:
        blockingIssues.length + specReviews.length + needsHuman.length + readyForMerge.length + unread.length,
    }),
    [blockingIssues.length, specReviews.length, needsHuman.length, readyForMerge.length, unread.length],
  );

  useEffect(() => {
    onCountsChange?.(counts);
    // `onCountsChange` is intentionally not a dependency, for the same
    // reason as `onOpenChange` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts]);

  const effectiveNow = now ?? new Date();

  if (!open) {
    return null;
  }

  return (
    <>
      <div className="side-panel__backdrop" onClick={close} />
      <div
        className="side-panel side-panel--left"
        role="dialog"
        aria-label="Attention"
        aria-modal="true"
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="side-panel__header">
          <h2 className="side-panel__title">
            Attention <span className="badge badge--attention">{counts.total}</span>
          </h2>
          <button type="button" className="side-panel__close" aria-label="Close" onClick={close}>
            &times;
          </button>
        </div>
        <div className="side-panel__body">
          {error && (
            <p className="alert alert--error" role="alert">
              {error}
            </p>
          )}

          <section className="side-panel__section" id={SECTION_IDS.blocking} aria-label="Blocking issues">
            <div className="side-panel__section-title">
              Blocking issues <span className="side-panel__count">{blockingIssues.length}</span>
            </div>
            {blockingIssues.length === 0 ? (
              <p className="side-panel__empty">No blocking issues.</p>
            ) : (
              <ul className="side-panel__list">
                {blockingIssues.map((issue) => {
                  const task = taskById.get(issue.taskId);
                  return (
                    <li className="side-panel__item" key={issue.id}>
                      <Link className="side-panel__item-title" to={`/issues/${issue.id}`}>
                        {task ? `${task.jiraKey}: ${issue.title}` : issue.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="side-panel__section" id={SECTION_IDS.specReviews} aria-label="Spec reviews requested">
            <div className="side-panel__section-title">
              Spec reviews requested <span className="side-panel__count">{specReviews.length}</span>
            </div>
            {specReviews.length === 0 ? (
              <p className="side-panel__empty">No spec reviews requested.</p>
            ) : (
              <ul className="side-panel__list">
                {specReviews.map((task) => (
                  <li className="side-panel__item" key={task.id}>
                    <Link className="side-panel__item-title" to={`/tasks/${task.id}/spec`}>
                      {task.jiraKey}: {task.jiraSummary}
                    </Link>
                    <span className="side-panel__item-meta">{formatAge(task.updatedAt, effectiveNow)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="side-panel__section" id={SECTION_IDS.needsHuman} aria-label="Needs human">
            <div className="side-panel__section-title">
              Needs human <span className="side-panel__count">{needsHuman.length}</span>
            </div>
            {needsHuman.length === 0 ? (
              <p className="side-panel__empty">No tasks need a human.</p>
            ) : (
              <ul className="side-panel__list">
                {needsHuman.map((task) => (
                  <li className="side-panel__item" key={task.id}>
                    <Link className="side-panel__item-title" to={`/tasks/${task.id}`}>
                      {task.jiraKey}: {task.jiraSummary}
                    </Link>
                    <span className="side-panel__item-meta">{formatAge(task.updatedAt, effectiveNow)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="side-panel__section" id={SECTION_IDS.readyForMerge} aria-label="Ready for merge">
            <div className="side-panel__section-title">
              Ready for merge <span className="side-panel__count">{readyForMerge.length}</span>
            </div>
            {readyForMerge.length === 0 ? (
              <p className="side-panel__empty">No tasks ready for merge.</p>
            ) : (
              <ul className="side-panel__list">
                {readyForMerge.map((task) => (
                  <li className="side-panel__item" key={task.id}>
                    <Link className="side-panel__item-title" to={`/tasks/${task.id}`}>
                      {task.jiraKey}: {task.jiraSummary}
                    </Link>
                    <span className="side-panel__item-meta">{formatAge(task.updatedAt, effectiveNow)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="side-panel__section" id={SECTION_IDS.unread} aria-label="Unread notifications">
            <div className="side-panel__section-title">
              Unread notifications <span className="side-panel__count">{unread.length}</span>
            </div>
            {unread.length === 0 ? (
              <p className="side-panel__empty">No unread notifications.</p>
            ) : (
              <ul className="side-panel__list">
                {unread.map((notification) => {
                  const task = taskById.get(notification.taskId);
                  const href = notification.issueId
                    ? `/issues/${notification.issueId}`
                    : `/tasks/${notification.taskId}`;
                  return (
                    <li className="side-panel__item" key={notification.id}>
                      <span className="side-panel__item-text">
                        <Link className="side-panel__item-title" to={href}>
                          {notification.title}
                        </Link>
                        {task && <span className="side-panel__item-meta">{task.jiraKey}</span>}
                      </span>
                      <button
                        type="button"
                        className="side-panel__item-action btn btn--small"
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

          {counts.total === 0 && <p>Nothing needs attention.</p>}
        </div>
        <div className="side-panel__footer">Esc to close &middot; updates live</div>
      </div>
    </>
  );
}
