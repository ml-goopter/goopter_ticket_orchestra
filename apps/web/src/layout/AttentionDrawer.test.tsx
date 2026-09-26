// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardApiClient } from "../api/client.js";
import type { Issue, Notification, TaskCard } from "../api/types.js";
import type { EventSourceLike, MessageEventLike } from "../sse/useEventStream.js";
import { makeFakeClient } from "../task/fixtures.js";
import { AttentionDrawer } from "./AttentionDrawer.js";

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

afterEach(cleanup);
beforeEach(() => {
  FakeEventSource.instances = [];
});

function makeTask(overrides: Partial<TaskCard>): TaskCard {
  return {
    id: "t1",
    jiraKey: "AAA-1",
    jiraSummary: "Summary",
    state: "NEEDS_HUMAN",
    column: "Needs Human",
    runtime: null,
    projectId: "p1",
    repositoryId: "r1",
    jiraPriority: 1,
    jiraCreatedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    hasWaitingExecution: false,
    cost: 0,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue>): Issue {
  return {
    id: "i1",
    taskId: "t1",
    executionId: "e1",
    type: "BLOCKER",
    severity: "blocking",
    blocking: true,
    title: "Need a decision",
    description: "...",
    question: null,
    suggestedOptions: null,
    recommendedOption: null,
    status: "OPEN",
    resolutionKind: null,
    resolution: null,
    resolvedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

function makeNotification(overrides: Partial<Notification>): Notification {
  return {
    id: "n1",
    userId: null,
    taskId: "t1",
    issueId: null,
    kind: "needs_human",
    title: "Task needs you",
    readAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface Fixtures {
  issues: Issue[];
  tasks: TaskCard[];
  notifications: Notification[];
}

function makeClient(fixtures: Fixtures): BoardApiClient {
  return makeFakeClient({
    listIssues: vi.fn(() => Promise.resolve(fixtures.issues)),
    listTasks: vi.fn(() => Promise.resolve(fixtures.tasks)),
    listNotifications: vi.fn(() => Promise.resolve(fixtures.notifications)),
    markNotificationRead: vi.fn((id: string) => {
      const found = fixtures.notifications.find((n) => n.id === id);
      const updated = { ...(found ?? makeNotification({ id })), readAt: "2026-01-02T00:00:00.000Z" };
      return Promise.resolve(updated);
    }),
  });
}

function renderDrawer(client: BoardApiClient) {
  return render(
    <MemoryRouter>
      <AttentionDrawer client={client} createEventSource={factory} />
    </MemoryRouter>,
  );
}

async function openDrawer() {
  const toggle = await screen.findByRole("button", { name: /attention/i });
  await act(async () => {
    toggle.click();
  });
}

describe("AttentionDrawer", () => {
  it("counts blocking issues, the three task groups, and unread notifications, and links each section (AC5)", async () => {
    const fixtures: Fixtures = {
      issues: [makeIssue({ id: "i1", taskId: "t1", title: "Need a decision" })],
      tasks: [
        makeTask({ id: "t1", jiraKey: "AAA-1", state: "NEEDS_HUMAN" }),
        makeTask({ id: "t2", jiraKey: "BBB-2", state: "SPEC_REVIEW" }),
        makeTask({ id: "t3", jiraKey: "CCC-3", state: "READY_FOR_MERGE" }),
      ],
      notifications: [makeNotification({ id: "n1", readAt: null, title: "Unread one" })],
    };
    const client = makeClient(fixtures);
    renderDrawer(client);

    await waitFor(() => expect(screen.getByTestId("attention-count").textContent).toBe("5"));
    expect(client.listIssues).toHaveBeenCalledWith({ status: "OPEN", blocking: true });
    expect(client.listTasks).toHaveBeenCalledWith({ attention: true });

    await openDrawer();

    const blocking = screen.getByRole("region", { name: "Blocking issues" });
    const blockingLink = within(blocking).getByRole("link", { name: "AAA-1: Need a decision" });
    expect(blockingLink.getAttribute("href")).toBe("/issues/i1");

    const specReviews = screen.getByRole("region", { name: "Spec reviews requested" });
    const specLink = within(specReviews).getByRole("link", { name: "BBB-2" });
    expect(specLink.getAttribute("href")).toBe("/tasks/t2/spec");

    const needsHuman = screen.getByRole("region", { name: "Needs human" });
    expect(within(needsHuman).getByRole("link", { name: "AAA-1" }).getAttribute("href")).toBe("/tasks/t1");

    const readyForMerge = screen.getByRole("region", { name: "Ready for merge" });
    expect(within(readyForMerge).getByRole("link", { name: "CCC-3" }).getAttribute("href")).toBe("/tasks/t3");

    const unreadSection = screen.getByRole("region", { name: "Unread notifications" });
    expect(within(unreadSection).getByText("Unread one")).toBeTruthy();
  });

  it("refetches all three lists and updates the count on issue.created (AC5)", async () => {
    const fixtures: Fixtures = {
      issues: [],
      tasks: [],
      notifications: [],
    };
    const client = makeClient(fixtures);
    renderDrawer(client);

    await waitFor(() => expect(screen.getByTestId("attention-count").textContent).toBe("0"));

    fixtures.issues = [makeIssue({ id: "i1" })];
    await act(async () => {
      currentSource().emit("issue.created", { issueId: "i1" });
    });

    await waitFor(() => expect(screen.getByTestId("attention-count").textContent).toBe("1"));
    expect(client.listIssues).toHaveBeenCalledTimes(2);
    expect(client.listTasks).toHaveBeenCalledTimes(2);
    expect(client.listNotifications).toHaveBeenCalledTimes(2);
  });

  it("marks a notification read and decrements the count after refetch (AC6)", async () => {
    const fixtures: Fixtures = {
      issues: [],
      tasks: [],
      notifications: [makeNotification({ id: "n1", readAt: null, title: "Unread one" })],
    };
    const client = makeClient(fixtures);
    renderDrawer(client);

    await waitFor(() => expect(screen.getByTestId("attention-count").textContent).toBe("1"));
    await openDrawer();

    fixtures.notifications = [
      { ...fixtures.notifications[0]!, readAt: "2026-01-02T00:00:00.000Z" },
    ];

    const markReadButton = screen.getByRole("button", { name: "Mark read" });
    await act(async () => {
      markReadButton.click();
    });

    expect(client.markNotificationRead).toHaveBeenCalledWith("n1");
    await waitFor(() => expect(screen.getByTestId("attention-count").textContent).toBe("0"));
    // Only notifications refetch, not the other two lists (contract point 3).
    expect(client.listIssues).toHaveBeenCalledTimes(1);
    expect(client.listTasks).toHaveBeenCalledTimes(1);
    expect(client.listNotifications).toHaveBeenCalledTimes(2);
  });

  it("refetches after a reconnect (AC4)", async () => {
    const client = makeClient({ issues: [], tasks: [], notifications: [] });
    renderDrawer(client);

    await waitFor(() => expect(client.listIssues).toHaveBeenCalledTimes(1));

    await act(async () => {
      currentSource().onopen?.();
    });
    await act(async () => {
      currentSource().onerror?.(new Event("error"));
    });

    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(1), {
      timeout: 3000,
    });

    await act(async () => {
      currentSource().onopen?.();
    });

    await waitFor(() => expect(client.listIssues).toHaveBeenCalledTimes(2));
  }, 10000);

  it("renders empty states for an empty drawer (AC7)", async () => {
    const client = makeClient({ issues: [], tasks: [], notifications: [] });
    renderDrawer(client);

    await waitFor(() => expect(screen.getByTestId("attention-count").textContent).toBe("0"));
    await openDrawer();

    expect(screen.getByText("No blocking issues.")).toBeTruthy();
    expect(screen.getByText("No spec reviews requested.")).toBeTruthy();
    expect(screen.getByText("No tasks need a human.")).toBeTruthy();
    expect(screen.getByText("No tasks ready for merge.")).toBeTruthy();
    expect(screen.getByText("No unread notifications.")).toBeTruthy();
    expect(screen.getByText("Nothing needs attention.")).toBeTruthy();
  });

  it("renders visible error text when a fetch fails (AC7)", async () => {
    const client: BoardApiClient = makeFakeClient({
      listIssues: vi.fn(() => Promise.reject(new Error("network down"))),
    });
    renderDrawer(client);
    await openDrawer();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("network down"));
  });

  it("keeps the latest fetchAll response when a slower earlier fetchAll resolves after a faster later one (F2)", async () => {
    let resolveFirstIssues: ((issues: Issue[]) => void) | undefined;
    let issuesCallCount = 0;
    const fixtures: Fixtures = { issues: [], tasks: [], notifications: [] };
    const client = makeClient(fixtures);
    client.listIssues = vi.fn(() => {
      issuesCallCount += 1;
      if (issuesCallCount === 1) {
        return new Promise<Issue[]>((resolve) => {
          resolveFirstIssues = resolve;
        });
      }
      return Promise.resolve([makeIssue({ id: "i2", title: "Second" })]);
    });

    renderDrawer(client);
    await waitFor(() => expect(client.listIssues).toHaveBeenCalledTimes(1));

    await act(async () => {
      currentSource().emit("issue.created", { issueId: "i2" });
    });
    await waitFor(() => expect(client.listIssues).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("attention-count").textContent).toBe("1"));

    // The slower, first (mount) fetchAll resolves last, with data that is now stale.
    await act(async () => {
      resolveFirstIssues?.([]);
    });

    expect(screen.getByTestId("attention-count").textContent).toBe("1");
  });

  it("does not let a slower, still-pending fetchAll overwrite a faster mark-read refetch (F2 shared generation)", async () => {
    let resolveSecondIssues: ((issues: Issue[]) => void) | undefined;
    let issuesCallCount = 0;
    const fixtures: Fixtures = {
      issues: [],
      tasks: [],
      notifications: [makeNotification({ id: "n1", readAt: null, title: "Unread one" })],
    };
    const client = makeClient(fixtures);
    client.listIssues = vi.fn(() => {
      issuesCallCount += 1;
      if (issuesCallCount === 2) {
        return new Promise<Issue[]>((resolve) => {
          resolveSecondIssues = resolve;
        });
      }
      return Promise.resolve(fixtures.issues);
    });
    client.markNotificationRead = vi.fn((id: string) => {
      fixtures.notifications = [{ ...fixtures.notifications[0]!, readAt: "2026-01-02T00:00:00.000Z" }];
      return Promise.resolve(fixtures.notifications[0]!);
    });

    renderDrawer(client);
    await waitFor(() => expect(screen.getByTestId("attention-count").textContent).toBe("1"));
    await openDrawer();

    // Trigger the second, slower fetchAll; it hangs on listIssues.
    await act(async () => {
      currentSource().emit("issue.created", { issueId: "i2" });
    });
    await waitFor(() => expect(client.listIssues).toHaveBeenCalledTimes(2));

    // Mark read while that fetchAll is still pending: fetchNotifications is a later generation.
    const markReadButton = screen.getByRole("button", { name: "Mark read" });
    await act(async () => {
      markReadButton.click();
    });
    await waitFor(() => expect(screen.getByTestId("attention-count").textContent).toBe("0"));

    // The stale, still-pending fetchAll finally resolves with pre-mark-read data.
    await act(async () => {
      resolveSecondIssues?.([]);
    });

    expect(screen.getByTestId("attention-count").textContent).toBe("0");
  });

  it("shows a visible error and leaves the count unchanged when markNotificationRead fails (F3)", async () => {
    const fixtures: Fixtures = {
      issues: [],
      tasks: [],
      notifications: [makeNotification({ id: "n1", readAt: null, title: "Unread one" })],
    };
    const client = makeClient(fixtures);
    client.markNotificationRead = vi.fn(() => Promise.reject(new Error("mark read failed")));

    renderDrawer(client);
    await waitFor(() => expect(screen.getByTestId("attention-count").textContent).toBe("1"));
    await openDrawer();

    const markReadButton = screen.getByRole("button", { name: "Mark read" });
    await act(async () => {
      markReadButton.click();
    });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("mark read failed"));
    expect(screen.getByTestId("attention-count").textContent).toBe("1");
    // Only the failed markNotificationRead call; no refetch follows a rejection.
    expect(client.listNotifications).toHaveBeenCalledTimes(1);
  });
});
