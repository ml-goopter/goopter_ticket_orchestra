// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskCard as TaskCardData } from "../api/types.js";
import { TaskCard } from "./TaskCard.js";

afterEach(cleanup);

function makeCard(overrides: Partial<TaskCardData> = {}): TaskCardData {
  return {
    id: "1",
    jiraKey: "ABC-1",
    jiraSummary: "Do the thing",
    state: "READY",
    column: "Ready",
    runtime: "codex",
    projectId: "p1",
    repositoryId: "r1",
    jiraPriority: 1,
    jiraCreatedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T11:57:00.000Z",
    hasWaitingExecution: false,
    cost: 12.345,
    ...overrides,
  };
}

const NOW = new Date("2026-01-01T12:00:00.000Z");

function renderCard(card: TaskCardData, highlighted = false) {
  return render(
    <MemoryRouter>
      <TaskCard card={card} now={NOW} highlighted={highlighted} />
    </MemoryRouter>,
  );
}

describe("TaskCard", () => {
  it("puts the full summary in the title attribute for the clamped text (AC2)", () => {
    const longSummary = "A very long summary that would otherwise overflow two clamped lines of card text.";
    renderCard(makeCard({ jiraSummary: longSummary }));
    expect(screen.getByText(longSummary).getAttribute("title")).toBe(longSummary);
  });

  it("renders the runtime as a tag (AC3)", () => {
    renderCard(makeCard({ runtime: "claude" }));
    const tag = screen.getByTestId("runtime-tag");
    expect(tag.textContent).toBe("claude");
    expect(tag.className).toContain("tag");
  });

  it("puts the key and cost on the top row, and the runtime tag before the age (AC3)", () => {
    renderCard(makeCard({ jiraKey: "ABC-1", cost: 4.5 }));
    const card = screen.getByTestId("board-card");
    const top = card.querySelector(".board-card__top");
    expect(top).not.toBeNull();
    expect(top?.contains(screen.getByRole("link", { name: "ABC-1" }))).toBe(true);
    expect(top?.contains(screen.getByTestId("card-cost"))).toBe(true);

    const meta = card.querySelector(".board-card__meta");
    expect(meta).not.toBeNull();
    expect(meta?.contains(screen.getByTestId("runtime-tag"))).toBe(true);
    expect(meta?.contains(screen.getByTestId("card-age"))).toBe(true);
  });

  it("formats cost with formatUsd's sub-cent precision below one cent (AC2)", () => {
    renderCard(makeCard({ cost: 0.004 }));
    expect(screen.getByTestId("card-cost").textContent).toBe("$0.0040");
  });

  it("renders an em dash when cost is not a finite number", () => {
    renderCard(makeCard({ cost: Number.NaN }));
    expect(screen.getByTestId("card-cost").textContent).toBe("—");
  });

  it("carries the highlighted accent class only when its column is highlighted", () => {
    const { unmount } = renderCard(makeCard(), true);
    expect(screen.getByTestId("board-card").className).toContain("board-card--highlighted");
    unmount();

    renderCard(makeCard(), false);
    expect(screen.getByTestId("board-card").className).not.toContain("board-card--highlighted");
  });
});
