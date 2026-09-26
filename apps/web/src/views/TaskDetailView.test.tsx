// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardApiClient } from "../api/client.js";
import { ApiError } from "../api/client.js";
import type { TimelineEvent, TimelinePage } from "../api/types.js";
import type { EventSourceLike, MessageEventLike } from "../sse/useEventStream.js";
import { makeTaskAggregate, makeTimelineEvent } from "../task/fixtures.js";
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
  getTask?: BoardApiClient["getTask"];
  getTimeline?: BoardApiClient["getTimeline"];
  cancelTask?: BoardApiClient["cancelTask"];
  retryTask?: BoardApiClient["retryTask"];
}

function makeClient(options: MakeClientOptions = {}): BoardApiClient {
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
  };
}

function renderDetail(client: BoardApiClient, taskId = "task-1") {
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

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("IMPLEMENTING"));

    expect(screen.getByText("v1 - superseded")).toBeTruthy();
    expect(screen.getByText("v2 - approved")).toBeTruthy();

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
      payload: { issueId: "i2" },
    });

    await act(async () => {
      currentSource().emit("issue.created", liveEvent, "501");
    });

    await waitFor(() => expect(screen.getAllByText(/issue\.created:/)).toHaveLength(1));

    // Redelivered (e.g. after a reconnect catch-up overlaps it): still one item.
    await act(async () => {
      currentSource().emit("issue.created", liveEvent, "501");
    });

    expect(screen.getAllByText(/issue\.created:/)).toHaveLength(1);
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

    await waitFor(() => expect(screen.getByText(/Hello \.\.\./)).toBeTruthy());

    await act(async () => {
      currentSource().emit(
        "agent.message",
        makeTimelineEvent({ id: 603, executionId: "exec-impl-1", type: "agent.message", payload: { text: "Hello!" } }),
        "603",
      );
    });

    await waitFor(() => expect(screen.getByText("Hello!")).toBeTruthy());
    expect(screen.queryByText(/Hello \.\.\./)).toBeNull();
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

    await waitFor(() => expect(screen.getByTestId("task-state").textContent).toBe("NEEDS_HUMAN"));
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    await waitFor(() => expect(retryTask).toHaveBeenCalledWith("task-1"));
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
});
