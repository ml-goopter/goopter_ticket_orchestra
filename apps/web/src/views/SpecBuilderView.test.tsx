// @vitest-environment jsdom
import type { SpecContent } from "@orchestra/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type SpecApiClient } from "../api/client.js";
import type { AdminRepository, SpecificationRevision, TaskAggregate } from "../api/types.js";
import type { EventSourceLike, MessageEventLike } from "../sse/useEventStream.js";
import { makeFakeClient, makeTaskAggregate, makeTimelineEvent } from "../task/fixtures.js";
import { SpecBuilderView } from "./SpecBuilderView.js";

afterEach(cleanup);
beforeEach(() => {
  FakeEventSource.instances = [];
});

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  closed = false;
  onerror: ((event: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEventLike) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEventLike) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown, id?: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId: id });
    }
  }
}

function factory(url: string): EventSourceLike {
  return new FakeEventSource(url);
}

function currentSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("no FakeEventSource created yet");
  return source;
}

function makeRevision(overrides: Partial<SpecificationRevision> = {}): SpecificationRevision {
  return {
    id: "rev-draft",
    taskId: "task-1",
    version: 1,
    status: "draft",
    content: validSpecContent,
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeAdminRepository(overrides: Partial<AdminRepository> = {}): AdminRepository {
  return {
    id: "repo-1",
    project_id: "project-1",
    name: "tsk-repo",
    git_url: "git@example.com:goopter/tsk-repo.git",
    default_branch: "main",
    default_runtime: "claude",
    default_model: null,
    max_concurrent_worktrees: 1,
    required_capability: null,
    setup_command: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const validSpecContent: SpecContent = {
  repository: "tsk-repo",
  objective: "Do the thing",
  scope: ["in scope"],
  out_of_scope: ["not in scope"],
  requirements: ["req1"],
  acceptance_criteria: ["ac1"],
  validation: ["validate1"],
  constraints: ["constraint1"],
  dependencies: [],
  risks: [],
  notes: "",
};

function aggregateInProgress(overrides: Partial<TaskAggregate> = {}): TaskAggregate {
  const base = makeTaskAggregate();
  return makeTaskAggregate({
    task: { ...base.task, state: "SPEC_IN_PROGRESS" },
    latestExecutions: { spec: { ...base.executions[0]!, state: "RUNNING" }, implementation: null },
    revisions: [],
    approvals: [],
    approvedRevision: null,
    ...overrides,
  });
}

function renderSpecBuilder(client: SpecApiClient, taskId = "task-1") {
  return render(
    <MemoryRouter initialEntries={[`/tasks/${taskId}/spec`]}>
      <Routes>
        <Route path="/tasks/:id/spec" element={<SpecBuilderView client={client} createEventSource={factory} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SpecBuilderView", () => {
  it("shows a loading state before the aggregate resolves", () => {
    const client = makeFakeClient({ getTask: vi.fn(() => new Promise<never>(() => {})) });
    renderSpecBuilder(client);

    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("renders a visible 404 state when the task does not exist", async () => {
    const client = makeFakeClient({
      getTask: vi.fn().mockRejectedValue(new ApiError(404, "NOT_FOUND", "Task not found.")),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Task not found."));
  });

  it(
    "recovers from a failed initial load once a reconnect refetch succeeds (F1, review round 4)",
    async () => {
      const getTask = vi
        .fn()
        .mockRejectedValueOnce(new Error("network blip"))
        .mockResolvedValue(aggregateInProgress());
      const client = makeFakeClient({ getTask });
      renderSpecBuilder(client);

      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(screen.queryByTestId("task-state")).toBeNull();

      await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
      await act(async () => {
        currentSource().onopen?.();
      });
      await act(async () => {
        currentSource().onerror?.(new Event("error"));
      });

      await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(1), { timeout: 3000 });

      await act(async () => {
        currentSource().onopen?.();
      });

      await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByTestId("task-state")).toBeTruthy());
      expect(screen.queryByRole("alert")).toBeNull();
    },
    10000,
  );

  it("retries the initial load from the error screen's Retry button", async () => {
    const getTask = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValue(aggregateInProgress());
    const client = makeFakeClient({ getTask });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("task-state")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables Approve and shows the first failing rule when the draft has an empty required list", async () => {
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(
        aggregateInProgress({
          task: { ...makeTaskAggregate().task, state: "SPEC_REVIEW" },
          revisions: [makeRevision({ content: { ...validSpecContent, scope: [] } })],
        }),
      ),
      listProjectRepositories: vi.fn().mockResolvedValue([makeAdminRepository()]),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("SPEC_REVIEW"));
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("approve-blocker").textContent).toBe("scope must not be empty");
  });

  it("enables Approve once every required list is non-empty and the repository resolves", async () => {
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(
        aggregateInProgress({
          task: { ...makeTaskAggregate().task, state: "SPEC_REVIEW" },
          revisions: [makeRevision({ content: validSpecContent })],
        }),
      ),
      listProjectRepositories: vi.fn().mockResolvedValue([makeAdminRepository({ name: "tsk-repo" })]),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("SPEC_REVIEW"));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByTestId("approve-blocker")).toBeNull();
  });

  it("collapses agent.message.delta rows into one bubble, replaced by the final agent.message, and renders a tool call as a chip", async () => {
    const client = makeFakeClient({ getTask: vi.fn().mockResolvedValue(aggregateInProgress()) });
    renderSpecBuilder(client);

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    // "exec-spec-1" is `aggregateInProgress()`'s spec-role execution id
    // (F1, GOT.38 review round 1): the live handler now drops chat rows
    // from any other execution, so these must be tagged with it.
    await act(async () => {
      currentSource().emit(
        "agent.message.delta",
        makeTimelineEvent({ id: 1, executionId: "exec-spec-1", type: "agent.message.delta", payload: { text: "Hel" } }),
        "1",
      );
    });
    await act(async () => {
      currentSource().emit(
        "agent.message.delta",
        makeTimelineEvent({ id: 2, executionId: "exec-spec-1", type: "agent.message.delta", payload: { text: "lo" } }),
        "2",
      );
    });

    await waitFor(() => expect(screen.getAllByTestId("chat-message")).toHaveLength(1));
    expect(screen.getByTestId("chat-message").textContent).toContain("Hello");

    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({ id: 3, executionId: "exec-spec-1", type: "agent.message", payload: { text: "Hello there" } }),
        "3",
      );
    });

    await waitFor(() => expect(screen.getAllByTestId("chat-message")).toHaveLength(1));
    expect(screen.getByTestId("chat-message").textContent).toBe("Hello there");

    await act(async () => {
      currentSource().emit(
        "agent.tool_call",
        makeTimelineEvent({ id: 4, executionId: "exec-spec-1", type: "agent.tool_call", payload: { name: "search_docs" } }),
        "4",
      );
    });

    await waitFor(() => expect(screen.getByTestId("tool-chip").textContent).toBe("search_docs"));
  });

  it("drops a live agent.message from another execution sharing the task, but keeps one from the spec execution (F1)", async () => {
    const client = makeFakeClient({ getTask: vi.fn().mockResolvedValue(aggregateInProgress()) });
    renderSpecBuilder(client);

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    // "exec-impl-1" is `aggregateInProgress()`'s implementation execution
    // (paused, sharing this task's stream per design.md §10.4): its chat
    // rows must not render in the spec chat pane.
    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({
          id: 1,
          executionId: "exec-impl-1",
          type: "agent.message",
          payload: { text: "Implementation chatter" },
        }),
        "1",
      );
    });
    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({ id: 2, executionId: "exec-spec-1", type: "agent.message", payload: { text: "Spec chat" } }),
        "2",
      );
    });

    await waitFor(() => expect(screen.getAllByTestId("chat-message")).toHaveLength(1));
    expect(screen.getByTestId("chat-message").textContent).toBe("Spec chat");
  });

  it("buffers live chat events until the aggregate's spec-execution id set is known, then keeps only the one from the spec execution (F1, review round 2)", async () => {
    let resolveGetTask!: (aggregate: TaskAggregate) => void;
    const getTaskPromise = new Promise<TaskAggregate>((resolve) => {
      resolveGetTask = resolve;
    });
    const getTask = vi.fn().mockReturnValue(getTaskPromise);
    const client = makeFakeClient({ getTask });
    renderSpecBuilder(client);

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    // Both arrive while the first aggregate is still loading, so neither
    // execution id is known to be (or not be) the spec execution's yet.
    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({
          id: 1,
          executionId: "exec-impl-1",
          type: "agent.message",
          payload: { text: "Implementation chatter" },
        }),
        "1",
      );
    });
    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({ id: 2, executionId: "exec-spec-1", type: "agent.message", payload: { text: "Spec chat" } }),
        "2",
      );
    });

    expect(screen.queryByTestId("chat-message")).toBeNull();

    await act(async () => {
      resolveGetTask(aggregateInProgress());
    });

    await waitFor(() => expect(screen.getAllByTestId("chat-message")).toHaveLength(1));
    expect(screen.getByTestId("chat-message").textContent).toBe("Spec chat");
  });

  it("buffers a live chat event from an unknown execution, refetches once, and renders it only once the refreshed aggregate confirms it's a spec execution (F2, review round 2)", async () => {
    const initialAggregate = aggregateInProgress();
    const newSpecExecution = { ...initialAggregate.executions[0]!, id: "exec-spec-2" };
    const refreshedAggregate: TaskAggregate = {
      ...initialAggregate,
      executions: [...initialAggregate.executions, newSpecExecution],
      latestExecutions: { ...initialAggregate.latestExecutions, spec: newSpecExecution },
    };
    const getTask = vi
      .fn()
      .mockResolvedValueOnce(initialAggregate)
      .mockResolvedValueOnce(refreshedAggregate)
      .mockResolvedValue(refreshedAggregate);
    const client = makeFakeClient({ getTask });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByTestId("task-state")).toBeTruthy());
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    // "exec-spec-2" is not yet in the loaded aggregate's executions (e.g. a
    // retry started it after the last fetch): buffer and refetch once.
    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({
          id: 1,
          executionId: "exec-spec-2",
          type: "agent.message",
          payload: { text: "New spec execution chat" },
        }),
        "1",
      );
    });

    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByTestId("chat-message")).toHaveLength(1));
    expect(screen.getByTestId("chat-message").textContent).toBe("New spec execution chat");

    // A second unknown execution id, still absent from the refreshed
    // aggregate, triggers exactly one more refetch and is then dropped for
    // good rather than rendered.
    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({ id: 2, executionId: "exec-unknown", type: "agent.message", payload: { text: "Never belongs" } }),
        "2",
      );
    });

    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(3));
    expect(screen.getAllByTestId("chat-message")).toHaveLength(1);
  });

  it("refetches the aggregate on a live execution.started/execution.resumed event, even with no accompanying chat row (F2, review round 2)", async () => {
    const getTask = vi.fn().mockResolvedValue(aggregateInProgress());
    const client = makeFakeClient({ getTask });
    renderSpecBuilder(client);

    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    await act(async () => {
      currentSource().emit(
        "execution.started",
        makeTimelineEvent({ id: 1, executionId: "exec-spec-2", type: "execution.started", payload: {} }),
        "1",
      );
    });

    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
  });

  it("resets the debounce after a failed reconciling refetch, so a later event for the same unknown id retries and eventually renders both buffered messages (F1, review round 3)", async () => {
    const initialAggregate = aggregateInProgress();
    const newSpecExecution = { ...initialAggregate.executions[0]!, id: "exec-spec-2" };
    const refreshedAggregate: TaskAggregate = {
      ...initialAggregate,
      executions: [...initialAggregate.executions, newSpecExecution],
      latestExecutions: { ...initialAggregate.latestExecutions, spec: newSpecExecution },
    };
    const getTask = vi
      .fn()
      .mockResolvedValueOnce(initialAggregate)
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(refreshedAggregate)
      .mockResolvedValue(refreshedAggregate);
    const client = makeFakeClient({ getTask });
    renderSpecBuilder(client);

    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    // Unknown execution id: buffered, and triggers the debounced refetch,
    // which rejects.
    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({ id: 1, executionId: "exec-spec-2", type: "agent.message", payload: { text: "First try" } }),
        "1",
      );
    });
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // The failed refetch must not leave the debounce stuck: no chat is
    // rendered yet (the buffered message is still unresolved), but nothing
    // permanently drops it.
    expect(screen.queryByTestId("chat-message")).toBeNull();

    // A later event for the same still-unknown id must trigger another
    // refetch rather than being silently buffered forever.
    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({
          id: 2,
          executionId: "exec-spec-2",
          type: "agent.message",
          payload: { text: "Retry success" },
        }),
        "2",
      );
    });

    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getAllByTestId("chat-message")).toHaveLength(2));
    const rendered = screen.getAllByTestId("chat-message").map((node) => node.textContent);
    expect(rendered).toEqual(["First try", "Retry success"]);
  });

  it("caps the pending chat event buffer, dropping the oldest events and warning once (F2, review round 3)", async () => {
    const initialAggregate = aggregateInProgress();
    const newSpecExecution = { ...initialAggregate.executions[0]!, id: "exec-unknown" };
    const refreshedAggregate: TaskAggregate = {
      ...initialAggregate,
      executions: [...initialAggregate.executions, newSpecExecution],
      latestExecutions: { ...initialAggregate.latestExecutions, spec: newSpecExecution },
    };
    let resolveSecondFetch!: (aggregate: TaskAggregate) => void;
    const secondFetch = new Promise<TaskAggregate>((resolve) => {
      resolveSecondFetch = resolve;
    });
    const getTask = vi.fn().mockResolvedValueOnce(initialAggregate).mockReturnValueOnce(secondFetch);
    const client = makeFakeClient({ getTask });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    renderSpecBuilder(client);
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const TOTAL_EVENTS = 510;
    const MAX_PENDING_CHAT_EVENTS = 500;
    await act(async () => {
      for (let i = 0; i < TOTAL_EVENTS; i += 1) {
        currentSource().emit(
          "agent.message",
          makeTimelineEvent({
            id: i + 1,
            executionId: "exec-unknown",
            type: "agent.message",
            payload: { text: `msg-${i}` },
          }),
          String(i + 1),
        );
      }
    });

    // Only the first buffered event debounces a refetch; the deferred
    // promise above keeps that refetch pending while the rest buffer.
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSecondFetch(refreshedAggregate);
    });

    await waitFor(() => expect(screen.getAllByTestId("chat-message")).toHaveLength(MAX_PENDING_CHAT_EVENTS));
    const rendered = screen.getAllByTestId("chat-message").map((node) => node.textContent);
    // The oldest (TOTAL_EVENTS - MAX_PENDING_CHAT_EVENTS) events were
    // dropped, so the surviving window starts right after them.
    expect(rendered[0]).toBe(`msg-${TOTAL_EVENTS - MAX_PENDING_CHAT_EVENTS}`);
    expect(rendered[rendered.length - 1]).toBe(`msg-${TOTAL_EVENTS - 1}`);

    warnSpy.mockRestore();
  });

  it("loads the chat backlog from GET /tasks/:id/timeline on mount, and a live event with an overlapping id is not duplicated", async () => {
    const backlogEvent = makeTimelineEvent({
      id: 7,
      executionId: "exec-spec-1",
      type: "agent.message",
      payload: { text: "Backlog hello" },
    });
    const getTimeline = vi.fn().mockResolvedValue({ events: [backlogEvent], nextAfter: 7 });
    const client = makeFakeClient({ getTask: vi.fn().mockResolvedValue(aggregateInProgress()), getTimeline });
    renderSpecBuilder(client);

    // The backlog renders before any live event is emitted.
    await waitFor(() => expect(screen.getAllByTestId("chat-message")).toHaveLength(1));
    expect(screen.getByTestId("chat-message").textContent).toBe("Backlog hello");

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({
          id: 7,
          executionId: "exec-spec-1",
          type: "agent.message",
          payload: { text: "Backlog hello" },
        }),
        "7",
      );
    });

    expect(screen.getAllByTestId("chat-message")).toHaveLength(1);
  });

  it("excludes an implementation execution's agent.message from the spec chat backlog", async () => {
    const backlogEvent = makeTimelineEvent({
      id: 8,
      executionId: "exec-impl-1",
      type: "agent.message",
      payload: { text: "Implementation chatter" },
    });
    const getTimeline = vi.fn().mockResolvedValue({ events: [backlogEvent], nextAfter: 8 });
    const client = makeFakeClient({ getTask: vi.fn().mockResolvedValue(aggregateInProgress()), getTimeline });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByTestId("task-state")).toBeTruthy());
    await waitFor(() => expect(getTimeline).toHaveBeenCalled());
    expect(screen.queryByTestId("chat-message")).toBeNull();
  });

  it("renders a live spec.message as a right-aligned user bubble, ordered among agent bubbles by event order (AC3)", async () => {
    const client = makeFakeClient({ getTask: vi.fn().mockResolvedValue(aggregateInProgress()) });
    renderSpecBuilder(client);

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({ id: 1, executionId: "exec-spec-1", type: "agent.message", payload: { text: "Agent hello" } }),
        "1",
      );
    });
    await act(async () => {
      currentSource().emit(
        "spec.message",
        makeTimelineEvent({
          id: 2,
          executionId: "exec-spec-1",
          type: "spec.message",
          payload: { text: "User reply", author_user_id: "user-1" },
        }),
        "2",
      );
    });
    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({ id: 3, executionId: "exec-spec-1", type: "agent.message", payload: { text: "Agent again" } }),
        "3",
      );
    });

    await waitFor(() => expect(screen.getAllByTestId("chat-message")).toHaveLength(3));
    const bubbles = screen.getAllByTestId("chat-message");
    expect(bubbles.map((node) => node.textContent)).toEqual(["Agent hello", "User reply", "Agent again"]);

    const userBubble = bubbles[1]!.closest("li");
    expect(userBubble?.className).toContain("spec-builder__bubble--user");
    const agentBubble = bubbles[0]!.closest("li");
    expect(agentBubble?.className).toContain("spec-builder__bubble--agent");
    expect(agentBubble?.className).not.toContain("spec-builder__bubble--user");
  });

  it("loads spec.message events from the chat backlog on mount, interleaved with agent messages in event order (AC2)", async () => {
    const backlog = [
      makeTimelineEvent({ id: 5, executionId: "exec-spec-1", type: "agent.message", payload: { text: "Agent backlog" } }),
      makeTimelineEvent({
        id: 6,
        executionId: "exec-spec-1",
        type: "spec.message",
        payload: { text: "User backlog", author_user_id: "user-1" },
      }),
    ];
    const getTimeline = vi.fn().mockResolvedValue({ events: backlog, nextAfter: 6 });
    const client = makeFakeClient({ getTask: vi.fn().mockResolvedValue(aggregateInProgress()), getTimeline });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getAllByTestId("chat-message")).toHaveLength(2));
    expect(screen.getAllByTestId("chat-message").map((node) => node.textContent)).toEqual([
      "Agent backlog",
      "User backlog",
    ]);
    const userBubble = screen.getAllByTestId("chat-message")[1]!.closest("li");
    expect(userBubble?.className).toContain("spec-builder__bubble--user");
  });

  it("refetches and replaces the form with highlights on spec.proposed, preserving unsaved edits behind a confirm prompt", async () => {
    const initialRevision = makeRevision({ content: validSpecContent });
    const revisedContent: SpecContent = { ...validSpecContent, objective: "A different objective" };
    const getTask = vi
      .fn()
      .mockResolvedValueOnce(aggregateInProgress({ revisions: [initialRevision] }))
      .mockResolvedValue(aggregateInProgress({ revisions: [{ ...initialRevision, content: revisedContent }] }));
    const client = makeFakeClient({ getTask });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByLabelText("Objective")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "My local edit" } });
    expect(screen.getByTestId("unsaved-changes")).toBeTruthy();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => {
      currentSource().emit(
        "spec.proposed",
        makeTimelineEvent({ id: 10, type: "spec.proposed", executionId: null, payload: { revisionId: initialRevision.id } }),
        "10",
      );
    });
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));

    // Declined: the local edit survives.
    expect((screen.getByLabelText("Objective") as HTMLTextAreaElement).value).toBe("My local edit");

    confirmSpy.mockReturnValue(true);
    await act(async () => {
      currentSource().emit(
        "spec.proposed",
        makeTimelineEvent({ id: 11, type: "spec.proposed", executionId: null, payload: { revisionId: initialRevision.id } }),
        "11",
      );
    });
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(3));

    // Accepted: the server's new content replaces the form and is highlighted.
    await waitFor(() =>
      expect((screen.getByLabelText("Objective") as HTMLTextAreaElement).value).toBe("A different objective"),
    );
    expect(screen.getByTestId("spec-field-objective").getAttribute("data-highlighted")).toBe("true");
    expect(screen.queryByTestId("unsaved-changes")).toBeNull();

    confirmSpy.mockRestore();
  });

  it("calls saveDraft with the current form content and refetches", async () => {
    const saveDraft = vi.fn().mockResolvedValue(makeRevision());
    const getTask = vi.fn().mockResolvedValue(aggregateInProgress({ revisions: [makeRevision()] }));
    const client = makeFakeClient({ getTask, saveDraft });
    renderSpecBuilder(client);

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save Draft" }) as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    });

    await waitFor(() => expect(saveDraft).toHaveBeenCalledWith("task-1", expect.objectContaining(validSpecContent)));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
  });

  it("GOT.81 D2: the draft's repository field is read-only and shows the task's repository, not a dropdown", async () => {
    const getTask = vi.fn().mockResolvedValue(aggregateInProgress({ revisions: [makeRevision({ content: validSpecContent })] }));
    const client = makeFakeClient({ getTask });
    renderSpecBuilder(client);

    const field = (await screen.findByLabelText("Repository")) as HTMLInputElement;
    expect(field.tagName).toBe("INPUT");
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe("tsk-repo");
  });

  it("calls requestReview and refetches", async () => {
    const requestReview = vi.fn().mockResolvedValue({ from: "SPEC_IN_PROGRESS", to: "SPEC_REVIEW" });
    const getTask = vi.fn().mockResolvedValue(aggregateInProgress({ revisions: [makeRevision()] }));
    const client = makeFakeClient({ getTask, requestReview });
    renderSpecBuilder(client);

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Request Review" }) as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Request Review" }));
    });

    await waitFor(() => expect(requestReview).toHaveBeenCalledWith("task-1"));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
  });

  it("calls sendBack and refetches", async () => {
    const sendBack = vi.fn().mockResolvedValue({ from: "SPEC_REVIEW", to: "SPEC_IN_PROGRESS" });
    const getTask = vi.fn().mockResolvedValue(
      aggregateInProgress({
        task: { ...makeTaskAggregate().task, state: "SPEC_REVIEW" },
        revisions: [makeRevision()],
      }),
    );
    const client = makeFakeClient({ getTask, sendBack });
    renderSpecBuilder(client);

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Send Back" }) as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send Back" }));
    });

    await waitFor(() => expect(sendBack).toHaveBeenCalledWith("task-1"));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
  });

  it("omits runtime on Approve when the dropdown is left at the repository's default (D18)", async () => {
    const approveSpec = vi.fn().mockResolvedValue({ from: "SPEC_REVIEW", to: "SPEC_APPROVED", revisionId: "rev-draft" });
    const getTask = vi.fn().mockResolvedValue(
      aggregateInProgress({
        task: { ...makeTaskAggregate().task, state: "SPEC_REVIEW" },
        revisions: [makeRevision({ content: validSpecContent })],
      }),
    );
    const client = makeFakeClient({
      getTask,
      approveSpec,
      listProjectRepositories: vi.fn().mockResolvedValue([makeAdminRepository({ name: "tsk-repo", default_runtime: "codex" })]),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect((screen.getByLabelText("Runtime") as HTMLSelectElement).value).toBe("codex"));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    });

    // Sending the resolved default here would write a permanent
    // `tasks.runtime_override` (D18), so the task stops tracking the
    // repository's default runtime the next time it changes.
    await waitFor(() => expect(approveSpec).toHaveBeenCalledWith("task-1", undefined));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
  });

  it("sends the runtime on Approve when the user picks something other than the repository's default (D18)", async () => {
    const approveSpec = vi.fn().mockResolvedValue({ from: "SPEC_REVIEW", to: "SPEC_APPROVED", revisionId: "rev-draft" });
    const getTask = vi.fn().mockResolvedValue(
      aggregateInProgress({
        task: { ...makeTaskAggregate().task, state: "SPEC_REVIEW" },
        revisions: [makeRevision({ content: validSpecContent })],
      }),
    );
    const client = makeFakeClient({
      getTask,
      approveSpec,
      listProjectRepositories: vi.fn().mockResolvedValue([makeAdminRepository({ name: "tsk-repo", default_runtime: "codex" })]),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect((screen.getByLabelText("Runtime") as HTMLSelectElement).value).toBe("codex"));
    fireEvent.change(screen.getByLabelText("Runtime"), { target: { value: "claude" } });

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    });

    await waitFor(() => expect(approveSpec).toHaveBeenCalledWith("task-1", "claude"));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
  });

  it("calls reviseSpec and refetches", async () => {
    const reviseSpec = vi.fn().mockResolvedValue({ from: "SPEC_APPROVED", to: "SPEC_APPROVED", revisionId: "rev-draft" });
    const getTask = vi
      .fn()
      .mockResolvedValue(aggregateInProgress({ task: { ...makeTaskAggregate().task, state: "SPEC_APPROVED" } }));
    const client = makeFakeClient({ getTask, reviseSpec });
    renderSpecBuilder(client);

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Revise" }) as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    });

    await waitFor(() => expect(reviseSpec).toHaveBeenCalledWith("task-1"));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
  });

  function needsSpecAggregate(overrides: Partial<TaskAggregate> = {}): TaskAggregate {
    return aggregateInProgress({
      task: { ...makeTaskAggregate().task, state: "NEEDS_SPEC" },
      // GOT.81 D1-D3: before a session starts, no repository is assigned yet.
      repository: null,
      ...overrides,
    });
  }

  it("GOT.81 D1: preselects the project's single repository in the start-session dropdown, but still requires confirming", async () => {
    const getTask = vi.fn().mockResolvedValue(needsSpecAggregate());
    const client = makeFakeClient({
      getTask,
      listProjectRepositories: vi.fn().mockResolvedValue([makeAdminRepository({ id: "repo-1", name: "tsk-repo" })]),
    });
    renderSpecBuilder(client);

    const select = await screen.findByLabelText("Repository");
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("repo-1"));
    expect((screen.getByRole("button", { name: "Start spec session" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("GOT.81: lists the project's repositories as dropdown options and disables Start until one is chosen", async () => {
    const getTask = vi.fn().mockResolvedValue(needsSpecAggregate());
    const client = makeFakeClient({
      getTask,
      listProjectRepositories: vi
        .fn()
        .mockResolvedValue([makeAdminRepository({ id: "repo-1", name: "repo-a" }), makeAdminRepository({ id: "repo-2", name: "repo-b" })]),
    });
    renderSpecBuilder(client);

    const select = (await screen.findByLabelText("Repository")) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "Select a repository...",
      "repo-a",
      "repo-b",
    ]);
    expect((screen.getByRole("button", { name: "Start spec session" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(select, { target: { value: "repo-2" } });

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Start spec session" }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("GOT.81 D2/D3: Start opens an inline confirmation naming the repository; Cancel sends nothing", async () => {
    const startSpecSession = vi.fn().mockResolvedValue({ from: "NEEDS_SPEC", to: "SPEC_IN_PROGRESS" });
    const getTask = vi.fn().mockResolvedValue(needsSpecAggregate());
    const client = makeFakeClient({
      getTask,
      startSpecSession,
      listProjectRepositories: vi.fn().mockResolvedValue([makeAdminRepository({ id: "repo-1", name: "tsk-repo" })]),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect((screen.getByLabelText("Repository") as HTMLSelectElement).value).toBe("repo-1"));
    fireEvent.click(screen.getByRole("button", { name: "Start spec session" }));

    await waitFor(() => expect(screen.getByText(/Start spec session on tsk-repo\?/)).toBeTruthy());
    expect(screen.getByText(/can.t be changed afterwards/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Start spec session" })).toBeTruthy());
    expect(startSpecSession).not.toHaveBeenCalled();
  });

  it("GOT.81: Confirm sends repository_id to startSpecSession and refetches", async () => {
    const startSpecSession = vi.fn().mockResolvedValue({ from: "NEEDS_SPEC", to: "SPEC_IN_PROGRESS" });
    const getTask = vi.fn().mockResolvedValue(needsSpecAggregate());
    const client = makeFakeClient({
      getTask,
      startSpecSession,
      listProjectRepositories: vi.fn().mockResolvedValue([makeAdminRepository({ id: "repo-1", name: "tsk-repo" })]),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect((screen.getByLabelText("Repository") as HTMLSelectElement).value).toBe("repo-1"));
    fireEvent.click(screen.getByRole("button", { name: "Start spec session" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });

    await waitFor(() => expect(startSpecSession).toHaveBeenCalledWith("task-1", "repo-1"));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
  });

  it("GOT.81-fix1: clicking Confirm twice quickly sends exactly one startSpecSession request, and disables Confirm/Cancel while in flight", async () => {
    let resolveStart!: (value: { from: string; to: string }) => void;
    const startPromise = new Promise<{ from: string; to: string }>((resolve) => {
      resolveStart = resolve;
    });
    const startSpecSession = vi.fn().mockReturnValue(startPromise);
    const getTask = vi.fn().mockResolvedValue(needsSpecAggregate());
    const client = makeFakeClient({
      getTask,
      startSpecSession,
      listProjectRepositories: vi.fn().mockResolvedValue([makeAdminRepository({ id: "repo-1", name: "tsk-repo" })]),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect((screen.getByLabelText("Repository") as HTMLSelectElement).value).toBe("repo-1"));
    fireEvent.click(screen.getByRole("button", { name: "Start spec session" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy());

    const confirmButton = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    const cancelButton = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;

    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    fireEvent.click(cancelButton);

    expect(startSpecSession).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveStart({ from: "NEEDS_SPEC", to: "SPEC_IN_PROGRESS" });
      await startPromise;
    });

    expect(startSpecSession).toHaveBeenCalledTimes(1);
  });

  it("GOT.81: surfaces the api's error code when starting the session fails", async () => {
    const startSpecSession = vi
      .fn()
      .mockRejectedValue(new ApiError(422, "REPOSITORY_REQUIRED", "A repository is required."));
    const getTask = vi.fn().mockResolvedValue(needsSpecAggregate());
    const client = makeFakeClient({
      getTask,
      startSpecSession,
      listProjectRepositories: vi.fn().mockResolvedValue([makeAdminRepository({ id: "repo-1", name: "tsk-repo" })]),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect((screen.getByLabelText("Repository") as HTMLSelectElement).value).toBe("repo-1"));
    fireEvent.click(screen.getByRole("button", { name: "Start spec session" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("REPOSITORY_REQUIRED"));
  });

  it("does not show the Start spec session button in SPEC_IN_PROGRESS, even with no live spec execution (the route only allows NEEDS_SPEC)", async () => {
    const base = makeTaskAggregate();
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(
        aggregateInProgress({
          latestExecutions: { spec: { ...base.executions[0]!, state: "COMPLETED" }, implementation: null },
        }),
      ),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByTestId("task-state")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Start spec session" })).toBeNull();
  });

  it("shows the api's error code when a footer action fails with a 409", async () => {
    const saveDraft = vi.fn().mockRejectedValue(new ApiError(409, "ILLEGAL_STATE", "The task is not in progress."));
    const getTask = vi.fn().mockResolvedValue(aggregateInProgress({ revisions: [makeRevision()] }));
    const client = makeFakeClient({ getTask, saveDraft });
    renderSpecBuilder(client);

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save Draft" }) as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("ILLEGAL_STATE"));
  });

  it("disables the chat input and shows the reason when there is no live spec execution", async () => {
    const base = makeTaskAggregate();
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(
        aggregateInProgress({ latestExecutions: { spec: { ...base.executions[0]!, state: "COMPLETED" }, implementation: null } }),
      ),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect((screen.getByLabelText("Message") as HTMLInputElement).disabled).toBe(true));
    expect(screen.getByTestId("chat-disabled-reason").textContent).toBe("No live spec execution.");
  });

  it("disables the chat input outside SPEC_IN_PROGRESS even with a live-looking execution", async () => {
    const base = makeTaskAggregate();
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(
        aggregateInProgress({
          task: { ...makeTaskAggregate().task, state: "SPEC_REVIEW" },
          latestExecutions: { spec: { ...base.executions[0]!, state: "RUNNING" }, implementation: null },
        }),
      ),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect((screen.getByLabelText("Message") as HTMLInputElement).disabled).toBe(true));
    expect(screen.getByTestId("chat-disabled-reason").textContent).toBe("The task is not in progress.");
  });

  it("posts a chat message when the input is enabled", async () => {
    const postSpecMessage = vi.fn().mockResolvedValue({ commandId: "cmd-1", executionId: "exec-1" });
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(aggregateInProgress()),
      postSpecMessage,
    });
    renderSpecBuilder(client);

    await waitFor(() => expect((screen.getByLabelText("Message") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello agent" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    await waitFor(() => expect(postSpecMessage).toHaveBeenCalledWith("task-1", "hello agent"));
  });

  it("shows a diff between two spec revisions with a changed field", async () => {
    const revisionA = makeRevision({ id: "rev-a", version: 1, status: "superseded", content: validSpecContent });
    const revisionB = makeRevision({
      id: "rev-b",
      version: 2,
      status: "draft",
      content: { ...validSpecContent, objective: "A changed objective" },
    });
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(aggregateInProgress({ revisions: [revisionA, revisionB] })),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByTestId("spec-diff")).toBeTruthy());
    expect(screen.getByTestId("spec-diff").textContent).toContain("objective");
  });

  it("subscribes to the stream with a bare URL and no after param", async () => {
    const client = makeFakeClient({ getTask: vi.fn().mockResolvedValue(aggregateInProgress()) });
    renderSpecBuilder(client);

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(currentSource().url).toBe("/api/tasks/task-1/stream");
  });

  it("resets all task-scoped state on an in-app navigation from one task to another", async () => {
    const aggregateA = aggregateInProgress({
      task: { ...makeTaskAggregate().task, id: "task-a", jiraKey: "TSK-1", jiraSummary: "Task A summary" },
      revisions: [makeRevision({ id: "rev-a1", taskId: "task-a" })],
    });
    const aggregateB = aggregateInProgress({
      task: { ...makeTaskAggregate().task, id: "task-b", jiraKey: "TSK-2", jiraSummary: "Task B summary" },
      revisions: [makeRevision({ id: "rev-b1", taskId: "task-b" })],
    });
    const getTask = vi.fn((taskId: string) => Promise.resolve(taskId === "task-a" ? aggregateA : aggregateB));
    const client = makeFakeClient({ getTask });

    render(
      <MemoryRouter initialEntries={["/tasks/task-a/spec"]}>
        <Routes>
          <Route
            path="/tasks/:id/spec"
            element={
              <>
                <Link to="/tasks/task-b/spec">Go to B</Link>
                <SpecBuilderView client={client} createEventSource={factory} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("TSK-1: Task A summary")).toBeTruthy());
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(currentSource().url).toBe("/api/tasks/task-a/stream");
    const sourceA = currentSource();

    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "unsaved edit for A" } });
    expect(screen.getByTestId("unsaved-changes")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Go to B" }));
    });

    await waitFor(() => expect(screen.getByText("TSK-2: Task B summary")).toBeTruthy());
    expect(screen.queryByText("TSK-1: Task A summary")).toBeNull();
    expect(screen.queryByTestId("unsaved-changes")).toBeNull();

    expect(sourceA.closed).toBe(true);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    expect(currentSource().url).toBe("/api/tasks/task-b/stream");
  });

  it("renders chat and draft inside a two-pane split (AC1)", async () => {
    const client = makeFakeClient({ getTask: vi.fn().mockResolvedValue(aggregateInProgress()) });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByTestId("task-state")).toBeTruthy());

    const chatPane = screen.getByLabelText("Spec chat");
    const draftPane = screen.getByLabelText("Spec draft");
    expect(chatPane.className).toContain("split__pane");
    expect(draftPane.className).toContain("split__pane");
    expect(chatPane.parentElement).toBe(draftPane.parentElement);
    expect(chatPane.parentElement?.className).toContain("split");
  });

  it("renders an agent message's markdown formatted in the chat (AC2)", async () => {
    const client = makeFakeClient({ getTask: vi.fn().mockResolvedValue(aggregateInProgress()) });
    renderSpecBuilder(client);

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({
          id: 1,
          executionId: "exec-spec-1",
          type: "agent.message",
          payload: { text: "**bold** point" },
        }),
        "1",
      );
    });

    await waitFor(() => expect(screen.getByTestId("chat-message").querySelector("strong")).toBeTruthy());
    expect(screen.getByTestId("chat-message").querySelector("strong")?.textContent).toBe("bold");
  });

  it("shows the approved spec read-only when there is an approvedRevision and no draft, with its version (AC3)", async () => {
    const approved = makeRevision({ id: "rev-approved", version: 3, status: "approved", content: validSpecContent });
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(
        aggregateInProgress({
          task: { ...makeTaskAggregate().task, state: "SPEC_APPROVED" },
          revisions: [approved],
          approvedRevision: approved,
          approvals: [
            {
              id: "approval-1",
              revisionId: "rev-approved",
              approvedBy: "user-1",
              approvedAt: "2026-01-03T00:00:00.000Z",
              runtime: "claude",
            },
          ],
        }),
      ),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByTestId("approved-spec")).toBeTruthy());
    expect(screen.getByText("Approved specification, version 3")).toBeTruthy();
    expect(screen.getByText("Do the thing")).toBeTruthy();
    expect(screen.queryByLabelText("Objective")).toBeNull();
  });

  it("still shows the editable draft form when a draft revision exists, not the approved read-only view (AC3)", async () => {
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(aggregateInProgress({ revisions: [makeRevision({ content: validSpecContent })] })),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByLabelText("Objective")).toBeTruthy());
    expect(screen.queryByTestId("approved-spec")).toBeNull();
  });

  it("renders each revision as a compact row with version, status badge and Time, no raw ISO text (S1)", async () => {
    const revisionA = makeRevision({
      id: "rev-a",
      version: 1,
      status: "superseded",
      content: validSpecContent,
      createdAt: "2026-09-28T16:56:06.357Z",
    });
    const revisionB = makeRevision({
      id: "rev-b",
      version: 2,
      status: "draft",
      content: validSpecContent,
      createdAt: "2026-09-28T17:00:00.000Z",
    });
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(aggregateInProgress({ revisions: [revisionA, revisionB] })),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByTestId("revision-list")).toBeTruthy());
    const list = screen.getByTestId("revision-list");
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(list.querySelectorAll("time")).toHaveLength(2);
    expect(list.querySelectorAll(".badge")).toHaveLength(2);
    expect(list.textContent).not.toContain("2026-09-28T16:56:06.357Z");
    expect(list.textContent).not.toContain("2026-09-28T17:00:00.000Z");
    expect(list.textContent).toContain("v1");
    expect(list.textContent).toContain("v2");
  });

  it("keeps the compare/diff controls inside a closed <details> by default (S1)", async () => {
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(aggregateInProgress({ revisions: [makeRevision()] })),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByText("Compare revisions")).toBeTruthy());
    const details = screen.getByText("Compare revisions").closest("details");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(false);
    // The diff controls still exist in the dom (so they're ready once
    // opened) rather than only mounting on user interaction.
    expect(screen.getByLabelText("Compare from")).toBeTruthy();
  });

  it("labels the draft pane heading 'Specification' for the approved read-only view (S2)", async () => {
    const approved = makeRevision({ id: "rev-approved", version: 2, status: "approved", content: validSpecContent });
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(
        aggregateInProgress({
          task: { ...makeTaskAggregate().task, state: "SPEC_APPROVED" },
          revisions: [approved],
          approvedRevision: approved,
        }),
      ),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByTestId("approved-spec")).toBeTruthy());
    expect(screen.getByRole("heading", { level: 2, name: "Specification" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Draft" })).toBeNull();
  });

  it("keeps the draft pane heading 'Draft' when a draft revision is editable (S2)", async () => {
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(aggregateInProgress({ revisions: [makeRevision({ content: validSpecContent })] })),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByLabelText("Objective")).toBeTruthy());
    expect(screen.getByRole("heading", { level: 2, name: "Draft" })).toBeTruthy();
  });

  it("titles the Revise button with the task state reason when disabled (S3)", async () => {
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(aggregateInProgress({ task: { ...makeTaskAggregate().task, state: "DONE" } })),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("DONE"));
    const reviseButton = screen.getByRole("button", { name: "Revise" }) as HTMLButtonElement;
    expect(reviseButton.disabled).toBe(true);
    expect(reviseButton.title).toContain("Done");
  });

  it("titles the chat Send button with the disabled reason when the task is not in progress (S3)", async () => {
    const base = makeTaskAggregate();
    const client = makeFakeClient({
      getTask: vi.fn().mockResolvedValue(
        aggregateInProgress({
          task: { ...makeTaskAggregate().task, state: "SPEC_REVIEW" },
          latestExecutions: { spec: { ...base.executions[0]!, state: "RUNNING" }, implementation: null },
        }),
      ),
    });
    renderSpecBuilder(client);

    await waitFor(() => expect((screen.getByLabelText("Message") as HTMLInputElement).disabled).toBe(true));
    const sendButton = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(sendButton.title).toBe("The task is not in progress.");
  });
});
