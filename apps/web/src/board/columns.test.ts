import { DASHBOARD_COLUMNS } from "@orchestra/core";
import { describe, expect, it } from "vitest";
import type { TaskCard } from "../api/types.js";
import { BOARD_COLUMN_ORDER, groupByColumn, HIGHLIGHTED_COLUMNS } from "./columns.js";

function makeCard(overrides: Partial<TaskCard>): TaskCard {
  return {
    id: "1",
    jiraKey: "ABC-1",
    jiraSummary: "Summary",
    state: "READY",
    column: "Ready",
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

describe("BOARD_COLUMN_ORDER", () => {
  it("is a permutation of core's DASHBOARD_COLUMNS", () => {
    expect([...BOARD_COLUMN_ORDER].sort()).toEqual([...DASHBOARD_COLUMNS].sort());
    expect(BOARD_COLUMN_ORDER).toHaveLength(DASHBOARD_COLUMNS.length);
  });

  it("puts Waiting for You and Needs Human first, in that order", () => {
    expect(BOARD_COLUMN_ORDER[0]).toBe("Waiting for You");
    expect(BOARD_COLUMN_ORDER[1]).toBe("Needs Human");
  });
});

describe("HIGHLIGHTED_COLUMNS", () => {
  it("contains exactly the first two columns", () => {
    expect(HIGHLIGHTED_COLUMNS.has("Waiting for You")).toBe(true);
    expect(HIGHLIGHTED_COLUMNS.has("Needs Human")).toBe(true);
    expect(HIGHLIGHTED_COLUMNS.size).toBe(2);
  });
});

describe("groupByColumn", () => {
  it("returns every column, even empty ones, preserving input order within a column", () => {
    const cards = [
      makeCard({ id: "1", column: "Ready" }),
      makeCard({ id: "2", column: "Done" }),
      makeCard({ id: "3", column: "Ready" }),
    ];

    const grouped = groupByColumn(cards);

    expect([...grouped.keys()]).toEqual([...BOARD_COLUMN_ORDER]);
    expect(grouped.get("Ready")?.map((c) => c.id)).toEqual(["1", "3"]);
    expect(grouped.get("Done")?.map((c) => c.id)).toEqual(["2"]);
    expect(grouped.get("Needs Spec")).toEqual([]);
  });
});
