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

  it("calls startSpecSession from the NEEDS_SPEC state and refetches", async () => {
    const startSpecSession = vi.fn().mockResolvedValue({ from: "NEEDS_SPEC", to: "SPEC_IN_PROGRESS" });
    const getTask = vi
      .fn()
      .mockResolvedValue(aggregateInProgress({ task: { ...makeTaskAggregate().task, state: "NEEDS_SPEC" } }));
    const client = makeFakeClient({ getTask, startSpecSession });
    renderSpecBuilder(client);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start spec session" })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start spec session" }));
    });

    await waitFor(() => expect(startSpecSession).toHaveBeenCalledWith("task-1"));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
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
});
