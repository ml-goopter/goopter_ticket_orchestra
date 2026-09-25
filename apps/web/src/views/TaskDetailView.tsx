import { EXECUTION_EVENT_TYPES } from "@orchestra/core";
import { diffSpecs } from "@orchestra/prompts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, createApiClient, type BoardApiClient } from "../api/client.js";
import { TimelineEventSchema, type TaskAggregate, type TimelineEvent } from "../api/types.js";
import { useRefetchOnReconnect } from "../board/useEventReconnect.js";
import { useLatestRequest } from "../board/useLatestRequest.js";
import { useEventStream, type EventSourceFactory } from "../sse/useEventStream.js";
import { EVENT_FAMILIES, FAMILY_LABELS, familyOf, type EventFamily } from "../task/eventFamilies.js";
import { buildTimelineItems, mergeTimelineEvents, type TimelineItem } from "../task/timelineItems.js";

export interface TaskDetailViewProps {
  /** Injectable for tests; defaults to a real createApiClient(). */
  client?: BoardApiClient;
  /** Injectable for tests; defaults to the real `EventSource`. */
  createEventSource?: EventSourceFactory;
}

/** Backlog page size for `GET /tasks/:id/timeline` (task contract C). */
const TIMELINE_PAGE_LIMIT = 200;

type LoadState = "loading" | "loaded" | "not_found" | "error";

function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Task detail (design.md §14 Task detail row, §12.2, §12.6, task contract
 * C): timeline with live SSE append, family filters, a side panel with
 * spec/approval/decision/execution/PR detail, and the cancel/retry actions.
 * Replaces the GOT.38 placeholder.
 */
export function TaskDetailView({ client, createEventSource }: TaskDetailViewProps = {}) {
  const { id } = useParams();
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const { begin, isCurrent } = useLatestRequest();

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [aggregate, setAggregate] = useState<TaskAggregate | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [streamAfter, setStreamAfter] = useState<number | null>(null);
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
      for (;;) {
        const page = await apiClient.getTimeline(id, { after, limit: TIMELINE_PAGE_LIMIT });
        if (!isCurrent(generation)) return;
        merged = mergeTimelineEvents(merged, page.events);
        if (page.events.length < TIMELINE_PAGE_LIMIT) {
          break;
        }
        after = page.nextAfter;
      }
      setEvents(merged);
      lastEventIdRef.current = merged.length > 0 ? merged[merged.length - 1]!.id : 0;
      setStreamAfter(lastEventIdRef.current);
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

  const { status } = useEventStream(
    `/api/tasks/${id}/stream${streamAfter !== null ? `?after=${streamAfter}` : ""}`,
    {
      types: EXECUTION_EVENT_TYPES,
      createEventSource,
      enabled: streamAfter !== null && eventSourceAvailable,
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
      <main>
        <h1>Task detail</h1>
        <p>Loading...</p>
      </main>
    );
  }

  if (loadState === "not_found") {
    return (
      <main>
        <h1>Task detail</h1>
        <p role="alert">Task not found.</p>
      </main>
    );
  }

  if (loadState === "error" || !aggregate) {
    return (
      <main>
        <h1>Task detail</h1>
        <p role="alert">{loadError ?? "Failed to load the task."}</p>
      </main>
    );
  }

  const canRetry = aggregate.task.state === "NEEDS_HUMAN";

  return (
    <main>
      <h1>
        {aggregate.task.jiraKey}: {aggregate.task.jiraSummary}
      </h1>
      <p data-testid="task-state">{aggregate.task.state}</p>
      <p data-testid="task-cost">{formatMoney(aggregate.cost.costUsd)}</p>

      <section aria-label="Actions">
        <button type="button" onClick={() => void handleCancel()}>
          Cancel
        </button>
        <button type="button" disabled={!canRetry} onClick={() => void handleRetry()}>
          Retry
        </button>
        <Link to={`/tasks/${aggregate.task.id}/spec`}>Open spec builder</Link>
        {actionError && <p role="alert">{actionError}</p>}
      </section>

      <section aria-label="Timeline">
        <h2>Timeline</h2>
        <fieldset>
          <legend>Filters</legend>
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
        <ul data-testid="timeline">
          {visibleItems.map((item) => (
            <TimelineRow key={item.key} item={item} />
          ))}
        </ul>
      </section>

      <aside aria-label="Details">
        <section aria-label="Specification revisions">
          <h2>Specification revisions</h2>
          <ul>
            {aggregate.revisions.map((revision) => (
              <li key={revision.id}>
                v{revision.version} - {revision.status}
              </li>
            ))}
          </ul>
          {revisions.length > 0 && (
            <div>
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
                <select
                  value={toRevisionId ?? ""}
                  onChange={(event) => setToRevisionId(event.target.value)}
                >
                  {revisions.map((revision) => (
                    <option key={revision.id} value={revision.id}>
                      v{revision.version}
                    </option>
                  ))}
                </select>
              </label>
              {diffText && <pre data-testid="spec-diff">{diffText}</pre>}
            </div>
          )}
        </section>

        <section aria-label="Approvals">
          <h2>Approvals</h2>
          <ul>
            {aggregate.approvals.map((approval) => (
              <li key={approval.id}>
                {approval.approvedBy} approved at {approval.approvedAt} ({approval.runtime})
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Issues">
          <h2>Issues</h2>
          <ul>
            {aggregate.issues.map((issue) => (
              <li key={issue.id}>
                {issue.title} - {issue.status} <Link to={`/issues/${issue.id}`}>Open issue</Link>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Decisions">
          <h2>Decisions</h2>
          <ul>
            {aggregate.decisions.map((decision) => (
              <li key={decision.id}>
                <Link to={`/issues/${decision.issueId}`}>Issue</Link>: {decision.decision}
                {decision.clarification ? ` - ${decision.clarification}` : ""}
                {decision.chosenOption ? ` (${decision.chosenOption})` : ""}
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Executions">
          <h2>Executions</h2>
          <ul>
            {aggregate.executions.map((execution) => (
              <li key={execution.id}>
                <p>
                  {execution.role} attempt {execution.attempt}: {execution.state} ({execution.runtime}/
                  {execution.model}) - {formatMoney(Number(execution.costUsd))}
                </p>
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
        </section>

        <section aria-label="Pull request">
          <h2>Pull request</h2>
          {aggregate.pullRequest ? (
            <p>
              <a href={aggregate.pullRequest.url}>#{aggregate.pullRequest.number}</a> -{" "}
              {aggregate.pullRequest.state} (CI: {aggregate.pullRequest.ciState})
            </p>
          ) : (
            <p>No pull request yet.</p>
          )}
        </section>

        <section aria-label="Dependencies">
          <h2>Dependencies</h2>
          <ul>
            {aggregate.dependencies.map((dependency) => (
              <li key={dependency.taskId}>
                {dependency.jiraKey} - {dependency.state}
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </main>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  if (item.kind === "message") {
    return (
      <li data-testid="timeline-item" data-type={item.type}>
        {item.text}
        {!item.final && " ..."}
      </li>
    );
  }

  if (item.kind === "tool_call") {
    return (
      <li data-testid="timeline-item" data-type={item.type}>
        <details>
          <summary>{item.toolName}</summary>
          <pre>{JSON.stringify(item.toolInput, null, 2)}</pre>
        </details>
      </li>
    );
  }

  if (item.kind === "state_changed") {
    return (
      <li data-testid="timeline-item" data-type={item.type}>
        {item.from} → {item.to}
      </li>
    );
  }

  return (
    <li data-testid="timeline-item" data-type={item.type}>
      {item.type}: {item.summary}
    </li>
  );
}
