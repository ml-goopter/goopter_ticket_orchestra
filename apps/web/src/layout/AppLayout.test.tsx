// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { BoardApiClient, User } from "../api/client.js";
import type { Issue, TaskCard } from "../api/types.js";
import { SessionProvider } from "../auth/SessionProvider.js";
import { makeFakeClient } from "../task/fixtures.js";
import { AppLayout } from "./AppLayout.js";

afterEach(cleanup);

function makeUser(): User {
  return { id: "1", email: "a@b.com", displayName: "Alex Morgan" };
}

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

function renderLayout(client: BoardApiClient) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <SessionProvider client={client}>
        <Routes>
          <Route element={<AppLayout client={client} />}>
            <Route path="/" element={<div>content</div>} />
          </Route>
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("AppLayout", () => {
  it("renders a left sidebar with an Attention nav item carrying a zero count badge, and no top header bar", async () => {
    const client = makeFakeClient({ me: vi.fn().mockResolvedValue(makeUser()) });

    renderLayout(client);

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
    const toggle = await screen.findByRole("button", { name: /attention/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("attention-count").textContent).toBe("0");
    expect(document.querySelector(".app-shell__bar")).toBeNull();
  });

  it("renders Board, Costs, and Admin nav links, and the user's name plus a Log out button (AC1)", async () => {
    const client = makeFakeClient({ me: vi.fn().mockResolvedValue(makeUser()) });

    renderLayout(client);

    expect(await screen.findByRole("link", { name: "Board" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Costs" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Admin" })).toBeTruthy();
    expect(await screen.findByText("Alex Morgan")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
  });

  it("shows the sidebar's total and per-section counts from the attention data (AC1, AC9)", async () => {
    const client = makeFakeClient({
      me: vi.fn().mockResolvedValue(makeUser()),
      listIssues: vi.fn().mockResolvedValue([makeIssue({ id: "i1" })]),
      listTasks: vi.fn().mockResolvedValue([
        makeTask({ id: "t1", state: "NEEDS_HUMAN" }),
        makeTask({ id: "t2", state: "READY_FOR_MERGE" }),
      ]),
    });

    renderLayout(client);

    await waitFor(() => expect(screen.getByTestId("attention-count").textContent).toBe("3"));
    expect(screen.getByTestId("attention-count-blocking").textContent).toBe("1");
    expect(screen.getByTestId("attention-count-specReviews").textContent).toBe("0");
    expect(screen.getByTestId("attention-count-needsHuman").textContent).toBe("1");
    expect(screen.getByTestId("attention-count-readyForMerge").textContent).toBe("1");
    expect(screen.getByTestId("attention-count-unread").textContent).toBe("0");
  });

  it("opens the panel scrolled to the clicked sub-row, and returns focus to that sub-row on close (AC2, AC3, AC9)", async () => {
    const client = makeFakeClient({
      me: vi.fn().mockResolvedValue(makeUser()),
      listTasks: vi.fn().mockResolvedValue([makeTask({ id: "t1", state: "NEEDS_HUMAN" })]),
    });

    const scrolledElements: Element[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolledElements.push(this);
    });

    renderLayout(client);

    const needsHumanRow = await screen.findByRole("button", { name: /needs human/i });
    await act(async () => {
      needsHumanRow.click();
    });

    const dialog = await screen.findByRole("dialog", { name: "Attention" });
    expect(dialog).toBeTruthy();
    const needsHumanSection = screen.getByRole("region", { name: "Needs human" });
    expect(scrolledElements).toContain(needsHumanSection);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(needsHumanRow);
  });
});
