// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueApiClient } from "../api/client.js";
import { ApiError } from "../api/client.js";
import type { IssueDetail } from "../api/types.js";
import type { EventSourceLike, MessageEventLike } from "../sse/useEventStream.js";
import { makeFakeClient, makeIssueDetail } from "../task/fixtures.js";
import { IssueDetailView } from "./IssueDetailView.js";

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

function renderIssue(client: IssueApiClient, issueId = "issue-2") {
  return render(
    <MemoryRouter initialEntries={[`/issues/${issueId}`]}>
      <Routes>
        <Route path="/issues/:id" element={<IssueDetailView client={client} createEventSource={factory} />} />
        <Route path="/tasks/:id/spec" element={<p>Spec builder for task-1</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function timelineEvent(overrides: Record<string, unknown>) {
  return {
    id: 1,
    taskId: "task-1",
    executionId: "exec-impl-1",
    type: "agent.message.delta",
    payload: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("IssueDetailView", () => {
  it("shows a loading state before the issue resolves", () => {
    const client = makeFakeClient({ getIssue: vi.fn(() => new Promise<never>(() => {})) });
    renderIssue(client);

    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("renders a visible 404 state when the issue does not exist", async () => {
    const client = makeFakeClient({
      getIssue: vi.fn().mockRejectedValue(new ApiError(404, "NOT_FOUND", "Issue not found.")),
    });
    renderIssue(client);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Issue not found."));
  });

  it("renders a visible error state when the fetch fails", async () => {
    const client = makeFakeClient({ getIssue: vi.fn().mockRejectedValue(new Error("network down")) });
    renderIssue(client);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("network down"));
  });

  it("renders a seeded blocking issue: question, options with recommendation preselected, thread, context links (AC2)", async () => {
    const client = makeFakeClient();
    renderIssue(client);

    await waitFor(() => expect(screen.getByTestId("issue-status").textContent).toBe("OPEN"));

    expect(screen.getByTestId("issue-question").textContent).toBe("Cursor or offset pagination?");
    // The recommended option is preselected by an effect that fires a
    // render after the issue itself resolves, so wait for the checked
    // state directly rather than assuming it landed in the same commit as
    // "OPEN" above.
    await waitFor(() => {
      const radios = screen.getAllByRole("radio") as HTMLInputElement[];
      const cursorRadio = radios.find((radio) => radio.value === "cursor")!;
      expect(cursorRadio.checked).toBe(true);
    });
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    const offsetRadio = radios.find((radio) => radio.value === "offset")!;
    expect(offsetRadio.checked).toBe(false);

    expect(screen.getByTestId("thread-message").textContent).toContain("Any preference on pagination?");

    expect(screen.getByRole("link", { name: "TSK-70" }).getAttribute("href")).toBe("/tasks/task-1");
    expect(screen.getByRole("link", { name: "Spec revision" }).getAttribute("href")).toBe("/tasks/task-1/spec");
    expect(screen.getByText(/implementation - WAITING_FOR_USER \(claude\)/)).toBeTruthy();
  });

  it("posts a message and refetches the thread (AC3)", async () => {
    const postIssueMessage = vi.fn().mockResolvedValue({ messageId: "m2", commandId: "c2", executionId: "exec-impl-1" });
    const refetched: IssueDetail = makeIssueDetail({
      messages: [
        ...makeIssueDetail().messages,
        { id: "m2", issueId: "issue-2", authorKind: "user", userId: "user-1", body: "cursor please", createdAt: "2026-01-01T02:07:00.000Z" },
      ],
    });
    const getIssue = vi.fn().mockResolvedValueOnce(makeIssueDetail()).mockResolvedValueOnce(refetched);
    const client = makeFakeClient({ getIssue, postIssueMessage });
    renderIssue(client);

    await waitFor(() => expect(screen.getByTestId("issue-status")).toBeTruthy());

    fireEvent.change(screen.getByTestId("composer-text"), { target: { value: "cursor please" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(postIssueMessage).toHaveBeenCalledWith("issue-2", "cursor please"));
    await waitFor(() => expect(getIssue).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByTestId("thread-message")).toHaveLength(2));
  });

  it("shows the mapped text for a 409 EXECUTION_NOT_WAITING (AC3)", async () => {
    const postIssueMessage = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "EXECUTION_NOT_WAITING", "The issue's execution is RUNNING, not WAITING_FOR_USER."));
    const client = makeFakeClient({ postIssueMessage });
    renderIssue(client);

    await waitFor(() => expect(screen.getByTestId("issue-status")).toBeTruthy());
    fireEvent.change(screen.getByTestId("composer-text"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("the agent is busy; the message can be sent when it pauses"),
    );
  });

  it("disables the composer with the api's reason when the issue is not OPEN (AC3)", async () => {
    const client = makeFakeClient({
      getIssue: vi.fn().mockResolvedValue(makeIssueDetail({ issue: { ...makeIssueDetail().issue, status: "RESOLVED" } })),
    });
    renderIssue(client);

    await waitFor(() => expect(screen.getByTestId("issue-status").textContent).toBe("RESOLVED"));
    expect((screen.getByTestId("composer-text") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText("Issue is RESOLVED, not OPEN.")).toBeTruthy();
  });

  it("resolves as clarification with the decision, clarification and chosen option, then refetches into the read-only state (AC4)", async () => {
    const resolveIssue = vi.fn().mockResolvedValue({
      issueId: "issue-2",
      decisionId: "decision-x",
      kind: "clarification",
      commandId: "cmd-1",
      task: null,
      revisionId: null,
    });
    const resolved: IssueDetail = makeIssueDetail({
      issue: { ...makeIssueDetail().issue, status: "RESOLVED", resolutionKind: "clarification", resolvedAt: "2026-01-02T00:00:00.000Z" },
      decision: {
        id: "decision-x",
        taskId: "task-1",
        issueId: "issue-2",
        decision: "Use cursor pagination",
        clarification: "simpler to page through",
        chosenOption: "cursor",
        decidedBy: "user-1",
        decidedAt: "2026-01-02T00:00:00.000Z",
      },
    });
    const getIssue = vi.fn().mockResolvedValueOnce(makeIssueDetail()).mockResolvedValueOnce(resolved);
    const client = makeFakeClient({ getIssue, resolveIssue });
    renderIssue(client);

    await waitFor(() => expect(screen.getByTestId("issue-status").textContent).toBe("OPEN"));

    fireEvent.change(screen.getByTestId("decision-text"), { target: { value: "Use cursor pagination" } });
    fireEvent.change(screen.getByTestId("clarification-text"), { target: { value: "simpler to page through" } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve as clarification" }));

    await waitFor(() =>
      expect(resolveIssue).toHaveBeenCalledWith("issue-2", {
        kind: "clarification",
        decision: "Use cursor pagination",
        clarification: "simpler to page through",
        chosenOption: "cursor",
      }),
    );

    await waitFor(() => expect(screen.getByTestId("issue-status").textContent).toBe("RESOLVED"));
    expect(screen.getByTestId("resolution-decision").textContent).toBe("Use cursor pagination");
    expect(screen.getByTestId("resolution-kind").textContent).toBe("clarification");
  });

  it("both resolve buttons are disabled until the decision text is non-empty", async () => {
    const client = makeFakeClient();
    renderIssue(client);

    await waitFor(() => expect(screen.getByTestId("issue-status")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Resolve as clarification" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "This changes the spec" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("decision-text"), { target: { value: "x" } });
    expect((screen.getByRole("button", { name: "Resolve as clarification" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "This changes the spec" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the confirm before a spec_revision resolve, sends kind spec_revision, and navigates to the spec builder (AC5)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const resolveIssue = vi.fn().mockResolvedValue({
      issueId: "issue-2",
      decisionId: "decision-x",
      kind: "spec_revision",
      commandId: null,
      task: { from: "IMPLEMENTING", to: "SPEC_IN_PROGRESS" },
      revisionId: "rev-3",
    });
    const client = makeFakeClient({ resolveIssue });
    renderIssue(client);

    await waitFor(() => expect(screen.getByTestId("issue-status")).toBeTruthy());
    fireEvent.change(screen.getByTestId("decision-text"), { target: { value: "Change the approach" } });
    fireEvent.click(screen.getByRole("button", { name: "This changes the spec" }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(resolveIssue).toHaveBeenCalledWith(
        "issue-2",
        expect.objectContaining({ kind: "spec_revision", decision: "Change the approach" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Spec builder for task-1")).toBeTruthy());
    confirmSpy.mockRestore();
  });

  it("does not resolve as spec_revision when the confirm is dismissed", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const resolveIssue = vi.fn();
    const client = makeFakeClient({ resolveIssue });
    renderIssue(client);

    await waitFor(() => expect(screen.getByTestId("issue-status")).toBeTruthy());
    fireEvent.change(screen.getByTestId("decision-text"), { target: { value: "Change the approach" } });
    fireEvent.click(screen.getByRole("button", { name: "This changes the spec" }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(resolveIssue).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("a non-blocking OPEN issue shows only the clarification action with the note (AC6)", async () => {
    const client = makeFakeClient({
      getIssue: vi.fn().mockResolvedValue(makeIssueDetail({ issue: { ...makeIssueDetail().issue, blocking: false } })),
    });
    renderIssue(client);

    await waitFor(() => expect(screen.getByTestId("issue-status")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Resolve as clarification" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "This changes the spec" })).toBeNull();
    expect(screen.getByText("The agent is not paused and will not be resumed.")).toBeTruthy();
  });

  it("a resolved issue is read-only: no composer form controls for resolving, decision and kind shown", async () => {
    const client = makeFakeClient({
      getIssue: vi.fn().mockResolvedValue(
        makeIssueDetail({
          issue: { ...makeIssueDetail().issue, status: "RESOLVED", resolutionKind: "clarification", resolvedAt: "2026-01-02T00:00:00.000Z" },
          decision: {
            id: "decision-x",
            taskId: "task-1",
            issueId: "issue-2",
            decision: "Use cursor pagination",
            clarification: null,
            chosenOption: "cursor",
            decidedBy: "user-1",
            decidedAt: "2026-01-02T00:00:00.000Z",
          },
        }),
      ),
    });
    renderIssue(client);

    await waitFor(() => expect(screen.getByTestId("issue-status").textContent).toBe("RESOLVED"));
    expect(screen.getByTestId("resolution-decision").textContent).toBe("Use cursor pagination");
    expect(screen.getByTestId("resolution-kind").textContent).toBe("clarification");
    expect(screen.getByTestId("resolution-time").textContent).toBe("2026-01-02T00:00:00.000Z");
    expect(screen.queryByRole("button", { name: "Resolve as clarification" })).toBeNull();
    expect(screen.queryByTestId("decision-text")).toBeNull();
  });

  it("live: deltas for the issue's execution render as one in-progress bubble replaced by agent.message, a delta for another execution is ignored, issue.message refetches, and the stream URL has no after= (AC7)", async () => {
    const getIssue = vi.fn().mockResolvedValue(makeIssueDetail());
    const client = makeFakeClient({ getIssue });
    renderIssue(client);

    await waitFor(() => expect(screen.getByTestId("issue-status")).toBeTruthy());
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(currentSource().url).toBe("/api/tasks/task-1/stream");

    act(() => {
      currentSource().emit(
        "agent.message.delta",
        timelineEvent({ id: 10, type: "agent.message.delta", payload: { text: "Cursor " } }),
      );
    });
    await waitFor(() => expect(screen.getByTestId("thread-live-reply").textContent).toContain("Cursor"));
    expect(screen.getByTestId("thread-live-reply").getAttribute("data-final")).toBe("false");

    act(() => {
      currentSource().emit(
        "agent.message.delta",
        timelineEvent({ id: 11, type: "agent.message.delta", payload: { text: "pagination is fine." }, executionId: "some-other-exec" }),
      );
    });
    expect(screen.getByTestId("thread-live-reply").textContent).toContain("Cursor");
    expect(screen.getByTestId("thread-live-reply").textContent).not.toContain("pagination is fine.");

    act(() => {
      currentSource().emit(
        "agent.message",
        timelineEvent({ id: 12, type: "agent.message", payload: { text: "Cursor pagination it is." } }),
      );
    });
    await waitFor(() => expect(screen.getByTestId("thread-live-reply").textContent).toContain("Cursor pagination it is."));
    expect(screen.getByTestId("thread-live-reply").getAttribute("data-final")).toBe("true");

    getIssue.mockClear();
    act(() => {
      currentSource().emit("issue.message", timelineEvent({ id: 13, type: "issue.message", payload: {} }));
    });
    await waitFor(() => expect(getIssue).toHaveBeenCalledTimes(1));
  });

  it("resets state on an in-app navigation from one issue to another (AC8)", async () => {
    const detailA = makeIssueDetail({ issue: { ...makeIssueDetail().issue, id: "issue-a", title: "Issue A" } });
    const detailB = makeIssueDetail({ issue: { ...makeIssueDetail().issue, id: "issue-b", title: "Issue B" } });
    const getIssue = vi.fn((id: string) => Promise.resolve(id === "issue-a" ? detailA : detailB));
    const client = makeFakeClient({ getIssue: getIssue as unknown as IssueApiClient["getIssue"] });

    render(
      <MemoryRouter initialEntries={["/issues/issue-a"]}>
        <Routes>
          <Route
            path="/issues/:id"
            element={
              <>
                <Link to="/issues/issue-b">Go to B</Link>
                <IssueDetailView client={client} createEventSource={factory} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("Issue A")).toBeTruthy());
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    fireEvent.change(screen.getByTestId("decision-text"), { target: { value: "some draft decision" } });
    expect((screen.getByTestId("decision-text") as HTMLTextAreaElement).value).toBe("some draft decision");
    const sourceA = currentSource();

    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Go to B" }));
    });

    await waitFor(() => expect(screen.getByText("Issue B")).toBeTruthy());
    expect(screen.queryByText("Issue A")).toBeNull();
    expect((screen.getByTestId("decision-text") as HTMLTextAreaElement).value).toBe("");
    expect(sourceA.closed).toBe(true);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
  });
});
