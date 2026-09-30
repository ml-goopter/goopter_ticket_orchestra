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
 * Same string used both for the `window.confirm` prompt and the one-line
 * explanation rendered under "This changes the spec" on a blocking issue
 * (UR5 AC5, spec §19): a single source so the two can never drift apart.
 */
const SPEC_REVISION_CONFIRM_TEXT =
  "This creates a draft revision from the approved spec with your decision appended, and reopens the spec builder. Continue?";

/** Initials for the thread bubble avatar (UR5 AC6), keyed by `authorKind`. */
function authorInitials(authorKind: "agent" | "user"): string {
  return authorKind === "agent" ? "AI" : "U";
}

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
    const confirmed = window.confirm(SPEC_REVISION_CONFIRM_TEXT);
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
      <div className="topbar">
        <div className="topbar__crumbs">
          <Link to="/">Board</Link>
          <span>/</span>
          <Link to={`/tasks/${task.id}`}>{task.jira_key}</Link>
          <span>/</span>
          <span className="topbar__crumb-current">Issue</span>
        </div>
        <div className="topbar__spacer" />
        <div className="topbar__actions">
          <Link className="btn" to={`/tasks/${task.id}/spec`}>
            Spec revision
          </Link>
        </div>
      </div>

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
      </div>

      <div className="split issue-detail__body">
        <section className="split__pane issue-detail__left" aria-label="Details">
          <div>
            <h2 className="issue-detail__section-title">Agent explanation</h2>
            <Markdown>{issue.description}</Markdown>
          </div>

          {issue.question && (
            <div className="card issue-detail__question">
              <p data-testid="issue-question">{issue.question}</p>
            </div>
          )}

          {isOpen && (
            <div className="card issue-detail__decision">
              <div className="issue-detail__decision-header">Your decision</div>

              {options.length > 0 && (
                <div className="issue-detail__options" role="radiogroup" aria-label="Suggested options">
                  {options.map((option) => (
                    <label
                      key={option.id}
                      className={`issue-detail__option${
                        chosenOptionId === option.id ? " issue-detail__option--selected" : ""
                      }`}
                    >
                      <input
                        type="radio"
                        name="chosen-option"
                        value={option.id}
                        checked={chosenOptionId === option.id}
                        onChange={() => setChosenOptionId(option.id)}
                      />
                      <span>
                        <strong>{option.description}</strong>
                        <span className="issue-detail__option-tradeoff">{option.tradeoff}</span>
                      </span>
                      {issue.recommendedOption === option.id && (
                        <span className="badge badge--success">Recommended</span>
                      )}
                    </label>
                  ))}
                </div>
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

              <div className="issue-detail__resolve" aria-label="Resolve">
                <div className="issue-detail__resolve-action">
                  <button
                    type="button"
                    disabled={decisionText.trim().length === 0 || resolving}
                    onClick={handleResolveClarification}
                  >
                    Resolve as clarification
                  </button>
                  {issue.blocking && (
                    <p className="issue-detail__resolve-why">
                      The agent resumes with your decision. The spec is unchanged.
                    </p>
                  )}
                </div>
                {issue.blocking ? (
                  <div className="issue-detail__resolve-action">
                    <button
                      type="button"
                      disabled={decisionText.trim().length === 0 || resolving}
                      onClick={handleResolveSpecRevision}
                    >
                      This changes the spec
                    </button>
                    <p className="issue-detail__resolve-why">{SPEC_REVISION_CONFIRM_TEXT}</p>
                  </div>
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
            <div className="card issue-detail__resolution" aria-label="Resolution">
              <h2 className="issue-detail__section-title">Resolution</h2>
              <p data-testid="resolution-decision">
                {decision?.decision ?? issue.resolution ?? "No decision recorded."}
              </p>
              <p className="issue-detail__resolution-meta">
                <span data-testid="resolution-kind">{humanizeEnum(issue.resolutionKind ?? issue.status)}</span>
                {" · "}
                <span data-testid="resolution-time">
                  <Time value={issue.resolvedAt} />
                </span>
              </p>
            </div>
          )}
        </section>

        <aside className="split__pane issue-detail__thread-pane" aria-label="Thread">
          <h2 className="issue-detail__section-title">Thread</h2>
          <ul data-testid="thread" className="issue-detail__thread">
            {messages.map((message) => (
              <li key={message.id} data-testid="thread-message" className="issue-detail__bubble">
                <span
                  className={`issue-detail__avatar issue-detail__avatar--${message.authorKind}`}
                  aria-hidden="true"
                >
                  {authorInitials(message.authorKind)}
                </span>
                <div>
                  <div className="issue-detail__bubble-meta">
                    <strong>{message.authorKind}</strong> <Time value={message.createdAt} />
                  </div>
                  <div className="issue-detail__bubble-text">{message.body}</div>
                </div>
              </li>
            ))}
            {liveReply && (
              <li
                data-testid="thread-live-reply"
                data-final={liveReply.final}
                className="issue-detail__bubble issue-detail__bubble--live"
              >
                <span className="issue-detail__avatar issue-detail__avatar--agent" aria-hidden="true">
                  {authorInitials("agent")}
                </span>
                <div>
                  <div className="issue-detail__bubble-meta">
                    <strong>agent</strong>
                  </div>
                  <div className="issue-detail__bubble-text">
                    {liveReply.text}
                    {!liveReply.final && (
                      <span className="issue-detail__typing" data-testid="thread-live-typing" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                  </div>
                </div>
              </li>
            )}
          </ul>

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
        </aside>
      </div>
    </main>
  );
}
