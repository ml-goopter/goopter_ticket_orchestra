// @vitest-environment jsdom
import { EXECUTION_EVENT_TYPES } from "@orchestra/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetailApiClient } from "../api/client.js";
import { ApiError } from "../api/client.js";
import type { SpecificationRevision, TimelineEvent, TimelinePage } from "../api/types.js";
import type { EventSourceLike, MessageEventLike } from "../sse/useEventStream.js";
import { makeEveryEventTypeTimeline, makeTaskAggregate, makeTimelineEvent } from "../task/fixtures.js";
import { humanizeEnum } from "../ui/humanizeEnum.js";
import { TaskDetailView } from "./TaskDetailView.js";

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

function emptyPage(nextAfter = 0): TimelinePage {
  return { events: [], nextAfter };
}

interface MakeClientOptions {
  getTask?: TaskDetailApiClient["getTask"];
  getTimeline?: TaskDetailApiClient["getTimeline"];
  cancelTask?: TaskDetailApiClient["cancelTask"];
  retryTask?: TaskDetailApiClient["retryTask"];
  reopenTask?: TaskDetailApiClient["reopenTask"];
}

function makeClient(options: MakeClientOptions = {}): TaskDetailApiClient {
  return {
    request: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    health: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    listNotifications: vi.fn().mockResolvedValue([]),
    markNotificationRead: vi.fn(),
    getTask: options.getTask ?? vi.fn().mockResolvedValue(makeTaskAggregate()),
    getTimeline: options.getTimeline ?? vi.fn().mockResolvedValue(emptyPage()),
    cancelTask: options.cancelTask ?? vi.fn().mockResolvedValue({ from: "IMPLEMENTING", to: "CANCELLED" }),
    retryTask: options.retryTask ?? vi.fn().mockResolvedValue({ from: "NEEDS_HUMAN", to: "IMPLEMENTING" }),
    reopenTask: options.reopenTask ?? vi.fn().mockResolvedValue({ from: "CANCELLED", to: "NEEDS_SPEC" }),
  };
}

function makeRevision(overrides: Partial<SpecificationRevision>): SpecificationRevision {
  return {
    id: "rev-x",
    taskId: "task-x",
    version: 1,
    status: "approved",
    content: {
      repository: "tsk-repo",
      objective: "objective",
      scope: ["a"],
      out_of_scope: [],
      requirements: ["r1"],
      acceptance_criteria: ["ac1"],
      validation: ["v1"],
      constraints: [],
      dependencies: [],
    },
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderDetail(client: TaskDetailApiClient, taskId = "task-1") {
  return render(
    <MemoryRouter initialEntries={[`/tasks/${taskId}`]}>
      <Routes>
        <Route path="/tasks/:id" element={<TaskDetailView client={client} createEventSource={factory} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TaskDetailView", () => {
  it("shows a loading state before the aggregate resolves", () => {
    const client = makeClient({
      getTask: vi.fn(() => new Promise<never>(() => {})),
    });
    renderDetail(client);

    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("renders a visible 404 state when the task does not exist", async () => {
    const client = makeClient({
      getTask: vi.fn().mockRejectedValue(new ApiError(404, "NOT_FOUND", "Task not found.")),
    });
    renderDetail(client);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Task not found."));
  });

  it("renders a visible error state when the fetch fails", async () => {
    const client = makeClient({ getTask: vi.fn().mockRejectedValue(new Error("network down")) });
    renderDetail(client);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("network down"));
  });

  it("renders the seeded aggregate: revisions, both executions, the issue, the decision, review findings, and the PR (AC2)", async () => {
    const client = makeClient();
    renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("Implementing"));

    const revisionsSection = screen.getByRole("region", { name: "Specification revisions" });
    const revisionList = revisionsSection.querySelector(".task-detail__side-list") as HTMLElement;
    expect(within(revisionList).getByText("v1")).toBeTruthy();
    expect(within(revisionList).getByText("Superseded")).toBeTruthy();
    expect(within(revisionList).getByText("v2")).toBeTruthy();
    expect(within(revisionList).getByText("Approved")).toBeTruthy();

    const executionsSection = screen.getByRole("region", { name: "Executions" });
    expect(within(executionsSection).getByText(/spec attempt 1: COMPLETED/)).toBeTruthy();
    expect(within(executionsSection).getByText(/implementation attempt 1: RUNNING/)).toBeTruthy();
    expect(within(executionsSection).getByText(/warning: Missing null check\./)).toBeTruthy();

    const issuesSection = screen.getByRole("region", { name: "Issues" });
    expect(within(issuesSection).getByText(/Which pagination style\?/)).toBeTruthy();
    expect(within(issuesSection).getByRole("link", { name: "Open issue" }).getAttribute("href")).toBe(
      "/issues/issue-1",
    );

    const decisionsSection = screen.getByRole("region", { name: "Decisions" });
    expect(within(decisionsSection).getByText(/Use cursor pagination\./)).toBeTruthy();

    const prSection = screen.getByRole("region", { name: "Pull request" });
    expect(within(prSection).getByRole("link", { name: "#42" })).toBeTruthy();
  });

  it("appends a live SSE event to the timeline without a reload, and does not duplicate a redelivered event (AC3)", async () => {
    const getTimeline = vi.fn().mockResolvedValue(emptyPage());
    const client = makeClient({ getTimeline });
    renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("task-state")).toBeTruthy());
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const liveEvent: TimelineEvent = makeTimelineEvent({
      id: 501,
      type: "issue.created",
      payload: { issue_id: "issue-2", title: "New question raised" },
    });

    await act(async () => {
      currentSource().emit("issue.created", liveEvent, "501");
    });

    await waitFor(() => expect(screen.getAllByText(/New question raised/)).toHaveLength(1));

    // Redelivered (e.g. after a reconnect catch-up overlaps it): still one item.
    await act(async () => {
      currentSource().emit("issue.created", liveEvent, "501");
    });

    expect(screen.getAllByText(/New question raised/)).toHaveLength(1);
  });

  it("collapses agent.message.delta rows into one item, replaced by the final agent.message text (AC4)", async () => {
    const client = makeClient({ getTimeline: vi.fn().mockResolvedValue(emptyPage()) });
    renderDetail(client);

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    await act(async () => {
      currentSource().emit(
        "agent.message.delta",
        makeTimelineEvent({ id: 601, executionId: "exec-impl-1", type: "agent.message.delta", payload: { text: "Hel" } }),
        "601",
      );
    });
    await act(async () => {
      currentSource().emit(
        "agent.message.delta",
        makeTimelineEvent({ id: 602, executionId: "exec-impl-1", type: "agent.message.delta", payload: { text: "lo" } }),
        "602",
      );
    });

    await waitFor(() => expect(screen.getByText("Hello")).toBeTruthy());
    expect(screen.getByTestId("message-in-progress")).toBeTruthy();

    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({ id: 603, executionId: "exec-impl-1", type: "agent.message", payload: { text: "Hello!" } }),
        "603",
      );
    });

    await waitFor(() => expect(screen.getByText("Hello!")).toBeTruthy());
    expect(screen.queryByTestId("message-in-progress")).toBeNull();
  });

  it("hides items outside the selected filter families (AC5)", async () => {
    const client = makeClient({ getTimeline: vi.fn().mockResolvedValue(emptyPage()) });
    renderDetail(client);

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    await act(async () => {
      currentSource().emit("issue.created", makeTimelineEvent({ id: 701, type: "issue.created", payload: {} }), "701");
    });
    await act(async () => {
      currentSource().emit(
        "pull_request.created",
        makeTimelineEvent({ id: 702, type: "pull_request.created", payload: {} }),
        "702",
      );
    });

    await waitFor(() => expect(within(screen.getByTestId("timeline")).getAllByTestId("timeline-item").length).toBeGreaterThanOrEqual(2));

    // Uncheck every family except "Issues".
    for (const label of ["State", "Agent", "Review", "PR & CI"]) {
      await act(async () => {
        fireEvent.click(screen.getByRole("checkbox", { name: label }));
      });
    }

    await waitFor(() => {
      const items = within(screen.getByTestId("timeline")).getAllByTestId("timeline-item");
      expect(items).toHaveLength(1);
      expect(items[0]!.getAttribute("data-type")).toBe("issue.created");
    });
  });

  it("cancels with confirmation, retry is gated on NEEDS_HUMAN, and a failed action shows visible text (AC6)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const cancelTask = vi.fn().mockRejectedValue(new Error("cannot cancel"));
    const client = makeClient({ cancelTask });
    renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("task-state")).toBeTruthy());

    // Seeded task is IMPLEMENTING, not NEEDS_HUMAN: retry stays disabled.
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("cannot cancel"));
    confirmSpy.mockRestore();
  });

  it("enables retry once the task is NEEDS_HUMAN and calls retryTask", async () => {
    const retryTask = vi.fn().mockResolvedValue({ from: "NEEDS_HUMAN", to: "IMPLEMENTING" });
    const aggregate = makeTaskAggregate({ task: { ...makeTaskAggregate().task, state: "NEEDS_HUMAN" } });
    const client = makeClient({ getTask: vi.fn().mockResolvedValue(aggregate), retryTask });
    renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("Needs human"));
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    await waitFor(() => expect(retryTask).toHaveBeenCalledWith("task-1"));
  });

  it("shows Reopen only for CANCELLED and calls reopenTask (GOT.55)", async () => {
    const reopenTask = vi.fn().mockResolvedValue({ from: "CANCELLED", to: "SPEC_APPROVED" });
    const aggregate = makeTaskAggregate({ task: { ...makeTaskAggregate().task, state: "CANCELLED" } });
    const client = makeClient({ getTask: vi.fn().mockResolvedValue(aggregate), reopenTask });
    renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("Cancelled"));
    expect((screen.getByRole("button", { name: "Reopen" }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    });

    await waitFor(() => expect(reopenTask).toHaveBeenCalledWith("task-1"));
  });

  it("disables Reopen for a non-CANCELLED task", async () => {
    const client = makeClient();
    renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("task-state")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Reopen" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a diff between two spec revisions with a changed field (AC7)", async () => {
    const client = makeClient();
    renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("spec-diff")).toBeTruthy());
    expect(screen.getByTestId("spec-diff").textContent).toContain("objective");
  });

  it("refetches the aggregate and catches up the timeline from the last id on reconnect (AC8)", async () => {
    const getTask = vi.fn().mockResolvedValue(makeTaskAggregate());
    const getTimeline = vi.fn().mockResolvedValue(emptyPage());
    const client = makeClient({ getTask, getTimeline });
    renderDetail(client);

    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(1));
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
    expect(getTimeline.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 10000);

  it("reconnects with exactly one after param once a live event has been seen, and comes back open with a catch-up fetch (F1)", async () => {
    const getTask = vi.fn().mockResolvedValue(makeTaskAggregate());
    const getTimeline = vi.fn().mockResolvedValue(emptyPage());
    const client = makeClient({ getTask, getTimeline });
    renderDetail(client);

    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(currentSource().url).toBe("/api/tasks/task-1/stream");

    await act(async () => {
      currentSource().onopen?.();
    });

    const liveEvent = makeTimelineEvent({ id: 999, type: "issue.created", payload: { issueId: "i-live" } });
    await act(async () => {
      currentSource().emit("issue.created", liveEvent, "999");
    });

    await act(async () => {
      currentSource().onerror?.(new Event("error"));
    });

    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(1), { timeout: 3000 });

    const reconnectUrl = currentSource().url;
    const afterParams = [...new URL(reconnectUrl, "http://localhost").searchParams.entries()].filter(
      ([key]) => key === "after",
    );
    expect(afterParams).toHaveLength(1);
    expect(afterParams[0]![1]).toBe("999");

    await act(async () => {
      currentSource().onopen?.();
    });

    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    expect(getTimeline.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 10000);

  it("keeps a live event delivered before the first timeline page lands, merged once and in id order (F1)", async () => {
    let resolveTimeline!: (page: TimelinePage) => void;
    const timelinePromise = new Promise<TimelinePage>((resolve) => {
      resolveTimeline = resolve;
    });
    const getTimeline = vi.fn().mockReturnValue(timelinePromise);
    const client = makeClient({ getTimeline });
    renderDetail(client);

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const liveEvent = makeTimelineEvent({
      id: 50,
      type: "issue.created",
      payload: { issue_id: "issue-live", title: "i-live" },
    });
    await act(async () => {
      currentSource().emit("issue.created", liveEvent, "50");
    });

    await waitFor(() => expect(screen.queryByText(/i-live/)).toBeTruthy());

    const backlogEvent = makeTimelineEvent({
      id: 10,
      type: "issue.created",
      payload: { issue_id: "issue-backlog", title: "i-backlog" },
    });
    await act(async () => {
      resolveTimeline({ events: [backlogEvent], nextAfter: 10 });
    });

    await waitFor(() => {
      const items = within(screen.getByTestId("timeline")).getAllByTestId("timeline-item");
      expect(items).toHaveLength(2);
    });

    const items = within(screen.getByTestId("timeline")).getAllByTestId("timeline-item");
    expect(items[0]!.textContent).toContain("i-backlog");
    expect(items[1]!.textContent).toContain("i-live");
  });

  it("resets all task-scoped state on an in-app navigation from one task to another (GOT.41-fix2, F1/F2)", async () => {
    const aggregateA = makeTaskAggregate({
      task: { ...makeTaskAggregate().task, id: "task-a", jiraKey: "TSK-1", jiraSummary: "Task A summary" },
      revisions: [
        makeRevision({ id: "rev-a1", taskId: "task-a", version: 1 }),
        makeRevision({ id: "rev-a2", taskId: "task-a", version: 2 }),
      ],
    });
    const aggregateB = makeTaskAggregate({
      task: { ...makeTaskAggregate().task, id: "task-b", jiraKey: "TSK-2", jiraSummary: "Task B summary" },
      revisions: [
        makeRevision({ id: "rev-b1", taskId: "task-b", version: 5 }),
        makeRevision({ id: "rev-b2", taskId: "task-b", version: 6 }),
      ],
    });

    const getTask = vi.fn((taskId: string) => Promise.resolve(taskId === "task-a" ? aggregateA : aggregateB));
    const getTimeline = vi.fn().mockResolvedValue(emptyPage());
    const client = makeClient({ getTask, getTimeline });

    render(
      <MemoryRouter initialEntries={["/tasks/task-a"]}>
        <Routes>
          <Route
            path="/tasks/:id"
            element={
              <>
                <Link to="/tasks/task-b">Go to B</Link>
                <TaskDetailView client={client} createEventSource={factory} />
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

    const liveEventA = makeTimelineEvent({
      id: 900,
      taskId: "task-a",
      type: "issue.created",
      payload: { issue_id: "issue-only-a", title: "only-in-a" },
    });
    await act(async () => {
      sourceA.emit("issue.created", liveEventA, "900");
    });
    await waitFor(() => expect(screen.getByText(/only-in-a/)).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Go to B" }));
    });

    await waitFor(() => expect(screen.getByText("TSK-2: Task B summary")).toBeTruthy());
    expect(screen.queryByText("TSK-1: Task A summary")).toBeNull();
    expect(screen.queryByText(/only-in-a/)).toBeNull();

    expect(sourceA.closed).toBe(true);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    expect(currentSource().url).toBe("/api/tasks/task-b/stream");

    const compareFrom = screen.getByLabelText("Compare from") as HTMLSelectElement;
    const optionLabels = Array.from(compareFrom.options).map((option) => option.textContent);
    expect(optionLabels).toEqual(["v5", "v6"]);
  });

  it("never renders a raw JSON payload outside a collapsed <details> block, across every EXECUTION_EVENT_TYPES value (AC1)", async () => {
    const events = makeEveryEventTypeTimeline(EXECUTION_EVENT_TYPES);
    const client = makeClient({
      getTimeline: vi.fn().mockResolvedValue({ events, nextAfter: events.length }),
    });
    renderDetail(client);

    await waitFor(() =>
      expect(within(screen.getByTestId("timeline")).getAllByTestId("timeline-item")).toHaveLength(events.length),
    );

    const items = within(screen.getByTestId("timeline")).getAllByTestId("timeline-item");
    for (const item of items) {
      const clone = item.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("details").forEach((details) => details.remove());
      expect(clone.textContent).not.toMatch(/[{}]/);
    }
  });

  it("shows a tool call's name read from payload.tool when payload.name is absent (AC2)", async () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        executionId: "exec-impl-1",
        type: "agent.tool_call",
        payload: { tool: "propose_spec", input: { version: 1 } },
      }),
    ];
    const client = makeClient({ getTimeline: vi.fn().mockResolvedValue({ events, nextAfter: 1 }) });
    renderDetail(client);

    await waitFor(() => expect(screen.getByText("propose_spec")).toBeTruthy());
  });

  it("renders agent.message markdown as real list and code elements, not raw text (AC3)", async () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        executionId: "exec-impl-1",
        type: "agent.message",
        payload: { text: "- one\n- two\n\nUse `formatUsd()` here." },
      }),
    ];
    const client = makeClient({ getTimeline: vi.fn().mockResolvedValue({ events, nextAfter: 1 }) });
    renderDetail(client);

    await waitFor(() => expect(screen.getByText("one")).toBeTruthy());
    expect(screen.getByText("one").closest("li")).toBeTruthy();
    expect(screen.getByText("formatUsd()").tagName).toBe("CODE");
  });

  it("disables Cancel for DONE and CANCELLED, and enables it for IMPLEMENTING (AC4)", async () => {
    for (const state of ["DONE", "CANCELLED"] as const) {
      const aggregate = makeTaskAggregate({ task: { ...makeTaskAggregate().task, state } });
      const client = makeClient({ getTask: vi.fn().mockResolvedValue(aggregate) });
      const { unmount } = renderDetail(client);

      await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe(humanizeEnum(state)));
      expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
      unmount();
    }

    const client = makeClient();
    renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("Implementing"));
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("titles the Cancel button with the disabled reason when disabled and no title when enabled (GOT.66)", async () => {
    const aggregate = makeTaskAggregate({ task: { ...makeTaskAggregate().task, state: "DONE" } });
    const client = makeClient({ getTask: vi.fn().mockResolvedValue(aggregate) });
    const { unmount } = renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("Done"));
    const cancelButton = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancelButton.disabled).toBe(true);
    expect(cancelButton.title).toContain("Cannot cancel a task");
    unmount();

    const enabledClient = makeClient();
    renderDetail(enabledClient);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("Implementing"));
    const enabledCancelButton = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(enabledCancelButton.disabled).toBe(false);
    expect(enabledCancelButton.title).toBe("");
  });

  it("titles the Retry button with the disabled reason when disabled and no title when enabled (GOT.66)", async () => {
    const aggregate = makeTaskAggregate({ task: { ...makeTaskAggregate().task, state: "IMPLEMENTING" } });
    const client = makeClient({ getTask: vi.fn().mockResolvedValue(aggregate) });
    const { unmount } = renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("Implementing"));
    const retryButton = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retryButton.disabled).toBe(true);
    expect(retryButton.title).toBe("Retry is only available while the task needs human input.");
    unmount();

    const enabledAggregate = makeTaskAggregate({ task: { ...makeTaskAggregate().task, state: "NEEDS_HUMAN" } });
    const enabledClient = makeClient({ getTask: vi.fn().mockResolvedValue(enabledAggregate) });
    renderDetail(enabledClient);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("Needs human"));
    const enabledRetryButton = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(enabledRetryButton.disabled).toBe(false);
    expect(enabledRetryButton.title).toBe("");
  });

  it("titles the Reopen button with the disabled reason when disabled and no title when enabled (GOT.66)", async () => {
    const aggregate = makeTaskAggregate({ task: { ...makeTaskAggregate().task, state: "IMPLEMENTING" } });
    const client = makeClient({ getTask: vi.fn().mockResolvedValue(aggregate) });
    const { unmount } = renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("Implementing"));
    const reopenButton = screen.getByRole("button", { name: "Reopen" }) as HTMLButtonElement;
    expect(reopenButton.disabled).toBe(true);
    expect(reopenButton.title).toContain("Cannot reopen a task");
    unmount();

    const enabledAggregate = makeTaskAggregate({ task: { ...makeTaskAggregate().task, state: "CANCELLED" } });
    const enabledClient = makeClient({ getTask: vi.fn().mockResolvedValue(enabledAggregate) });
    renderDetail(enabledClient);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("Cancelled"));
    const enabledReopenButton = screen.getByRole("button", { name: "Reopen" }) as HTMLButtonElement;
    expect(enabledReopenButton.disabled).toBe(false);
    expect(enabledReopenButton.title).toBe("");
  });

  it("shows the task state exactly once in the header, via the StateBadge only (T3)", async () => {
    const client = makeClient();
    renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("Implementing"));

    // The raw uppercase enum value ("IMPLEMENTING") must not appear anywhere
    // else in the header alongside the badge's humanized label.
    expect(screen.queryByText("IMPLEMENTING")).toBeNull();
    expect(within(screen.getByTestId("task-state")).getAllByText("Implementing")).toHaveLength(1);
  });

  it("renders the filter toggle checkboxes with accessible names, each queryable by role and label (T2)", async () => {
    const client = makeClient({ getTimeline: vi.fn().mockResolvedValue(emptyPage()) });
    renderDetail(client);

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    for (const name of ["All", "State", "Agent", "Issues", "Review", "PR & CI"]) {
      expect(screen.getByRole("checkbox", { name })).toBeTruthy();
    }
  });

  it("keeps the compare-revisions diff inside a closed-by-default <details> element (T4)", async () => {
    const client = makeClient();
    renderDetail(client);

    await waitFor(() => expect(screen.getByTestId("spec-diff")).toBeTruthy());

    const summary = screen.getByText("Compare revisions");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.contains(screen.getByTestId("spec-diff"))).toBe(true);

    await act(async () => {
      fireEvent.click(summary);
    });

    expect(details.open).toBe(true);
  });

  it("renders a collapsed agent.tool_call summary as an inline disclosure, not a bordered container (T6)", async () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        executionId: "exec-impl-1",
        type: "agent.tool_call",
        payload: { tool: "propose_spec", input: { version: 1 } },
      }),
    ];
    const client = makeClient({ getTimeline: vi.fn().mockResolvedValue({ events, nextAfter: 1 }) });
    renderDetail(client);

    await waitFor(() => expect(screen.getByText("propose_spec")).toBeTruthy());
    const details = screen.getByText("propose_spec").closest("details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.className).toBe("timeline-item__disclosure");
    expect(details.className).not.toMatch(/\bcard\b/);
  });

  it("shows a short one-word type label, with the full event type in its title (T7)", async () => {
    const events = makeEveryEventTypeTimeline(["execution.assigned", "task.state_changed", "worktree.prepared"]);
    const client = makeClient({ getTimeline: vi.fn().mockResolvedValue({ events, nextAfter: events.length }) });
    renderDetail(client);

    await waitFor(() =>
      expect(within(screen.getByTestId("timeline")).getAllByTestId("timeline-item")).toHaveLength(3),
    );
    const timeline = screen.getByTestId("timeline");

    const executionLabel = within(timeline).getByText("Execution");
    expect(executionLabel.getAttribute("title")).toBe("Execution assigned");

    const stateLabel = within(timeline).getByText("State");
    expect(stateLabel.getAttribute("title")).toBe("Task state changed");

    const worktreeLabel = within(timeline).getByText("Worktree");
    expect(worktreeLabel.getAttribute("title")).toBe("Worktree prepared");
  });

  it("shows 'Approved' with the approver's id only in the row's title, plus the approved revision's version (T8)", async () => {
    const client = makeClient();
    renderDetail(client);

    await waitFor(() => expect(screen.getByRole("region", { name: "Approvals" })).toBeTruthy());
    const approvalsSection = screen.getByRole("region", { name: "Approvals" });
    await waitFor(() => expect(within(approvalsSection).getByText(/approved/i)).toBeTruthy());

    expect(screen.queryByText("user-1")).toBeNull();
    const row = within(approvalsSection).getByText(/approved/i).closest("li") as HTMLLIElement;
    expect(row.getAttribute("title")).toBe("user-1");
  });
});
