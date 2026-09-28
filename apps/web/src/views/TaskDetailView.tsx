import { EXECUTION_EVENT_TYPES, TASK_TRANSITIONS } from "@orchestra/core";
import { diffSpecs } from "@orchestra/prompts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, createApiClient, type BoardApiClient } from "../api/client.js";
import { TimelineEventSchema, type TaskAggregate, type TimelineEvent } from "../api/types.js";
import { useRefetchOnReconnect } from "../board/useEventReconnect.js";
import { useLatestRequest } from "../board/useLatestRequest.js";
import { CostBreakdown } from "../cost/CostBreakdown.js";
import { useEventStream, type EventSourceFactory } from "../sse/useEventStream.js";
import "../task/task.css";
import { EVENT_FAMILIES, FAMILY_LABELS, familyOf, type EventFamily } from "../task/eventFamilies.js";
import { TimelineRow } from "../task/TimelineRow.js";
import { buildTimelineItems, mergeTimelineEvents } from "../task/timelineItems.js";
import { humanizeEnum } from "../ui/humanizeEnum.js";
import { StateBadge } from "../ui/StateBadge.js";
import { Time } from "../ui/Time.js";
import { formatUsd } from "../ui/number.js";

export interface TaskDetailViewProps {
  /** Injectable for tests; defaults to a real createApiClient(). */
  client?: BoardApiClient;
  /** Injectable for tests; defaults to the real `EventSource`. */
  createEventSource?: EventSourceFactory;
}

/** Backlog page size for `GET /tasks/:id/timeline` (task contract C). */
const TIMELINE_PAGE_LIMIT = 200;

type LoadState = "loading" | "loaded" | "not_found" | "error";

/**
 * `TaskState`s from which `packages/core/src/transitions.ts` allows the
 * `task.cancelled` trigger (task contract item 5): derived from the
 * transition table itself, not hand-copied, so it stays correct if the
 * table changes. Notably excludes DONE and CANCELLED, its two terminal
 * states with no outgoing `task.cancelled` row.
 */
const CANCELLABLE_TASK_STATES = new Set<string>(
  TASK_TRANSITIONS.filter((row) => row.entity === "task" && row.trigger === "task.cancelled").map(
    (row) => row.from,
  ),
);

/**
 * Task detail (design.md §14 Task detail row, §12.2, §12.6, task contract
 * C): timeline with live SSE append, family filters, a side panel with
 * spec/approval/decision/execution/PR detail, and the cancel/retry actions.
 * Replaces the GOT.38 placeholder.
 *
 * This routed shell only reads `id` and picks/creates the api client. All
 * task-scoped state lives in `TaskDetailPanel`, which is remounted with
 * `key={id}` whenever the route's task id changes (GOT.41-fix2, F1): an
 * in-app navigation from one task to another must not leave the previous
 * task's events, aggregate, filters, revision selectors or SSE
 * subscription attached to the new task's page. Keying on `id` makes React
 * tear down and recreate every hook in the panel, so there is nothing to
 * reset by hand.
 */
export function TaskDetailView({ client, createEventSource }: TaskDetailViewProps = {}) {
  const { id } = useParams();
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);

  if (!id) {
    return (
      <main className="task-detail">
        <h1>Task detail</h1>
        <p>Loading...</p>
      </main>
    );
  }

  return <TaskDetailPanel key={id} id={id} client={apiClient} createEventSource={createEventSource} />;
}

interface TaskDetailPanelProps {
  id: string;
  client: BoardApiClient;
  createEventSource?: EventSourceFactory;
}

function TaskDetailPanel({ id, client: apiClient, createEventSource }: TaskDetailPanelProps) {
  const { begin, isCurrent } = useLatestRequest();

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [aggregate, setAggregate] = useState<TaskAggregate | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedFamilies, setSelectedFamilies] = useState<ReadonlySet<EventFamily>>(
    () => new Set(EVENT_FAMILIES),
  );
  const [fromRevisionId, setFromRevisionId] = useState<string | null>(null);
  const [toRevisionId, setToRevisionId] = useState<string | null>(null);

  const lastEventIdRef = useRef(0);

  const loadAll = useCallback(async () => {
    if (!id) return;
    const generation = begin();
    setLoadState("loading");
    setLoadError(null);
    try {
      const loadedAggregate = await apiClient.getTask(id);
      if (!isCurrent(generation)) return;
      setAggregate(loadedAggregate);

      let merged: TimelineEvent[] = [];
      let after: number | undefined;
      let cursor = 0;
      for (;;) {
        const page = await apiClient.getTimeline(id, { after, limit: TIMELINE_PAGE_LIMIT });
        if (!isCurrent(generation)) return;
        merged = mergeTimelineEvents(merged, page.events);
        cursor = page.nextAfter;
        if (page.events.length < TIMELINE_PAGE_LIMIT) {
          break;
        }
        after = page.nextAfter;
      }
      // Merge with (rather than replace) whatever is already in `events`: the
      // stream subscribes before this backlog page lands (see below), so a
      // live event can already be in state here and must not be dropped.
      setEvents((prev) => mergeTimelineEvents(prev, merged));
      lastEventIdRef.current = Math.max(lastEventIdRef.current, cursor);
      setLoadState("loaded");
    } catch (err) {
      if (!isCurrent(generation)) return;
      if (err instanceof ApiError && err.status === 404) {
        setLoadState("not_found");
      } else {
        setLoadState("error");
        setLoadError(err instanceof Error ? err.message : "Failed to load the task.");
      }
    }
  }, [apiClient, id, begin, isCurrent]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const catchUp = useCallback(async () => {
    if (!id) return;
    const generation = begin();
    try {
      const refreshedAggregate = await apiClient.getTask(id);
      if (!isCurrent(generation)) return;
      setAggregate(refreshedAggregate);

      let after = lastEventIdRef.current;
      for (;;) {
        const page = await apiClient.getTimeline(id, { after, limit: TIMELINE_PAGE_LIMIT });
        if (!isCurrent(generation)) return;
        if (page.events.length === 0) {
          break;
        }
        setEvents((prev) => mergeTimelineEvents(prev, page.events));
        lastEventIdRef.current = page.nextAfter;
        if (page.events.length < TIMELINE_PAGE_LIMIT) {
          break;
        }
        after = page.nextAfter;
      }
    } catch (err) {
      if (!isCurrent(generation)) return;
      setLoadError(err instanceof Error ? err.message : "Failed to reconnect.");
    }
  }, [apiClient, id, begin, isCurrent]);

  const eventSourceAvailable = createEventSource !== undefined || typeof EventSource !== "undefined";

  // Bare URL: the hook owns the `after=` param itself once it has seen a
  // live event (Last-Event-ID resume on reconnect). Passing our own
  // `after=` here as well would duplicate the param on reconnect and the
  // api rejects that with 400 (F1). Subscribing unconditionally, rather
  // than waiting on the backlog load, means no live event between page
  // load and stream open is lost: `mergeTimelineEvents` dedupes and orders
  // whichever of the two arrives first.
  const { status } = useEventStream(
    `/api/tasks/${id}/stream`,
    {
      types: EXECUTION_EVENT_TYPES,
      createEventSource,
      enabled: Boolean(id) && eventSourceAvailable,
      onEvent: (event) => {
        const parsed = TimelineEventSchema.safeParse(event.data);
        if (!parsed.success) {
          return;
        }
        lastEventIdRef.current = Math.max(lastEventIdRef.current, parsed.data.id);
        setEvents((prev) => mergeTimelineEvents(prev, [parsed.data]));
      },
    },
  );

  useRefetchOnReconnect(status, () => void catchUp());

  const items = useMemo(() => buildTimelineItems(events), [events]);
  const visibleItems = useMemo(
    () =>
      items.filter((item) => {
        const family = familyOf(item.type);
        return family !== null && selectedFamilies.has(family);
      }),
    [items, selectedFamilies],
  );

  function toggleFamily(family: EventFamily) {
    setSelectedFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(family)) {
        next.delete(family);
      } else {
        next.add(family);
      }
      return next;
    });
  }

  function toggleAll() {
    setSelectedFamilies((prev) => (prev.size === EVENT_FAMILIES.length ? new Set() : new Set(EVENT_FAMILIES)));
  }

  const handleCancel = useCallback(async () => {
    if (!id) return;
    if (!window.confirm("Cancel this task?")) {
      return;
    }
    setActionError(null);
    try {
      await apiClient.cancelTask(id);
      await loadAll();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel the task.");
    }
  }, [apiClient, id, loadAll]);

  const handleRetry = useCallback(async () => {
    if (!id) return;
    setActionError(null);
    try {
      await apiClient.retryTask(id);
      await loadAll();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to retry the task.");
    }
  }, [apiClient, id, loadAll]);

  const revisions = aggregate?.revisions ?? [];

  useEffect(() => {
    if (revisions.length === 0) {
      return;
    }
    setFromRevisionId((prev) => prev ?? revisions[Math.max(0, revisions.length - 2)]!.id);
    setToRevisionId((prev) => prev ?? revisions[revisions.length - 1]!.id);
  }, [revisions]);

  const diffText = useMemo(() => {
    const from = revisions.find((revision) => revision.id === fromRevisionId);
    const to = revisions.find((revision) => revision.id === toRevisionId);
    if (!from || !to) {
      return null;
    }
    return diffSpecs(from.content, to.content, { a: `v${from.version}`, b: `v${to.version}` });
  }, [revisions, fromRevisionId, toRevisionId]);

  if (loadState === "loading" && !aggregate) {
    return (
      <main className="task-detail">
        <h1>Task detail</h1>
        <p>Loading...</p>
      </main>
    );
  }

  if (loadState === "not_found") {
    return (
      <main className="task-detail">
        <h1>Task detail</h1>
        <p role="alert" className="alert alert--error">
          Task not found.
        </p>
      </main>
    );
  }

  if (loadState === "error" || !aggregate) {
    return (
      <main className="task-detail">
        <h1>Task detail</h1>
        <p role="alert" className="alert alert--error">
          {loadError ?? "Failed to load the task."}
        </p>
      </main>
    );
  }

  const canRetry = aggregate.task.state === "NEEDS_HUMAN";
  const canCancel = CANCELLABLE_TASK_STATES.has(aggregate.task.state);
  const branch = aggregate.latestExecutions.implementation?.branch ?? null;

  return (
    <main className="task-detail">
      <div className="page-header">
        <div>
          <h1 className="page-header__title">
            {aggregate.task.jiraKey}: {aggregate.task.jiraSummary}
          </h1>
          <p className="task-detail__cost">
            <span data-testid="task-state">
              <StateBadge state={aggregate.task.state} />
            </span>
            {" · Total cost "}
            <span data-testid="task-cost">{formatUsd(aggregate.cost.costUsd)}</span>
          </p>
        </div>
        <div className="page-header__actions" aria-label="Actions">
          <button
            type="button"
            disabled={!canCancel}
            title={canCancel ? undefined : `Cannot cancel a task in ${humanizeEnum(aggregate.task.state)}.`}
            onClick={() => void handleCancel()}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canRetry}
            title={canRetry ? undefined : "Retry is only available while the task needs human input."}
            onClick={() => void handleRetry()}
          >
            Retry
          </button>
          <Link to={`/tasks/${aggregate.task.id}/spec`}>Open spec builder</Link>
        </div>
      </div>
      {actionError && (
        <p role="alert" className="alert alert--error">
          {actionError}
        </p>
      )}

      <div className="main-sidebar">
        <div className="main-sidebar__main">
          <section aria-label="Timeline">
            <h2>Timeline</h2>
            <fieldset className="toolbar">
              <legend className="task-detail__card-title">Filters</legend>
              <label>
                <input
                  type="checkbox"
                  checked={selectedFamilies.size === EVENT_FAMILIES.length}
                  onChange={toggleAll}
                />
                All
              </label>
              {EVENT_FAMILIES.map((family) => (
                <label key={family}>
                  <input
                    type="checkbox"
                    checked={selectedFamilies.has(family)}
                    onChange={() => toggleFamily(family)}
                  />
                  {FAMILY_LABELS[family]}
                </label>
              ))}
            </fieldset>
            {visibleItems.length === 0 ? (
              <p className="empty-state">No events match the selected filters.</p>
            ) : (
              <ul className="timeline" data-testid="timeline">
                {visibleItems.map((item) => (
                  <TimelineRow key={item.key} item={item} taskId={aggregate.task.id} />
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="main-sidebar__aside" aria-label="Details">
          <section className="card" aria-label="Specification revisions">
            <h2 className="task-detail__card-title">Specification revisions</h2>
            <ul className="task-detail__side-list">
              {aggregate.revisions.map((revision) => (
                <li key={revision.id}>
                  <div className="task-detail__side-row">
                    <span>v{revision.version}</span>
                    <StateBadge state={revision.status} label={humanizeEnum(revision.status)} />
                    <Time value={revision.createdAt} />
                  </div>
                </li>
              ))}
            </ul>
            {revisions.length > 0 && (
              <details className="task-detail__revision-diff">
                <summary>Compare revisions</summary>
                <label>
                  Compare from
                  <select
                    value={fromRevisionId ?? ""}
                    onChange={(event) => setFromRevisionId(event.target.value)}
                  >
                    {revisions.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        v{revision.version}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Compare to
                  <select value={toRevisionId ?? ""} onChange={(event) => setToRevisionId(event.target.value)}>
                    {revisions.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        v{revision.version}
                      </option>
                    ))}
                  </select>
                </label>
                {diffText && <pre data-testid="spec-diff">{diffText}</pre>}
              </details>
            )}
          </section>

          <section className="card" aria-label="Approvals">
            <h2 className="task-detail__card-title">Approvals</h2>
            {aggregate.approvals.length === 0 ? (
              <p className="empty-state">No approvals yet.</p>
            ) : (
              <ul className="task-detail__side-list">
                {aggregate.approvals.map((approval) => {
                  // `SpecificationApproval` (api/types.ts) carries only
                  // `approvedBy`'s raw id, no display name or email (T8):
                  // shown in `title` for hover-lookup, never as visible
                  // text. The approved revision's version is shown when
                  // that revision is still in `revisions`.
                  const revision = revisions.find((candidate) => candidate.id === approval.revisionId);
                  return (
                    <li key={approval.id} title={approval.approvedBy}>
                      <div className="task-detail__side-row">
                        <span>{revision ? `v${revision.version} approved` : "Approved"}</span>
                        <Time value={approval.approvedAt} />
                        <span className="task-detail__side-meta">({approval.runtime})</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card" aria-label="Issues">
            <h2 className="task-detail__card-title">Issues</h2>
            {aggregate.issues.length === 0 ? (
              <p className="empty-state">No issues yet.</p>
            ) : (
              <ul className="task-detail__side-list">
                {aggregate.issues.map((issue) => (
                  <li key={issue.id}>
                    {issue.title} - {issue.status} <Link to={`/issues/${issue.id}`}>Open issue</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-label="Decisions">
            <h2 className="task-detail__card-title">Decisions</h2>
            {aggregate.decisions.length === 0 ? (
              <p className="empty-state">No decisions yet.</p>
            ) : (
              <ul className="task-detail__side-list">
                {aggregate.decisions.map((decision) => (
                  <li key={decision.id}>
                    <Link to={`/issues/${decision.issueId}`}>Issue</Link>: {decision.decision}
                    {decision.clarification ? ` - ${decision.clarification}` : ""}
                    {decision.chosenOption ? ` (${decision.chosenOption})` : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-label="Executions">
            <h2 className="task-detail__card-title">Executions</h2>
            <ul className="task-detail__side-list">
              {aggregate.executions.map((execution) => (
                <li key={execution.id}>
                  <div className="task-detail__side-row">
                    <StateBadge state={execution.state} />
                    <span>
                      {execution.role} attempt {execution.attempt}: {execution.state} ({execution.runtime}/
                      {execution.model}) - {formatUsd(Number(execution.costUsd))}
                    </span>
                  </div>
                  {execution.endReason && (
                    <p className="task-detail__side-meta">End reason: {humanizeEnum(execution.endReason)}</p>
                  )}
                  <ul>
                    {aggregate.reviewResults
                      .filter((review) => review.executionId === execution.id)
                      .map((review) => (
                        <li key={review.id}>
                          Round {review.round}: {review.verdict}
                          <ul>
                            {review.findings.map((finding, index) => (
                              <li key={index}>
                                {finding.severity}: {finding.description}
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
            <CostBreakdown taskId={aggregate.task.id} request={apiClient.request} />
          </section>

          <section className="card" aria-label="Pull request">
            <h2 className="task-detail__card-title">Pull request</h2>
            {aggregate.pullRequest ? (
              <p>
                <a href={aggregate.pullRequest.url}>#{aggregate.pullRequest.number}</a> -{" "}
                {aggregate.pullRequest.state} <StateBadge state={aggregate.pullRequest.ciState} />
              </p>
            ) : (
              <p className="empty-state">No pull request yet.</p>
            )}
            <p className="task-detail__mono task-detail__side-meta">Branch: {branch ?? "no branch"}</p>
          </section>

          <section className="card" aria-label="Dependencies">
            <h2 className="task-detail__card-title">Dependencies</h2>
            {aggregate.dependencies.length === 0 ? (
              <p className="empty-state">No dependencies.</p>
            ) : (
              <ul className="task-detail__side-list">
                {aggregate.dependencies.map((dependency) => (
                  <li key={dependency.taskId}>
                    {dependency.jiraKey} - {dependency.state}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
