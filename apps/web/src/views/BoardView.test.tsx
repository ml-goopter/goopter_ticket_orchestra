// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardApiClient } from "../api/client.js";
import type { TaskCard } from "../api/types.js";
import type { EventSourceLike, MessageEventLike } from "../sse/useEventStream.js";
import { makeFakeClient } from "../task/fixtures.js";
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
  return makeFakeClient({ listTasks: vi.fn(listTasksImpl) });
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
    const readySection = screen.getByRole("region", { name: "Ready" });
    expect(waitingSection.getAttribute("data-highlighted")).toBe("true");
    expect(needsHumanSection.getAttribute("data-highlighted")).toBe("true");
    expect(readySection.getAttribute("data-highlighted")).toBe("false");
    expect(waitingSection.className).toContain("kanban__column--highlighted");
    expect(needsHumanSection.className).toContain("kanban__column--highlighted");
    expect(readySection.className).not.toContain("kanban__column--highlighted");

    // Compact column modifier (B1/B3, U7): an empty, non-highlighted
    // column ("Needs Spec", no cards in this fixture) collapses to a
    // narrow column -- header only, no "No tasks." line -- but its
    // heading and count are still in the DOM with their normal,
    // horizontal (unrotated) text. A populated column ("Ready") and an
    // empty but highlighted column ("Waiting for You") are never compact.
    const needsSpecSection = screen.getByRole("region", { name: "Needs Spec" });
    expect(needsSpecSection.className).toContain("board-column--compact");
    expect(within(needsSpecSection).queryByText("No tasks.")).toBeNull();
    expect(readySection.className).not.toContain("board-column--compact");
    expect(waitingSection.className).not.toContain("board-column--compact");
    expect(within(needsSpecSection).getByRole("heading", { level: 2 }).textContent).toBe("Needs Spec");
    expect(within(needsSpecSection).getByText("0").className).toContain("badge");

    // A compact column's heading keeps its full, unclipped name even when
    // it's the longest one on the board (U7): it wraps onto multiple
    // lines rather than being truncated or rotated.
    const specApprovalSection = screen.getByRole("region", { name: "Awaiting Spec Approval" });
    expect(specApprovalSection.className).toContain("board-column--compact");
    expect(within(specApprovalSection).getByRole("heading", { level: 2 }).textContent).toBe(
      "Awaiting Spec Approval",
    );
    expect(within(specApprovalSection).getByText("0").className).toContain("badge");

    // Highlighted-empty modifier (B3): "Waiting for You" has no cards in
    // this fixture, so it's narrower than a populated column, but never
    // compact. "Needs Human" has a card, so it doesn't get that modifier
    // either, despite also being highlighted.
    expect(waitingSection.className).toContain("board-column--highlighted-empty");
    expect(needsHumanSection.className).not.toContain("board-column--highlighted-empty");
    expect(readySection.className).not.toContain("board-column--highlighted-empty");

    // Column header: name plus a card count badge (AC1).
    expect(within(needsHumanSection).getByText("1").className).toContain("badge");
    expect(within(readySection).getByText("1").className).toContain("badge");

    expect(within(needsHumanSection).getByRole("link", { name: "BBB-2" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Ready" })).queryByRole("link", { name: "BBB-2" })).toBeNull();
  });

  it("shows the topbar with 'Board' and the loaded card count, no extra request (AC1)", async () => {
    const client = makeClient(() =>
      Promise.resolve([makeCard({ id: "1", column: "Ready" }), makeCard({ id: "2", column: "Done" })]),
    );
    renderBoard(client);

    expect(screen.getByRole("heading", { name: "Board" })).toBeTruthy();
    expect(screen.queryByText(/tasks$/)).toBeNull();

    await waitFor(() => expect(screen.getByText("· 2 tasks")).toBeTruthy());
    expect(client.listTasks).toHaveBeenCalledTimes(1);
  });

  it("colours the highlighted columns' count pill amber and gives every other column header a colour dot (AC2)", async () => {
    const client = makeClient(() => Promise.resolve([]));
    renderBoard(client);

    await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(10));

    const waiting = screen.getByRole("region", { name: "Waiting for You" });
    const needsHuman = screen.getByRole("region", { name: "Needs Human" });
    expect(within(waiting).getByText("0").className).toContain("badge--attention");
    expect(within(needsHuman).getByText("0").className).toContain("badge--attention");

    const ready = screen.getByRole("region", { name: "Ready" });
    expect(within(ready).getByText("0").className).toContain("badge--neutral");

    const dot = (name: string) => screen.getByRole("region", { name }).querySelector(".board-column__dot");
    expect(dot("Waiting for You")?.className).toContain("board-column__dot--attention");
    expect(dot("Spec In Progress")?.className).toContain("board-column__dot--progress");
    expect(dot("Implementing")?.className).toContain("board-column__dot--progress");
    expect(dot("CI")?.className).toContain("board-column__dot--progress");
    expect(dot("Ready for Merge")?.className).toContain("board-column__dot--success");
    expect(dot("Done")?.className).toContain("board-column__dot--success");
    expect(dot("Needs Spec")?.className).toContain("board-column__dot--neutral");
  });

  it("shows the key link, summary, runtime tag, age, and cost on a card (AC3)", async () => {
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
    const summary = within(card).getByText("Do the thing");
    expect(summary.getAttribute("title")).toBe("Do the thing");
    expect(within(card).getByTestId("runtime-tag").className).toContain("tag");
    expect(within(card).getByTestId("runtime-tag").textContent).toBe("codex");
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

  it("keeps the latest response when a slower earlier fetch resolves after a faster later one (F1)", async () => {
    let resolveFirst: ((cards: TaskCard[]) => void) | undefined;
    let callCount = 0;
    const client = makeClient(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<TaskCard[]>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve([makeCard({ id: "1", column: "Done" })]);
    });
    renderBoard(client);

    await waitFor(() => expect(client.listTasks).toHaveBeenCalledTimes(1));

    await act(async () => {
      currentSource().emit("task.state_changed", { taskId: "1" });
    });
    await waitFor(() => expect(client.listTasks).toHaveBeenCalledTimes(2));

    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "Done" })).getByTestId("board-card")).toBeTruthy(),
    );

    // The slower, first (mount) fetch resolves last, with data that is now stale.
    await act(async () => {
      resolveFirst?.([makeCard({ id: "1", column: "Ready" })]);
    });

    expect(within(screen.getByRole("region", { name: "Done" })).getByTestId("board-card")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Ready" })).queryByTestId("board-card")).toBeNull();
  });

  it("renders empty states for an empty board (AC7)", async () => {
    const client = makeClient(() => Promise.resolve([]));
    renderBoard(client);

    await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(10));

    // Every column is empty. The two highlighted columns stay full height
    // (narrower than a populated column) and show the "No tasks." line;
    // the other eight, empty and not highlighted, collapse to a compact
    // column with no card area at all (B1/B3).
    expect(screen.getAllByText("No tasks.")).toHaveLength(2);
    for (const empty of screen.getAllByText("No tasks.")) {
      expect(empty.className).toContain("board-empty");
      expect(empty.tagName).toBe("P");
    }

    const waitingSection = screen.getByRole("region", { name: "Waiting for You" });
    const needsHumanSection = screen.getByRole("region", { name: "Needs Human" });
    const readySection = screen.getByRole("region", { name: "Ready" });
    expect(waitingSection.className).not.toContain("board-column--compact");
    expect(needsHumanSection.className).not.toContain("board-column--compact");
    expect(readySection.className).toContain("board-column--compact");
    expect(within(readySection).queryByText("No tasks.")).toBeNull();
    expect(within(readySection).getByRole("heading", { level: 2 }).textContent).toBe("Ready");
    expect(within(readySection).getByText("0").className).toContain("badge");

    expect(waitingSection.className).toContain("board-column--highlighted-empty");
    expect(needsHumanSection.className).toContain("board-column--highlighted-empty");
    expect(readySection.className).not.toContain("board-column--highlighted-empty");
  });

  it("renders visible error text when the fetch fails (AC7)", async () => {
    const client = makeClient(() => Promise.reject(new Error("network down")));
    renderBoard(client);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("network down"));
  });

  it("never breaks the board out to the viewport width (regression, UR2 fix F1)", () => {
    // `100vw` / `calc(50% - 50vw)` escape `.page`'s own box (the area right
    // of the sidebar) to the full viewport, overlapping the sidebar and
    // running past the right edge. The board must instead stay inside
    // `.page` and rely on `.topbar`'s own shared edge-to-edge break-out.
    // Note: this file runs under `@vitest-environment jsdom`, whose global
    // `URL` is jsdom's own (not Node's), so `new URL(relative, import.meta.url)`
    // would throw when handed to Node's `fileURLToPath`. Resolve via
    // `node:path` off the already-absolute test file path instead.
    const testFilePath = fileURLToPath(import.meta.url);
    const cssPath = join(dirname(testFilePath), "..", "board", "board.css");
    const css = readFileSync(cssPath, "utf8");
    expect(css).not.toContain("100vw");
    expect(css).not.toContain("50vw");
    expect(css).not.toContain("overflow-x: hidden");
  });
});
