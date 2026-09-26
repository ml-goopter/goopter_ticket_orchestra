import type { FormEvent } from "react";
import type { Runtime, SpecContent } from "@orchestra/core";
import { validateSpecForApproval } from "@orchestra/core";
import { diffSpecs, renderSpecMarkdown } from "@orchestra/prompts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { ApiError, createApiClient, type SpecApiClient } from "../api/client.js";
import {
  TimelineEventSchema,
  type AdminRepository,
  type SpecificationRevision,
  type TaskAggregate,
  type TimelineEvent,
} from "../api/types.js";
import { useRefetchOnReconnect } from "../board/useEventReconnect.js";
import { useLatestRequest } from "../board/useLatestRequest.js";
import { useEventStream, type EventSourceFactory } from "../sse/useEventStream.js";
import { SpecDraftForm } from "../spec/SpecDraftForm.js";
import { changedSpecFields, emptySpecContent, specContentEquals } from "../spec/specForm.js";
import {
  isLiveExecutionState,
  isSpecChatBacklogEvent,
  isSpecChatLiveEvent,
  specRoleExecutionIds,
  SPEC_STREAM_EVENT_TYPES,
} from "../spec/specSession.js";
import { buildTimelineItems, mergeTimelineEvents } from "../task/timelineItems.js";

export interface SpecBuilderViewProps {
  /** Injectable for tests; defaults to a real createApiClient(). */
  client?: SpecApiClient;
  /** Injectable for tests; defaults to the real `EventSource`. */
  createEventSource?: EventSourceFactory;
}

type LoadState = "loading" | "loaded" | "not_found" | "error";

/** How long a changed field stays visually flagged after `spec.proposed`/`spec.revised` (design.md §14). */
const HIGHLIGHT_DURATION_MS = 5000;

/** Matches `TaskDetailView`'s backlog page size for `GET /tasks/:id/timeline`. */
const TIMELINE_PAGE_LIMIT = 200;

/** Every api error is shown with its code (contract AC5), never just the message alone. */
function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * Spec builder split pane (design.md §14 Spec builder row, §4.3, §12.3, spec
 * §5): streamed chat with the spec agent on the left, the structured draft
 * form on the right, footer actions gated on task state and validation, and
 * revision history with a diff. Replaces the GOT.38 placeholder.
 *
 * This routed shell only reads `id` and picks/creates the api client. All
 * task-scoped state lives in `SpecBuilderPanel`, remounted with `key={id}`
 * whenever the route's task id changes, matching `TaskDetailView`
 * (docs/build-order.md GOT.38/42 note): an in-app navigation between two
 * tasks must not leave the previous task's chat, form, or SSE subscription
 * attached to the new task's page.
 */
export function SpecBuilderView({ client, createEventSource }: SpecBuilderViewProps = {}) {
  const { id } = useParams();
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);

  if (!id) {
    return (
      <main>
        <h1>Spec builder</h1>
        <p>Loading...</p>
      </main>
    );
  }

  return <SpecBuilderPanel key={id} id={id} client={apiClient} createEventSource={createEventSource} />;
}

interface SpecBuilderPanelProps {
  id: string;
  client: SpecApiClient;
  createEventSource?: EventSourceFactory;
}

function SpecBuilderPanel({ id, client: apiClient, createEventSource }: SpecBuilderPanelProps) {
  const { begin, isCurrent } = useLatestRequest();

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [aggregate, setAggregate] = useState<TaskAggregate | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [projectRepositories, setProjectRepositories] = useState<AdminRepository[]>([]);

  const [draftRevision, setDraftRevision] = useState<SpecificationRevision | null>(null);
  const [formContent, setFormContent] = useState<SpecContent | null>(null);
  const [formBaseline, setFormBaseline] = useState<SpecContent | null>(null);
  const [highlightedFields, setHighlightedFields] = useState<ReadonlySet<string>>(new Set());
  const [runtimeOverride, setRuntimeOverride] = useState<Runtime | null>(null);

  const [messageText, setMessageText] = useState("");
  const [events, setEvents] = useState<TimelineEvent[]>([]);

  const [fromRevisionId, setFromRevisionId] = useState<string | null>(null);
  const [toRevisionId, setToRevisionId] = useState<string | null>(null);
  const [readRevisionId, setReadRevisionId] = useState<string | null>(null);

  // Mirrors of `formContent`/`formBaseline` for `applyAggregate` below, which
  // runs at the end of an async fetch and needs the value current at that
  // moment, not the one captured when the enclosing callback was created.
  const formContentRef = useRef<SpecContent | null>(null);
  const formBaselineRef = useRef<SpecContent | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    formContentRef.current = formContent;
  }, [formContent]);
  useEffect(() => {
    formBaselineRef.current = formBaseline;
  }, [formBaseline]);
  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    [],
  );

  /**
   * Applies a freshly-fetched aggregate: always updates `aggregate` and
   * `draftRevision`, but only replaces the form when the draft actually
   * changed. When `promptIfDirty` is set (an externally-driven refresh: an
   * SSE event or a reconnect catch-up, not the user's own action) and the
   * form has unsaved local edits, confirms before overwriting them (C24):
   * declining leaves the form and its dirty state untouched.
   */
  function applyAggregate(next: TaskAggregate, promptIfDirty: boolean) {
    setAggregate(next);
    const draft = next.revisions.find((revision) => revision.status === "draft") ?? null;
    const newContent = draft ? draft.content : null;
    setDraftRevision(draft);

    const previousBaseline = formBaselineRef.current;
    const baselineUnchanged =
      (previousBaseline === null && newContent === null) ||
      (previousBaseline !== null && newContent !== null && specContentEquals(previousBaseline, newContent));
    if (baselineUnchanged) {
      return;
    }

    const currentForm = formContentRef.current;
    const dirty =
      currentForm !== null && previousBaseline !== null && !specContentEquals(currentForm, previousBaseline);

    if (dirty && promptIfDirty) {
      const proceed = window.confirm(
        "The draft changed on the server. Discard your unsaved changes and load the new version?",
      );
      if (!proceed) {
        return;
      }
    }

    setFormContent(newContent);
    setFormBaseline(newContent);

    if (previousBaseline && newContent) {
      const changed = changedSpecFields(previousBaseline, newContent);
      setHighlightedFields(changed);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlightedFields(new Set()), HIGHLIGHT_DURATION_MS);
    } else {
      setHighlightedFields(new Set());
    }
  }

  async function loadInitial() {
    const generation = begin();
    setLoadState("loading");
    setLoadError(null);
    try {
      const loadedAggregate = await apiClient.getTask(id);
      if (!isCurrent(generation)) return;
      applyAggregate(loadedAggregate, false);
      setLoadState("loaded");
      try {
        const repos = await apiClient.listProjectRepositories(loadedAggregate.project.id);
        if (isCurrent(generation)) setProjectRepositories(repos);
      } catch {
        // Best-effort: an empty list fails the repository-exists check safe
        // (Approve stays disabled) rather than silently passing it.
      }
      try {
        const specExecutionIds = specRoleExecutionIds(loadedAggregate.executions);
        let backlog: TimelineEvent[] = [];
        let after: number | undefined;
        for (;;) {
          const page = await apiClient.getTimeline(id, { after, limit: TIMELINE_PAGE_LIMIT });
          if (!isCurrent(generation)) return;
          backlog = mergeTimelineEvents(
            backlog,
            page.events.filter((event) => isSpecChatBacklogEvent(event, specExecutionIds)),
          );
          if (page.events.length < TIMELINE_PAGE_LIMIT) break;
          after = page.nextAfter;
        }
        // Merge with (rather than replace) whatever is already in `events`:
        // the stream subscribes independently of this load, so a live event
        // can already be in state here and must not be dropped (mirrors
        // `TaskDetailView`'s backlog/live merge).
        setEvents((prev) => mergeTimelineEvents(prev, backlog));
      } catch {
        // Best-effort: a reload's chat history failing to load must not
        // block the rest of the page; the user can still see and use the
        // live chat and draft form.
      }
    } catch (err) {
      if (!isCurrent(generation)) return;
      if (err instanceof ApiError && err.status === 404) {
        setLoadState("not_found");
      } else {
        setLoadState("error");
        setLoadError(describeError(err));
      }
    }
  }

  useEffect(() => {
    void loadInitial();
    // `id` is fixed for this component's lifetime (SpecBuilderView remounts
    // it with `key={id}`), so this fetches exactly once per task id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function refetch(promptIfDirty: boolean) {
    const generation = begin();
    try {
      const next = await apiClient.getTask(id);
      if (!isCurrent(generation)) return;
      applyAggregate(next, promptIfDirty);
    } catch (err) {
      if (!isCurrent(generation)) return;
      setActionError(describeError(err));
    }
  }

  const eventSourceAvailable = createEventSource !== undefined || typeof EventSource !== "undefined";

  // Same spec-role execution id set the backlog load filters by (F1, GOT.38
  // review round 1). `null` before the first `getTask` resolves; an event
  // arriving in that narrow window passes through unfiltered rather than
  // being dropped before we know which executions belong to this task.
  const specExecutionIds = useMemo(
    () => (aggregate ? specRoleExecutionIds(aggregate.executions) : null),
    [aggregate],
  );

  // Bare URL (C23, docs/build-order.md GOT.38/42 note): the hook appends its
  // own `after=` on reconnect, so passing one here would duplicate the param
  // and the api would reject it with 400.
  const { status } = useEventStream(`/api/tasks/${id}/stream`, {
    types: SPEC_STREAM_EVENT_TYPES,
    createEventSource,
    enabled: Boolean(id) && eventSourceAvailable,
    onEvent: (event) => {
      const parsed = TimelineEventSchema.safeParse(event.data);
      if (!parsed.success) return;
      if (specExecutionIds && !isSpecChatLiveEvent(parsed.data, specExecutionIds)) {
        // Another execution's chat noise sharing this task's stream (e.g. a
        // paused implementation execution, design.md §10.4): not this
        // pane's chat, and not a signal to refetch either.
        return;
      }
      setEvents((prev) => mergeTimelineEvents(prev, [parsed.data]));
      if (parsed.data.type !== "agent.message.delta" && parsed.data.type !== "agent.message" && parsed.data.type !== "agent.tool_call") {
        // spec.proposed / spec.revised / spec.review_requested /
        // spec.sent_back / spec.approved / task.state_changed: none of these
        // are rendered directly in the chat, they all mean "go refetch".
        void refetch(true);
      }
    },
  });

  // `GET /tasks/:id/stream` has no replay (user decision Q8): a dropped
  // connection can only recover by refetching, not by trusting events
  // missed while it was down.
  useRefetchOnReconnect(status, () => void refetch(true));

  const chatItems = useMemo(
    () => buildTimelineItems(events).filter((item) => item.kind === "message" || item.kind === "tool_call"),
    [events],
  );

  const revisions = useMemo(() => aggregate?.revisions ?? [], [aggregate]);

  useEffect(() => {
    if (revisions.length === 0) return;
    setFromRevisionId((prev) => prev ?? revisions[Math.max(0, revisions.length - 2)]!.id);
    setToRevisionId((prev) => prev ?? revisions[revisions.length - 1]!.id);
    setReadRevisionId((prev) => prev ?? revisions[revisions.length - 1]!.id);
  }, [revisions]);

  // A blank draft to hand-write from when the task has no draft revision yet
  // but is in a state where one can be created (design.md §14: "editable by
  // hand"). The baseline is the same blank object, so nothing is considered
  // dirty until the user actually types something.
  useEffect(() => {
    if (!aggregate) return;
    if (draftRevision === null && formContent === null && aggregate.task.state === "SPEC_IN_PROGRESS") {
      const blank = emptySpecContent(aggregate.repository?.name ?? "");
      setFormContent(blank);
      setFormBaseline(blank);
    }
  }, [aggregate, draftRevision, formContent]);

  const diffText = useMemo(() => {
    const from = revisions.find((revision) => revision.id === fromRevisionId);
    const to = revisions.find((revision) => revision.id === toRevisionId);
    if (!from || !to) return null;
    return diffSpecs(from.content, to.content, { a: `v${from.version}`, b: `v${to.version}` });
  }, [revisions, fromRevisionId, toRevisionId]);

  const readMarkdown = useMemo(() => {
    const revision = revisions.find((r) => r.id === readRevisionId);
    return revision ? renderSpecMarkdown(revision.content) : null;
  }, [revisions, readRevisionId]);

  async function handleStartSession() {
    setActionError(null);
    try {
      await apiClient.startSpecSession(id);
      await refetch(false);
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  async function handleSendMessage(event: FormEvent) {
    event.preventDefault();
    const text = messageText.trim();
    if (!text) return;
    setActionError(null);
    try {
      await apiClient.postSpecMessage(id, text);
      setMessageText("");
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  async function handleSaveDraft() {
    if (!formContent) return;
    setActionError(null);
    try {
      await apiClient.saveDraft(id, formContent);
      await refetch(false);
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  async function handleRequestReview() {
    setActionError(null);
    try {
      await apiClient.requestReview(id);
      await refetch(false);
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  async function handleSendBack() {
    setActionError(null);
    try {
      await apiClient.sendBack(id);
      await refetch(false);
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  async function handleApprove() {
    setActionError(null);
    try {
      // D18: `runtime` is only sent when the user actually picked something
      // other than the repository's default in the dropdown. Sending the
      // resolved default on every approval would write a permanent
      // `tasks.runtime_override`, so the task stops tracking the
      // repository's default runtime the next time it changes.
      const runtimeChanged = runtimeOverride !== null && runtimeOverride !== defaultRuntime;
      await apiClient.approveSpec(id, runtimeChanged ? runtimeOverride : undefined);
      await refetch(false);
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  async function handleRevise() {
    setActionError(null);
    try {
      await apiClient.reviseSpec(id);
      await refetch(false);
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  if (loadState === "loading" && !aggregate) {
    return (
      <main>
        <h1>Spec builder</h1>
        <p>Loading...</p>
      </main>
    );
  }

  if (loadState === "not_found") {
    return (
      <main>
        <h1>Spec builder</h1>
        <p role="alert">Task not found.</p>
      </main>
    );
  }

  if (loadState === "error" || !aggregate) {
    return (
      <main>
        <h1>Spec builder</h1>
        <p role="alert">{loadError ?? "Failed to load the task."}</p>
      </main>
    );
  }

  const taskState = aggregate.task.state;
  const specExecution = aggregate.latestExecutions.spec;
  const hasLiveSpecExecution = isLiveExecutionState(specExecution?.state);
  // `POST /tasks/:id/spec/session` is only legal from NEEDS_SPEC
  // (apps/api/src/routes/spec.ts): resuming a SPEC_IN_PROGRESS task with no
  // live execution (e.g. after a send-back) is the spec role worker's job
  // (GOT.37), not a route this button can call.
  const showStartSessionButton = taskState === "NEEDS_SPEC";

  const chatDisabledReason: string | null =
    taskState !== "SPEC_IN_PROGRESS"
      ? "The task is not in progress."
      : !hasLiveSpecExecution
        ? "No live spec execution."
        : null;

  const isDirty = formContent !== null && formBaseline !== null && !specContentEquals(formContent, formBaseline);

  const repositoryExists = (name: string) => projectRepositories.some((repository) => repository.name === name);
  const validation = formContent
    ? validateSpecForApproval(formContent, repositoryExists)
    : { ok: false as const, errors: ["No draft to approve."] };

  const matchingRepository = formContent
    ? (projectRepositories.find((repository) => repository.name === formContent.repository) ?? null)
    : null;
  const defaultRuntime: Runtime = matchingRepository?.default_runtime ?? aggregate.repository?.defaultRuntime ?? "claude";
  const runtimeValue: Runtime = runtimeOverride ?? defaultRuntime;

  const canSaveDraft = taskState === "SPEC_IN_PROGRESS" && formContent !== null;
  const canRequestReview = taskState === "SPEC_IN_PROGRESS" && draftRevision !== null;
  const canSendBack = taskState === "SPEC_REVIEW";
  const canApprove = taskState === "SPEC_REVIEW" && validation.ok;
  const canRevise = taskState === "SPEC_APPROVED" || taskState === "READY";

  return (
    <main>
      <h1>
        {aggregate.task.jiraKey}: {aggregate.task.jiraSummary}
      </h1>
      <p data-testid="task-state">{taskState}</p>
      {actionError && <p role="alert">{actionError}</p>}

      <section aria-label="Spec chat">
        <h2>Chat</h2>
        {showStartSessionButton && (
          <button type="button" onClick={() => void handleStartSession()}>
            Start spec session
          </button>
        )}
        <ul data-testid="spec-chat">
          {chatItems.map((item) =>
            item.kind === "tool_call" ? (
              <li key={item.key}>
                <span data-testid="tool-chip">{item.toolName}</span>
              </li>
            ) : (
              <li key={item.key} data-testid="chat-message">
                {item.text}
                {!item.final && " ..."}
              </li>
            ),
          )}
        </ul>
        <form onSubmit={(event) => void handleSendMessage(event)}>
          <label>
            Message
            <input
              value={messageText}
              disabled={chatDisabledReason !== null}
              onChange={(event) => setMessageText(event.target.value)}
            />
          </label>
          <button type="submit" disabled={chatDisabledReason !== null || messageText.trim() === ""}>
            Send
          </button>
        </form>
        {chatDisabledReason && <p data-testid="chat-disabled-reason">{chatDisabledReason}</p>}
      </section>

      <section aria-label="Spec draft">
        <h2>Draft</h2>
        {isDirty && <p data-testid="unsaved-changes">Unsaved changes</p>}
        {formContent ? (
          <SpecDraftForm
            content={formContent}
            highlightedFields={highlightedFields}
            disabled={taskState !== "SPEC_IN_PROGRESS"}
            onChange={setFormContent}
          />
        ) : (
          <p>{taskState === "NEEDS_SPEC" ? "Start a spec session to begin." : "No draft revision."}</p>
        )}
      </section>

      <section aria-label="Actions">
        <button type="button" disabled={!canSaveDraft} onClick={() => void handleSaveDraft()}>
          Save Draft
        </button>
        <button type="button" disabled={!canRequestReview} onClick={() => void handleRequestReview()}>
          Request Review
        </button>
        <button type="button" disabled={!canSendBack} onClick={() => void handleSendBack()}>
          Send Back
        </button>
        <label>
          Runtime
          <select value={runtimeValue} onChange={(event) => setRuntimeOverride(event.target.value as Runtime)}>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
        </label>
        <button type="button" disabled={!canApprove} onClick={() => void handleApprove()}>
          Approve
        </button>
        {!validation.ok && <p data-testid="approve-blocker">{validation.errors[0]}</p>}
        <button type="button" disabled={!canRevise} onClick={() => void handleRevise()}>
          Revise
        </button>
      </section>

      <section aria-label="Specification revisions">
        <h2>Specification revisions</h2>
        <ul>
          {revisions.map((revision) => (
            <li key={revision.id}>
              v{revision.version} - {revision.status} - {revision.createdAt}
            </li>
          ))}
        </ul>
        {revisions.length > 0 && (
          <div>
            <label>
              Compare from
              <select value={fromRevisionId ?? ""} onChange={(event) => setFromRevisionId(event.target.value)}>
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

            <label>
              View revision
              <select value={readRevisionId ?? ""} onChange={(event) => setReadRevisionId(event.target.value)}>
                {revisions.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    v{revision.version}
                  </option>
                ))}
              </select>
            </label>
            {readMarkdown && <pre data-testid="spec-read-view">{readMarkdown}</pre>}
          </div>
        )}
      </section>
    </main>
  );
}
