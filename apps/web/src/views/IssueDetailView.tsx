import type { ResolutionKind } from "@orchestra/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, createApiClient, type IssueApiClient } from "../api/client.js";
import { TimelineEventSchema, type IssueDetail } from "../api/types.js";
import { useRefetchOnReconnect } from "../board/useEventReconnect.js";
import { useLatestRequest } from "../board/useLatestRequest.js";
import "../issue/issue.css";
import { AgentMessagePayloadSchema, reduceAgentReply, type LiveReply } from "../issue/liveReply.js";
import { parseSuggestedOptions } from "../issue/issueOptions.js";
import { createDeltaAccumulator } from "../sse/deltas.js";
import { useEventStream, type EventSourceFactory } from "../sse/useEventStream.js";
import { Markdown } from "../ui/Markdown.js";
import { StateBadge } from "../ui/StateBadge.js";
import { Time } from "../ui/Time.js";
import { humanizeEnum } from "../ui/humanizeEnum.js";

export interface IssueDetailViewProps {
  /** Injectable for tests; defaults to a real createApiClient(). */
  client?: IssueApiClient;
  /** Injectable for tests; defaults to the real `EventSource`. */
  createEventSource?: EventSourceFactory;
}

type LoadState = "loading" | "loaded" | "not_found" | "error";

/** Event types the issue detail thread cares about (design.md §12.6, §10.2-§10.5). */
const ISSUE_STREAM_TYPES = ["agent.message.delta", "agent.message", "issue.message", "issue.resolved"] as const;

/**
 * Renders `${code}: ${message}` for an api error so a 409's exact reason
 * (design.md §10.2-§10.5) is always visible, except for the one code the
 * contract maps to a friendlier composer message.
 */
function describeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === "EXECUTION_NOT_WAITING") {
      return "the agent is busy; the message can be sent when it pauses";
    }
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : fallback;
}

/**
 * Issue detail (design.md §14 Issue detail row, spec §18-§19). Replaces the
 * GOT.42 placeholder. Like `TaskDetailView` (GOT.41), the routed shell only
 * reads `id` and picks/creates the api client; all issue-scoped state lives
 * in `IssueDetailPanel`, remounted with `key={id}` so an in-app navigation
 * from one issue to another does not leave the previous issue's thread,
 * live reply buffer or form state attached to the new issue's page.
 */
export function IssueDetailView({ client, createEventSource }: IssueDetailViewProps = {}) {
  const { id } = useParams();
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);

  if (!id) {
    return (
      <main>
        <h1>Issue detail</h1>
        <p>Loading...</p>
      </main>
    );
  }

  return <IssueDetailPanel key={id} id={id} client={apiClient} createEventSource={createEventSource} />;
}

interface IssueDetailPanelProps {
  id: string;
  client: IssueApiClient;
  createEventSource?: EventSourceFactory;
}

function IssueDetailPanel({ id, client: apiClient, createEventSource }: IssueDetailPanelProps) {
  const navigate = useNavigate();
  const { begin, isCurrent } = useLatestRequest();

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [messageText, setMessageText] = useState("");
  const [messageError, setMessageError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const [decisionText, setDecisionText] = useState("");
  const [clarificationText, setClarificationText] = useState("");
  const [chosenOptionId, setChosenOptionId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const [liveReply, setLiveReply] = useState<LiveReply | null>(null);
  const accumulatorRef = useRef(createDeltaAccumulator());

  const loadIssue = useCallback(async () => {
    const generation = begin();
    setLoadState((prev) => (prev === "loaded" ? prev : "loading"));
    setLoadError(null);
    try {
      const loaded = await apiClient.getIssue(id);
      if (!isCurrent(generation)) return;
      setDetail(loaded);
      setLoadState("loaded");
    } catch (err) {
      if (!isCurrent(generation)) return;
      if (err instanceof ApiError && err.status === 404) {
        setLoadState("not_found");
      } else {
        setLoadState("error");
        setLoadError(err instanceof Error ? err.message : "Failed to load the issue.");
      }
    }
  }, [apiClient, id, begin, isCurrent]);

  useEffect(() => {
    void loadIssue();
  }, [loadIssue]);

  useEffect(() => {
    if (!detail) return;
    setChosenOptionId((prev) => prev ?? detail.issue.recommendedOption ?? null);
  }, [detail]);

  const eventSourceAvailable = createEventSource !== undefined || typeof EventSource !== "undefined";
  const taskId = detail?.task.id;
  const executionId = detail?.execution.id;

  // Bare URL (no `?after=`, C18): the hook appends its own `after=` on
  // reconnect via Last-Event-ID, and doubling the param is a 400. Disabled
  // until the task id is known -- the issue's stream lives at
  // `/api/tasks/<task id>/stream`, not at an issue-scoped path.
  const { status } = useEventStream(`/api/tasks/${taskId ?? ""}/stream`, {
    types: ISSUE_STREAM_TYPES,
    createEventSource,
    enabled: Boolean(taskId) && eventSourceAvailable,
    onEvent: (event) => {
      const parsed = TimelineEventSchema.safeParse(event.data);
      if (!parsed.success) return;
      if (!executionId || parsed.data.executionId !== executionId) return;

      if (parsed.data.type === "agent.message.delta" || parsed.data.type === "agent.message") {
        const payload = AgentMessagePayloadSchema.safeParse(parsed.data.payload);
        if (!payload.success) return;
        setLiveReply(
          reduceAgentReply(accumulatorRef.current, executionId, {
            type: parsed.data.type,
            text: payload.data.text,
          }),
        );
        return;
      }

      if (parsed.data.type === "issue.message" || parsed.data.type === "issue.resolved") {
        void loadIssue();
      }
    },
  });

  useRefetchOnReconnect(status, () => void loadIssue());

  const handleSend = useCallback(async () => {
    const text = messageText.trim();
    if (!text) return;
    setMessageError(null);
    setPosting(true);
    try {
      await apiClient.postIssueMessage(id, text);
      setMessageText("");
      await loadIssue();
    } catch (err) {
      setMessageError(describeApiError(err, "Failed to send the message."));
    } finally {
      setPosting(false);
    }
  }, [apiClient, id, messageText, loadIssue]);

  const submitResolve = useCallback(
    async (kind: ResolutionKind) => {
      const decision = decisionText.trim();
      if (!decision) return;
      setResolveError(null);
      setResolving(true);
      try {
        await apiClient.resolveIssue(id, {
          kind,
          decision,
          clarification: clarificationText.trim() || undefined,
          chosenOption: chosenOptionId ?? undefined,
        });
        if (kind === "spec_revision" && detail) {
          navigate(`/tasks/${detail.task.id}/spec`);
          return;
        }
        await loadIssue();
      } catch (err) {
        setResolveError(describeApiError(err, "Failed to resolve the issue."));
      } finally {
        setResolving(false);
      }
    },
    [apiClient, id, decisionText, clarificationText, chosenOptionId, detail, navigate, loadIssue],
  );

  const handleResolveClarification = useCallback(() => {
    void submitResolve("clarification");
  }, [submitResolve]);

  const handleResolveSpecRevision = useCallback(() => {
    const confirmed = window.confirm(
      "This creates a draft revision from the approved spec with your decision appended, and reopens the spec builder. Continue?",
    );
    if (!confirmed) return;
    void submitResolve("spec_revision");
  }, [submitResolve]);

  if (loadState === "loading" && !detail) {
    return (
      <main>
        <h1>Issue detail</h1>
        <p>Loading...</p>
      </main>
    );
  }

  if (loadState === "not_found") {
    return (
      <main>
        <h1>Issue detail</h1>
        <p role="alert">Issue not found.</p>
      </main>
    );
  }

  if (loadState === "error" || !detail) {
    return (
      <main>
        <h1>Issue detail</h1>
        <p role="alert">{loadError ?? "Failed to load the issue."}</p>
      </main>
    );
  }

  const { issue, execution, task, messages, decision } = detail;
  const options = parseSuggestedOptions(issue.suggestedOptions);
  const isOpen = issue.status === "OPEN";
  const composerDisabledReason = isOpen ? null : `Issue is ${issue.status}, not OPEN.`;

  return (
    <main>
      <div className="page-header">
        <h1 className="page-header__title">{issue.title}</h1>
        <div className="page-header__actions">
          <StateBadge state={issue.status} />
        </div>
      </div>
      {/* Kept for tests that assert the raw state string; StateBadge above is the human-readable one. */}
      <p data-testid="issue-status" className="issue-detail__sr-only">
        {issue.status}
      </p>

      <div className="issue-detail__meta">
        <span className="issue-detail__meta-item">{humanizeEnum(issue.type)}</span>
        {issue.blocking && <span className="badge badge--attention">Blocking</span>}
        <span className="issue-detail__meta-item">
          <Link to={`/tasks/${task.id}`}>{task.jira_key}</Link> <StateBadge state={task.state} />
        </span>
        <span className="issue-detail__meta-item" data-testid="issue-execution">
          Execution: {execution.role} <StateBadge state={execution.state} /> ({execution.runtime})
        </span>
        <span className="issue-detail__meta-item">
          <Link to={`/tasks/${task.id}/spec`}>Spec revision</Link>
        </span>
      </div>

      <section aria-label="Details">
        <Markdown>{issue.description}</Markdown>

        {issue.question && (
          <div className="card issue-detail__question">
            <p data-testid="issue-question">{issue.question}</p>
          </div>
        )}

        {isOpen && (
          <div className="card issue-detail__resolve-card">
            {options.length > 0 && (
              <fieldset className="issue-detail__options">
                <legend>Suggested options</legend>
                {options.map((option) => (
                  <label key={option.id}>
                    <input
                      type="radio"
                      name="chosen-option"
                      value={option.id}
                      checked={chosenOptionId === option.id}
                      onChange={() => setChosenOptionId(option.id)}
                    />
                    {option.description} ({option.tradeoff})
                    {issue.recommendedOption === option.id && " - recommended"}
                  </label>
                ))}
              </fieldset>
            )}

            <label className="field">
              Decision
              <textarea
                data-testid="decision-text"
                value={decisionText}
                onChange={(event) => setDecisionText(event.target.value)}
              />
            </label>
            <label className="field">
              Clarification (optional)
              <textarea
                data-testid="clarification-text"
                value={clarificationText}
                onChange={(event) => setClarificationText(event.target.value)}
              />
            </label>

            <div className="toolbar" aria-label="Resolve">
              <button
                type="button"
                disabled={decisionText.trim().length === 0 || resolving}
                onClick={handleResolveClarification}
              >
                Resolve as clarification
              </button>
              {issue.blocking ? (
                <button
                  type="button"
                  disabled={decisionText.trim().length === 0 || resolving}
                  onClick={handleResolveSpecRevision}
                >
                  This changes the spec
                </button>
              ) : (
                <p>The agent is not paused and will not be resumed.</p>
              )}
            </div>
            {resolveError && (
              <p className="alert alert--error" role="alert">
                {resolveError}
              </p>
            )}
          </div>
        )}

        {!isOpen && (
          <div className="card" aria-label="Resolution">
            <h2>Resolution</h2>
            <p data-testid="resolution-decision">{decision?.decision ?? issue.resolution ?? "No decision recorded."}</p>
            <p data-testid="resolution-kind">{humanizeEnum(issue.resolutionKind ?? issue.status)}</p>
            <p data-testid="resolution-time">
              <Time value={issue.resolvedAt} />
            </p>
          </div>
        )}
      </section>

      <section aria-label="Thread">
        <h2>Thread</h2>
        <ul data-testid="thread" className="issue-detail__thread">
          {messages.map((message) => (
            <li key={message.id} data-testid="thread-message" className="issue-detail__bubble">
              <div className="issue-detail__bubble-meta">
                <strong>{message.authorKind}</strong> <Time value={message.createdAt} />
              </div>
              {message.body}
            </li>
          ))}
          {liveReply && (
            <li data-testid="thread-live-reply" data-final={liveReply.final} className="issue-detail__bubble issue-detail__bubble--live">
              <div className="issue-detail__bubble-meta">
                <strong>agent</strong>
              </div>
              {liveReply.text}
              {!liveReply.final && " ..."}
            </li>
          )}
        </ul>
      </section>

      <section aria-label="Composer" className="card issue-detail__composer">
        <label className="field">
          Message
          <textarea
            data-testid="composer-text"
            value={messageText}
            disabled={composerDisabledReason !== null || posting}
            onChange={(event) => setMessageText(event.target.value)}
          />
        </label>
        <div className="toolbar">
          <button
            type="button"
            disabled={composerDisabledReason !== null || posting || messageText.trim().length === 0}
            onClick={() => void handleSend()}
          >
            Send
          </button>
        </div>
        {composerDisabledReason && (
          <p className="issue-detail__disabled-reason" role="alert">
            {composerDisabledReason}
          </p>
        )}
        {messageError && (
          <p className="alert alert--error" role="alert">
            {messageError}
          </p>
        )}
      </section>
    </main>
  );
}
