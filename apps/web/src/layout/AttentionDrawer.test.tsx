// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardApiClient } from "../api/client.js";
import type { Issue, Notification, TaskCard } from "../api/types.js";
import type { EventSourceLike, MessageEventLike } from "../sse/useEventStream.js";
import { makeFakeClient } from "../task/fixtures.js";
import {
  AttentionDrawer,
  type AttentionCounts,
  type AttentionDrawerHandle,
  type AttentionSection,
} from "./AttentionDrawer.js";

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

const NOW = new Date("2026-01-01T00:05:00.000Z");

/**
 * Stands in for the sidebar (layout/AppLayout.tsx): a generic opener button
 * (no section, scrolls to the top) and one opener per section, each of
 * which is the element focus should return to on close.
 */
function Harness(props: {
  client: BoardApiClient;
  onCountsChange?: (counts: AttentionCounts) => void;
  now?: Date;
}) {
  const ref = useRef<AttentionDrawerHandle | null>(null);
  const sections: AttentionSection[] = ["blocking", "specReviews", "needsHuman", "readyForMerge", "unread"];
  return (
    <>
      <button onClick={(event) => ref.current?.open(undefined, event.currentTarget)}>Open</button>
      {sections.map((section) => (
        <button key={section} onClick={(event) => ref.current?.open(section, event.currentTarget)}>
          Open {section}
        </button>
      ))}
      <AttentionDrawer
        ref={ref}
        client={props.client}
        createEventSource={factory}
        onCountsChange={props.onCountsChange}
        now={props.now}
      />
    </>
  );
}

function renderHarness(client: BoardApiClient, onCountsChange?: (counts: AttentionCounts) => void) {
  return render(
    <MemoryRouter>
      <Harness client={client} onCountsChange={onCountsChange} now={NOW} />
    </MemoryRouter>,
  );
}

async function openPanel() {
  const toggle = await screen.findByRole("button", { name: "Open" });
  await act(async () => {
    toggle.click();
  });
}

async function openSection(section: AttentionSection) {
  const toggle = await screen.findByRole("button", { name: `Open ${section}` });
  await act(async () => {
    toggle.click();
  });
  return toggle;
}

describe("AttentionDrawer", () => {
  it("reports counts for blocking issues, the three task groups, and unread notifications via onCountsChange (AC5)", async () => {
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
    const onCountsChange = vi.fn();
    renderHarness(client, onCountsChange);

    await waitFor(() =>
      expect(onCountsChange).toHaveBeenLastCalledWith({
        blocking: 1,
        specReviews: 1,
        needsHuman: 1,
        readyForMerge: 1,
        unread: 1,
        total: 5,
      }),
    );
    expect(client.listIssues).toHaveBeenCalledWith({ status: "OPEN", blocking: true });
    expect(client.listTasks).toHaveBeenCalledWith({ attention: true });

    await openPanel();

    const blocking = screen.getByRole("region", { name: "Blocking issues" });
    const blockingLink = within(blocking).getByRole("link", { name: "AAA-1: Need a decision" });
    expect(blockingLink.getAttribute("href")).toBe("/issues/i1");

    const specReviews = screen.getByRole("region", { name: "Spec reviews requested" });
    const specLink = within(specReviews).getByRole("link", { name: "BBB-2: Summary" });
    expect(specLink.getAttribute("href")).toBe("/tasks/t2/spec");
    expect(within(specReviews).getByText("5m")).toBeTruthy();

    const needsHuman = screen.getByRole("region", { name: "Needs human" });
    expect(within(needsHuman).getByRole("link", { name: "AAA-1: Summary" }).getAttribute("href")).toBe(
      "/tasks/t1",
    );

    const readyForMerge = screen.getByRole("region", { name: "Ready for merge" });
    expect(within(readyForMerge).getByRole("link", { name: "CCC-3: Summary" }).getAttribute("href")).toBe(
      "/tasks/t3",
    );

    const unreadSection = screen.getByRole("region", { name: "Unread notifications" });
    expect(within(unreadSection).getByText("Unread one")).toBeTruthy();
  });

  it("refetches all three lists and updates counts on issue.created (AC5)", async () => {
    const fixtures: Fixtures = {
      issues: [],
      tasks: [],
      notifications: [],
    };
    const client = makeClient(fixtures);
    const onCountsChange = vi.fn();
    renderHarness(client, onCountsChange);

    await waitFor(() => expect(onCountsChange).toHaveBeenLastCalledWith(expect.objectContaining({ total: 0 })));

    fixtures.issues = [makeIssue({ id: "i1" })];
    await act(async () => {
      currentSource().emit("issue.created", { issueId: "i1" });
    });

    await waitFor(() => expect(onCountsChange).toHaveBeenLastCalledWith(expect.objectContaining({ total: 1 })));
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
    const onCountsChange = vi.fn();
    renderHarness(client, onCountsChange);

    await waitFor(() => expect(onCountsChange).toHaveBeenLastCalledWith(expect.objectContaining({ total: 1 })));
    await openPanel();

    fixtures.notifications = [
      { ...fixtures.notifications[0]!, readAt: "2026-01-02T00:00:00.000Z" },
    ];

    const markReadButton = screen.getByRole("button", { name: "Mark read" });
    await act(async () => {
      markReadButton.click();
    });

    expect(client.markNotificationRead).toHaveBeenCalledWith("n1");
    await waitFor(() => expect(onCountsChange).toHaveBeenLastCalledWith(expect.objectContaining({ total: 0 })));
    // Only notifications refetch, not the other two lists (contract point 3).
    expect(client.listIssues).toHaveBeenCalledTimes(1);
    expect(client.listTasks).toHaveBeenCalledTimes(1);
    expect(client.listNotifications).toHaveBeenCalledTimes(2);
  });

  it("refetches after a reconnect (AC4)", async () => {
    const client = makeClient({ issues: [], tasks: [], notifications: [] });
    renderHarness(client);

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

  it("renders empty states for an empty panel", async () => {
    const client = makeClient({ issues: [], tasks: [], notifications: [] });
    renderHarness(client);

    await openPanel();

    expect(screen.getByText("No blocking issues.")).toBeTruthy();
    expect(screen.getByText("No spec reviews requested.")).toBeTruthy();
    expect(screen.getByText("No tasks need a human.")).toBeTruthy();
    expect(screen.getByText("No tasks ready for merge.")).toBeTruthy();
    expect(screen.getByText("No unread notifications.")).toBeTruthy();
    expect(screen.getByText("Nothing needs attention.")).toBeTruthy();
  });

  it("renders visible error text when a fetch fails", async () => {
    const client: BoardApiClient = makeFakeClient({
      listIssues: vi.fn(() => Promise.reject(new Error("network down"))),
    });
    renderHarness(client);
    await openPanel();

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
    const onCountsChange = vi.fn();

    renderHarness(client, onCountsChange);
    await waitFor(() => expect(client.listIssues).toHaveBeenCalledTimes(1));

    await act(async () => {
      currentSource().emit("issue.created", { issueId: "i2" });
    });
    await waitFor(() => expect(client.listIssues).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onCountsChange).toHaveBeenLastCalledWith(expect.objectContaining({ total: 1 })));

    // The slower, first (mount) fetchAll resolves last, with data that is now stale.
    await act(async () => {
      resolveFirstIssues?.([]);
    });

    expect(onCountsChange).toHaveBeenLastCalledWith(expect.objectContaining({ total: 1 }));
  });

  it("shows a visible error and leaves the count unchanged when markNotificationRead fails (F3)", async () => {
    const fixtures: Fixtures = {
      issues: [],
      tasks: [],
      notifications: [makeNotification({ id: "n1", readAt: null, title: "Unread one" })],
    };
    const client = makeClient(fixtures);
    client.markNotificationRead = vi.fn(() => Promise.reject(new Error("mark read failed")));
    const onCountsChange = vi.fn();

    renderHarness(client, onCountsChange);
    await waitFor(() => expect(onCountsChange).toHaveBeenLastCalledWith(expect.objectContaining({ total: 1 })));
    await openPanel();

    const markReadButton = screen.getByRole("button", { name: "Mark read" });
    await act(async () => {
      markReadButton.click();
    });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("mark read failed"));
    expect(onCountsChange).toHaveBeenLastCalledWith(expect.objectContaining({ total: 1 }));
    // Only the failed markNotificationRead call; no refetch follows a rejection.
    expect(client.listNotifications).toHaveBeenCalledTimes(1);
  });

  it("links a notification's title to its issue when issueId is set, else to its task (V3)", async () => {
    const fixtures: Fixtures = {
      issues: [],
      tasks: [makeTask({ id: "t1", jiraKey: "AAA-1", state: "READY" })],
      notifications: [
        makeNotification({ id: "n1", taskId: "t1", issueId: "i9", title: "Has an issue", readAt: null }),
        makeNotification({ id: "n2", taskId: "t1", issueId: null, title: "No issue", readAt: null }),
      ],
    };
    const client = makeClient(fixtures);
    renderHarness(client);
    await openPanel();

    const unreadSection = screen.getByRole("region", { name: "Unread notifications" });
    expect(within(unreadSection).getByRole("link", { name: "Has an issue" }).getAttribute("href")).toBe(
      "/issues/i9",
    );
    expect(within(unreadSection).getByRole("link", { name: "No issue" }).getAttribute("href")).toBe("/tasks/t1");
    expect(within(unreadSection).getAllByText("AAA-1")).toHaveLength(2);
  });

  describe("dialog behaviour (U1)", () => {
    it("is a dialog with an accessible name, closed by default and opened by the trigger", async () => {
      const client = makeClient({ issues: [], tasks: [], notifications: [] });
      renderHarness(client);

      expect(screen.queryByRole("dialog")).toBeNull();

      await openPanel();

      const dialog = screen.getByRole("dialog", { name: "Attention" });
      expect(dialog).toBeTruthy();
    });

    it("moves focus into the panel on open and back to the opener on close via the close button", async () => {
      const client = makeClient({ issues: [], tasks: [], notifications: [] });
      renderHarness(client);

      const toggle = await screen.findByRole("button", { name: "Open" });
      await openPanel();

      const dialog = screen.getByRole("dialog", { name: "Attention" });
      expect(dialog.contains(document.activeElement)).toBe(true);

      const closeButton = screen.getByRole("button", { name: "Close" });
      await act(async () => {
        closeButton.click();
      });

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(toggle);
    });

    it("returns focus to whichever sub-row opened the panel, not always the same opener", async () => {
      const client = makeClient({ issues: [], tasks: [], notifications: [] });
      renderHarness(client);

      const opener = await openSection("needsHuman");
      expect(screen.getByRole("dialog", { name: "Attention" })).toBeTruthy();

      const closeButton = screen.getByRole("button", { name: "Close" });
      await act(async () => {
        closeButton.click();
      });

      expect(document.activeElement).toBe(opener);
    });

    it("closes on Escape and returns focus to the opener", async () => {
      const client = makeClient({ issues: [], tasks: [], notifications: [] });
      renderHarness(client);

      const toggle = await screen.findByRole("button", { name: "Open" });
      await openPanel();
      expect(screen.getByRole("dialog", { name: "Attention" })).toBeTruthy();

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(toggle);
    });

    it("closes on a backdrop click", async () => {
      const client = makeClient({ issues: [], tasks: [], notifications: [] });
      renderHarness(client);

      await openPanel();
      expect(screen.getByRole("dialog", { name: "Attention" })).toBeTruthy();

      const backdrop = document.querySelector(".side-panel__backdrop");
      expect(backdrop).toBeTruthy();
      await act(async () => {
        (backdrop as HTMLElement).click();
      });

      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("scrolls the requested section into view when opened from a sub-row", async () => {
      const client = makeClient({
        issues: [],
        tasks: [makeTask({ id: "t1", jiraKey: "AAA-1", state: "NEEDS_HUMAN" })],
        notifications: [],
      });
      renderHarness(client);

      const scrolledElements: Element[] = [];
      Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
        scrolledElements.push(this);
      });

      await openSection("needsHuman");

      const needsHumanSection = screen.getByRole("region", { name: "Needs human" });
      expect(scrolledElements).toContain(needsHumanSection);
    });
  });
});
