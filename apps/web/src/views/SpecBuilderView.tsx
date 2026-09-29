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
import "../spec/spec.css";
import { SpecDraftForm } from "../spec/SpecDraftForm.js";
import { changedSpecFields, emptySpecContent, specContentEquals } from "../spec/specForm.js";
import {
  isLiveExecutionState,
  isSpecChatBacklogEvent,
  isSpecChatEventType,
  specRoleExecutionIds,
  SPEC_STREAM_EVENT_TYPES,
} from "../spec/specSession.js";
import { buildTimelineItems, mergeTimelineEvents } from "../task/timelineItems.js";
import { Markdown } from "../ui/Markdown.js";
import { StateBadge } from "../ui/StateBadge.js";
import { Time } from "../ui/Time.js";
import { humanizeEnum } from "../ui/humanizeEnum.js";

export interface SpecBuilderViewProps {
  /** Injectable for tests; defaults to a real createApiClient(). */
  client?: SpecApiClient;
  /** Injectable for tests; defaults to the real `EventSource`. */
  createEventSource?: EventSourceFactory;
}

type LoadState = "loading" | "loaded" | "not_found" | "error";

/**
 * One rendered chat pane row (GOT.57): the agent's bubbles/tool chips
 * (mirroring `TimelineItem`'s `message`/`tool_call` fields, ../task/timelineItems.js,
 * which this view does not own) plus the user's own `spec.message` bubbles,
 * merged and ordered by `eventId` in `chatEntries` below.
 */
interface ChatEntry {
  key: string;
  eventId: number;
  kind: "agent" | "tool_call" | "user";
  createdAt: string;
  text?: string;
  final?: boolean;
  toolName?: string;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

/** How long a changed field stays visually flagged after `spec.proposed`/`spec.revised` (design.md §14). */
const HIGHLIGHT_DURATION_MS = 5000;

/** Matches `TaskDetailView`'s backlog page size for `GET /tasks/:id/timeline`. */
const TIMELINE_PAGE_LIMIT = 200;

/**
 * Cap on the live chat events buffered while their execution id isn't yet
 * known to belong to the spec role (F2, GOT.38 review round 3): a stalled or
 * repeatedly-failing reconciling refetch must not grow this buffer without
 * bound. Oldest events are dropped first.
 */
const MAX_PENDING_CHAT_EVENTS = 500;

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

  // GOT.81 D1-D3: the repository the user has picked in the pre-session
  // dropdown (empty until chosen), and whether the inline "are you sure"
  // confirmation is currently shown. Neither is used once the task already
  // has a repository (`aggregate.repository !== null`): that dropdown is
  // never offered and the task's own repository is used instead.
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string>("");
  const [confirmingStart, setConfirmingStart] = useState(false);
  // GOT.81-fix1: guards POST /tasks/:id/spec/session against a double click
  // on Confirm sending two start requests (the second can 409 after a
  // successful first start). Also disables Cancel and re-opening the
  // confirmation via Start while the request is in flight.
  const [startingSession, setStartingSession] = useState(false);

  // Mirrors of `formContent`/`formBaseline` for `applyAggregate` below, which
  // runs at the end of an async fetch and needs the value current at that
  // moment, not the one captured when the enclosing callback was created.
  const formContentRef = useRef<SpecContent | null>(null);
  const formBaselineRef = useRef<SpecContent | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live chat events (`agent.message`/`.delta`/`agent.tool_call`) whose
  // execution id isn't (yet) known to be the spec execution's: buffered
  // rather than rendered or dropped outright (F1/F2, GOT.38 review round 2).
  // `pendingChatEventsRef` holds them until the drain effect below re-checks
  // them against a freshly-loaded `specExecutionIds`; `pendingRefetchRef`
  // debounces the refetch that refreshes it to one in flight at a time;
  // `foreignExecutionIdsRef` remembers an execution id a refetch already
  // confirmed does not belong (an execution's role never changes), so a
  // chatty non-spec execution (e.g. a paused implementation execution) does
  // not re-trigger a refetch for every message it emits.
  const pendingChatEventsRef = useRef<TimelineEvent[]>([]);
  const pendingRefetchRef = useRef(false);
  const foreignExecutionIdsRef = useRef<Set<string>>(new Set());
  // F2, GOT.38 review round 3: guards against an unbounded buffer if the
  // reconciling refetch never arrives (e.g. a wedged connection); oldest
  // events are dropped first and the drop is logged exactly once.
  const bufferCapWarnedRef = useRef(false);

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
    // F1, GOT.38 review round 4: every successful fetch (the initial load or
    // a later `refetch`, e.g. a reconnect catch-up) clears a stuck error
    // screen. Without this, an initial `loadInitial` failure left
    // `loadState` at "error" forever, even once a later `refetch` succeeded
    // and populated `aggregate`.
    setLoadState("loaded");
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
      // F1, GOT.38 review round 3: a failed refetch must not leave
      // `pendingRefetchRef` stuck true — that would permanently stop a later
      // unknown-execution chat event from ever retrying reconciliation.
      // Buffered events are left in place; the next unknown-id event (or the
      // next successful refetch, including a reconnect's) retries them.
      // Reset unconditionally, even if a newer refetch has since superseded
      // this one, since either the newer one already reset it or is still
      // in flight and will settle it itself.
      pendingRefetchRef.current = false;
      if (!isCurrent(generation)) return;
      setActionError(describeError(err));
    }
  }

  const eventSourceAvailable = createEventSource !== undefined || typeof EventSource !== "undefined";

  // Same spec-role execution id set the backlog load filters by (F1, GOT.38
  // review round 1). `null` before the first `getTask` resolves.
  const specExecutionIds = useMemo(
    () => (aggregate ? specRoleExecutionIds(aggregate.executions) : null),
    [aggregate],
  );

  // Re-checks buffered chat events against a freshly-known/refreshed
  // `specExecutionIds` (F1/F2, GOT.38 review round 2): runs once after the
  // first aggregate loads (specExecutionIds goes from `null` to a `Set`)
  // and again after every refetch the buffering below triggers. A match is
  // finally rendered; a miss means a real aggregate fetch has now confirmed
  // the execution id is foreign, so it is dropped for good.
  useEffect(() => {
    if (specExecutionIds === null) return;
    const pending = pendingChatEventsRef.current;
    if (pending.length === 0) return;
    pendingChatEventsRef.current = [];
    pendingRefetchRef.current = false;

    const matching: TimelineEvent[] = [];
    for (const pendingEvent of pending) {
      if (pendingEvent.executionId !== null && specExecutionIds.has(pendingEvent.executionId)) {
        matching.push(pendingEvent);
      } else if (pendingEvent.executionId !== null) {
        foreignExecutionIdsRef.current.add(pendingEvent.executionId);
      }
    }
    if (matching.length > 0) {
      setEvents((prev) => mergeTimelineEvents(prev, matching));
    }
  }, [specExecutionIds]);

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

      if (isSpecChatEventType(parsed.data.type)) {
        const executionId = parsed.data.executionId;
        const knownForeign = executionId !== null && foreignExecutionIdsRef.current.has(executionId);
        const belongs =
          !knownForeign &&
          specExecutionIds !== null &&
          executionId !== null &&
          specExecutionIds.has(executionId);

        if (!belongs) {
          if (!knownForeign) {
            // Either the spec-execution id set isn't known yet (F1: still
            // loading the first aggregate) or this id isn't in the set we
            // do know (F2: e.g. a retry started a new spec execution after
            // our last fetch). Buffer it rather than rendering or dropping
            // it on a set that might be stale; the drain effect above
            // re-checks it once the aggregate refreshes. Debounced to one
            // refetch at a time, and only once the set is known at all —
            // the initial load already covers the F1 case.
            const nextPending = [...pendingChatEventsRef.current, parsed.data];
            if (nextPending.length > MAX_PENDING_CHAT_EVENTS) {
              nextPending.splice(0, nextPending.length - MAX_PENDING_CHAT_EVENTS);
              if (!bufferCapWarnedRef.current) {
                bufferCapWarnedRef.current = true;
                console.warn(
                  `SpecBuilderView: pending chat event buffer exceeded ${MAX_PENDING_CHAT_EVENTS} events; dropping oldest`,
                );
              }
            }
            pendingChatEventsRef.current = nextPending;
            if (specExecutionIds !== null && !pendingRefetchRef.current) {
              pendingRefetchRef.current = true;
              void refetch(true);
            }
          }
          return;
        }
      }

      setEvents((prev) => mergeTimelineEvents(prev, [parsed.data]));
      if (!isSpecChatEventType(parsed.data.type)) {
        // execution.started / execution.resumed / spec.proposed /
        // spec.revised / spec.review_requested / spec.sent_back /
        // spec.approved / task.state_changed: none of these are rendered
        // directly in the chat, they all mean "go refetch".
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

  // Interleaves the agent's `chatItems` (built from `events` via
  // `buildTimelineItems`, which has no `spec.message` handling of its own --
  // that item shape is shared with `TaskDetailView`'s generic timeline and
  // isn't specific to this pane, GOT.57) with the user's own `spec.message`
  // events, read straight off `events`, in event order (AC3).
  const chatEntries = useMemo<ChatEntry[]>(() => {
    const agentEntries: ChatEntry[] = chatItems.map((item) =>
      item.kind === "tool_call"
        ? {
            key: item.key,
            eventId: item.eventId,
            kind: "tool_call",
            createdAt: item.createdAt,
            toolName: item.toolName ?? "tool",
          }
        : {
            key: item.key,
            eventId: item.eventId,
            kind: "agent",
            createdAt: item.createdAt,
            text: item.text ?? "",
            final: item.final ?? true,
          },
    );
    const userEntries: ChatEntry[] = events
      .filter((event) => event.type === "spec.message")
      .map((event) => {
        const record = asRecord(event.payload);
        return {
          key: `spec-message:${event.id}`,
          eventId: event.id,
          kind: "user",
          createdAt: event.createdAt,
          text: typeof record.text === "string" ? record.text : "",
        };
      });
    return [...agentEntries, ...userEntries].sort((a, b) => a.eventId - b.eventId);
  }, [chatItems, events]);

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

  // GOT.81 D1: a project with exactly one repository preselects it in the
  // pre-session dropdown -- the user still has to confirm Start. Only runs
  // while the task has no repository of its own yet (before the session
  // starts); once it does, this dropdown is never shown.
  useEffect(() => {
    if (!aggregate || aggregate.repository !== null) return;
    if (selectedRepositoryId !== "") return;
    if (projectRepositories.length === 1) {
      setSelectedRepositoryId(projectRepositories[0]!.id);
    }
  }, [aggregate, projectRepositories, selectedRepositoryId]);

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
    // GOT.81-fix1: a request is already in flight, ignore a second click.
    if (startingSession) return;
    // GOT.81 D2: the task's own repository (once it has one) always wins;
    // otherwise the id the user picked and is now confirming.
    const repositoryId = aggregate?.repository?.id ?? (selectedRepositoryId === "" ? null : selectedRepositoryId);
    if (repositoryId === null) return;
    setActionError(null);
    setStartingSession(true);
    try {
      await apiClient.startSpecSession(id, repositoryId);
      setConfirmingStart(false);
      await refetch(false);
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setStartingSession(false);
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
        <button type="button" onClick={() => void loadInitial()}>
          Retry
        </button>
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

  // GOT.81 D1-D3: a task that already has a repository (e.g. re-opening the
  // page once the session has started) never offers the dropdown -- its own
  // repository is used. Otherwise the id is whatever the user has chosen so
  // far (possibly none yet).
  const taskRepositoryId = aggregate.repository?.id ?? null;
  const offerRepositoryDropdown = showStartSessionButton && taskRepositoryId === null;
  const chosenRepositoryId = taskRepositoryId ?? (selectedRepositoryId === "" ? null : selectedRepositoryId);
  const canStartSession = chosenRepositoryId !== null;
  const startRepositoryName =
    (taskRepositoryId !== null
      ? aggregate.repository?.name
      : projectRepositories.find((repository) => repository.id === selectedRepositoryId)?.name) ?? "";

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

  // Q4: no draft, but the task has an approved revision -- show it
  // read-only rather than "No draft revision." (design.md §14 Spec
  // builder row, docs/design.md Appendix A).
  const approvedRevision = aggregate.approvedRevision;
  const showApprovedReadOnly = formContent === null && approvedRevision !== null;
  const approvedApproval = approvedRevision
    ? (aggregate.approvals.find((approval) => approval.revisionId === approvedRevision.id) ?? null)
    : null;

  // S2 (coordinator visual check, SCRUM-93): the right pane's heading
  // reflects what it is actually showing, not always "Draft" -- the same
  // three-way split the pane body already uses below.
  const draftPaneHeading = formContent ? "Draft" : showApprovedReadOnly ? "Specification" : "Draft";

  // S3 (coordinator visual check, SCRUM-93): every disabled footer/composer
  // action gets a `title` explaining why, derived from task state, so a
  // disabled button is never silent.
  const chatSendTitle = chatDisabledReason ?? undefined;
  const saveDraftTitle = canSaveDraft
    ? undefined
    : taskState !== "SPEC_IN_PROGRESS"
      ? `Task is ${humanizeEnum(taskState)}; drafts can only be saved while in progress.`
      : "No draft to save.";
  const requestReviewTitle = canRequestReview
    ? undefined
    : taskState !== "SPEC_IN_PROGRESS"
      ? `Task is ${humanizeEnum(taskState)}; review can only be requested while in progress.`
      : "Save a draft before requesting review.";
  const sendBackTitle = canSendBack ? undefined : `Task is ${humanizeEnum(taskState)}; can only send back from review.`;
  const approveTitle = canApprove
    ? undefined
    : taskState !== "SPEC_REVIEW"
      ? `Task is ${humanizeEnum(taskState)}; can only approve from review.`
      : !validation.ok
        ? (validation.errors[0] ?? "Spec is not ready to approve.")
        : "Spec is not ready to approve.";
  const reviseTitle = canRevise
    ? undefined
    : `Task is ${humanizeEnum(taskState)}; can only revise an approved or ready spec.`;

  return (
    <>
      <div className="page-header">
        <h1 className="page-header__title">
          {aggregate.task.jiraKey}: {aggregate.task.jiraSummary}
        </h1>
        <div className="page-header__actions">
          <StateBadge state={taskState} />
        </div>
      </div>
      {/* Kept for tests that assert the raw state string; StateBadge above is the human-readable one. */}
      <p data-testid="task-state" className="spec-builder__sr-only">
        {taskState}
      </p>
      {actionError && (
        <p className="alert alert--error" role="alert">
          {actionError}
        </p>
      )}

      <div className="split spec-builder__split">
        <section aria-label="Spec chat" className="split__pane spec-builder__chat-pane">
          <div className="spec-builder__chat-header">
            <h2>Chat</h2>
            {showStartSessionButton && (
              <div>
                {offerRepositoryDropdown && !confirmingStart && (
                  <label>
                    Repository
                    <select
                      value={selectedRepositoryId}
                      onChange={(event) => setSelectedRepositoryId(event.target.value)}
                    >
                      <option value="">Select a repository...</option>
                      {projectRepositories.map((repository) => (
                        <option key={repository.id} value={repository.id}>
                          {repository.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {confirmingStart ? (
                  <span role="group" aria-label="Confirm start spec session">
                    <span>
                      Start spec session on {startRepositoryName}? The repository can&apos;t be changed afterwards.
                    </span>
                    <button type="button" disabled={startingSession} onClick={() => void handleStartSession()}>
                      Confirm
                    </button>
                    <button type="button" disabled={startingSession} onClick={() => setConfirmingStart(false)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={!canStartSession || startingSession}
                    onClick={() => setConfirmingStart(true)}
                  >
                    Start spec session
                  </button>
                )}
              </div>
            )}
          </div>
          <ul className="spec-builder__chat-list" data-testid="spec-chat">
            {chatEntries.map((item) =>
              item.kind === "tool_call" ? (
                <li key={item.key} className="spec-builder__tool-line">
                  <span data-testid="tool-chip">{item.toolName}</span>
                </li>
              ) : (
                <li
                  key={item.key}
                  className={
                    item.kind === "user"
                      ? "spec-builder__bubble spec-builder__bubble--user"
                      : "spec-builder__bubble spec-builder__bubble--agent"
                  }
                >
                  <div className="spec-builder__bubble-meta">
                    <Time value={item.createdAt} />
                  </div>
                  <div data-testid="chat-message" className="spec-builder__bubble-text">
                    <Markdown>{item.text ?? ""}</Markdown>
                    {item.kind === "agent" && !item.final && " ..."}
                  </div>
                </li>
              ),
            )}
          </ul>
          <div className="spec-builder__composer">
            {chatDisabledReason && (
              <p className="spec-builder__disabled-reason" data-testid="chat-disabled-reason">
                {chatDisabledReason}
              </p>
            )}
            <form className="spec-builder__composer-form" onSubmit={(event) => void handleSendMessage(event)}>
              <label className="field">
                Message
                <textarea
                  value={messageText}
                  disabled={chatDisabledReason !== null}
                  onChange={(event) => setMessageText(event.target.value)}
                />
              </label>
              <button type="submit" disabled={chatDisabledReason !== null || messageText.trim() === ""} title={chatSendTitle}>
                Send
              </button>
            </form>
          </div>
        </section>

        <section aria-label="Spec draft" className="split__pane spec-builder__draft-pane">
          <h2>{draftPaneHeading}</h2>
          {isDirty && (
            <p data-testid="unsaved-changes" className="spec-builder__unsaved">
              Unsaved changes
            </p>
          )}
          {formContent ? (
            <SpecDraftForm
              content={formContent}
              highlightedFields={highlightedFields}
              disabled={taskState !== "SPEC_IN_PROGRESS"}
              onChange={setFormContent}
            />
          ) : showApprovedReadOnly && approvedRevision ? (
            <div className="spec-builder__approved" data-testid="approved-spec">
              <h3>Approved specification, version {approvedRevision.version}</h3>
              {approvedApproval && (
                <p className="spec-builder__approved-meta">
                  Approved <Time value={approvedApproval.approvedAt} />
                </p>
              )}
              <Markdown>{renderSpecMarkdown(approvedRevision.content)}</Markdown>
            </div>
          ) : (
            <div className="empty-state">
              <p>{taskState === "NEEDS_SPEC" ? "Start a spec session to begin." : "No draft revision."}</p>
            </div>
          )}

          <div className="spec-builder__draft-actions" aria-label="Actions">
            {formContent ? (
              <>
                <div className="toolbar">
                  <button type="button" disabled={!canSaveDraft} title={saveDraftTitle} onClick={() => void handleSaveDraft()}>
                    Save Draft
                  </button>
                  <button
                    type="button"
                    disabled={!canRequestReview}
                    title={requestReviewTitle}
                    onClick={() => void handleRequestReview()}
                  >
                    Request Review
                  </button>
                  <button type="button" disabled={!canSendBack} title={sendBackTitle} onClick={() => void handleSendBack()}>
                    Send Back
                  </button>
                  <label>
                    Runtime
                    <select value={runtimeValue} onChange={(event) => setRuntimeOverride(event.target.value as Runtime)}>
                      <option value="claude">claude</option>
                      <option value="codex">codex</option>
                    </select>
                  </label>
                  <button type="button" disabled={!canApprove} title={approveTitle} onClick={() => void handleApprove()}>
                    Approve
                  </button>
                </div>
                {!validation.ok && (
                  <p className="alert alert--error" data-testid="approve-blocker">
                    {validation.errors[0]}
                  </p>
                )}
              </>
            ) : (
              <div className="toolbar">
                <button type="button" disabled={!canRevise} title={reviseTitle} onClick={() => void handleRevise()}>
                  Revise
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      <section aria-label="Specification revisions" className="card spec-builder__revisions">
        <h2>Specification revisions</h2>
        <ul className="spec-builder__revision-list" data-testid="revision-list">
          {revisions.map((revision) => (
            <li key={revision.id} className="spec-builder__revision-row">
              <span className="spec-builder__revision-version">v{revision.version}</span>
              <StateBadge state={revision.status} />
              <Time value={revision.createdAt} />
            </li>
          ))}
        </ul>
        {revisions.length > 0 && (
          <details className="spec-builder__revision-details">
            <summary>Compare revisions</summary>
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
          </details>
        )}
      </section>
    </>
  );
}
