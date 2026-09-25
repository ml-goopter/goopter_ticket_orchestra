// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardApiClient } from "../api/client.js";
import type { TaskCard } from "../api/types.js";
import type { EventSourceLike, MessageEventLike } from "../sse/useEventStream.js";
import { BoardView } from "./BoardView.js";

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

function makeCard(overrides: Partial<TaskCard>): TaskCard {
  return {
    id: "1",
    jiraKey: "ABC-1",
    jiraSummary: "Do the thing",
    state: "READY",
    column: "Ready",
    runtime: "claude",
    projectId: "p1",
    repositoryId: "r1",
    jiraPriority: 1,
    jiraCreatedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T11:57:00.000Z",
    hasWaitingExecution: false,
    cost: 1.5,
    ...overrides,
  };
}

function makeClient(listTasksImpl: () => Promise<TaskCard[]>): BoardApiClient {
  return {
    request: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    health: vi.fn(),
    listTasks: vi.fn(listTasksImpl),
    listIssues: vi.fn().mockResolvedValue([]),
    listNotifications: vi.fn().mockResolvedValue([]),
    markNotificationRead: vi.fn(),
  };
}

const NOW = () => new Date("2026-01-01T12:00:00.000Z");

function renderBoard(client: BoardApiClient) {
  return render(
    <MemoryRouter>
      <BoardView client={client} createEventSource={factory} now={NOW} />
    </MemoryRouter>,
  );
}

describe("BoardView", () => {
  it("renders the ten columns in order, highlights the first two, and places cards by the api's column (AC1)", async () => {
    const client = makeClient(() =>
      Promise.resolve([
        makeCard({ id: "1", jiraKey: "AAA-1", column: "Ready" }),
        makeCard({ id: "2", jiraKey: "BBB-2", column: "Needs Human" }),
      ]),
    );
    renderBoard(client);

    await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(10));

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      "Waiting for You",
      "Needs Human",
      "Needs Spec",
      "Spec In Progress",
      "Awaiting Spec Approval",
      "Ready",
      "Implementing",
      "CI",
      "Ready for Merge",
      "Done",
    ]);

    const waitingSection = screen.getByRole("region", { name: "Waiting for You" });
    const needsHumanSection = screen.getByRole("region", { name: "Needs Human" });
    expect(waitingSection.getAttribute("data-highlighted")).toBe("true");
    expect(needsHumanSection.getAttribute("data-highlighted")).toBe("true");
    expect(screen.getByRole("region", { name: "Ready" }).getAttribute("data-highlighted")).toBe("false");

    expect(within(needsHumanSection).getByRole("link", { name: "BBB-2" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Ready" })).queryByRole("link", { name: "BBB-2" })).toBeNull();
  });

  it("shows the key link, summary, runtime badge, age, and cost on a card (AC2)", async () => {
    const client = makeClient(() =>
      Promise.resolve([
        makeCard({
          id: "1",
          jiraKey: "ABC-1",
          jiraSummary: "Do the thing",
          column: "Ready",
          runtime: "codex",
          updatedAt: "2026-01-01T11:57:00.000Z",
          cost: 12.345,
        }),
      ]),
    );
    renderBoard(client);

    await waitFor(() => expect(screen.getByTestId("board-card")).toBeTruthy());

    const card = screen.getByTestId("board-card");
    const link = within(card).getByRole("link", { name: "ABC-1" });
    expect(link.getAttribute("href")).toBe("/tasks/1");
    expect(within(card).getByText("Do the thing")).toBeTruthy();
    expect(within(card).getByTestId("runtime-badge").textContent).toBe("codex");
    expect(within(card).getByTestId("card-age").textContent).toBe("3m");
    expect(within(card).getByTestId("card-cost").textContent).toBe("$12.35");
  });

  it("refetches and moves a card to its new column on task.state_changed, without remounting the view (AC3)", async () => {
    let response: TaskCard[] = [makeCard({ id: "1", column: "Ready" })];
    const client = makeClient(() => Promise.resolve(response));
    renderBoard(client);

    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "Ready" })).getByTestId("board-card")).toBeTruthy(),
    );

    const mainBefore = screen.getByRole("main");

    response = [makeCard({ id: "1", column: "Done" })];
    await act(async () => {
      currentSource().emit("task.state_changed", { taskId: "1" });
    });

    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "Done" })).getByTestId("board-card")).toBeTruthy(),
    );
    expect(within(screen.getByRole("region", { name: "Ready" })).queryByTestId("board-card")).toBeNull();
    expect(client.listTasks).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("main")).toBe(mainBefore);
  });

  it("refetches after a reconnect (AC4)", async () => {
    const client = makeClient(() => Promise.resolve([]));
    renderBoard(client);

    await waitFor(() => expect(client.listTasks).toHaveBeenCalledTimes(1));

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

    await waitFor(() => expect(client.listTasks).toHaveBeenCalledTimes(2));
  }, 10000);

  it("renders empty states for an empty board (AC7)", async () => {
    const client = makeClient(() => Promise.resolve([]));
    renderBoard(client);

    await waitFor(() => expect(screen.getAllByText("No tasks.")).toHaveLength(10));
  });

  it("renders visible error text when the fetch fails (AC7)", async () => {
    const client = makeClient(() => Promise.reject(new Error("network down")));
    renderBoard(client);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("network down"));
  });
});
