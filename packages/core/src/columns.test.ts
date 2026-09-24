import { describe, expect, it } from "vitest";
import { TaskState } from "./enums.js";
import { deriveColumn } from "./columns.js";

describe("deriveColumn: one state maps to each column (§5.1 table)", () => {
  it("NEEDS_SPEC -> Needs Spec", () => {
    expect(deriveColumn(TaskState.NEEDS_SPEC, false)).toBe("Needs Spec");
  });

  it("SPEC_IN_PROGRESS -> Spec In Progress", () => {
    expect(deriveColumn(TaskState.SPEC_IN_PROGRESS, false)).toBe("Spec In Progress");
  });

  it("SPEC_REVIEW -> Awaiting Spec Approval", () => {
    expect(deriveColumn(TaskState.SPEC_REVIEW, false)).toBe("Awaiting Spec Approval");
  });

  it("SPEC_APPROVED, READY, BLOCKED -> Ready", () => {
    expect(deriveColumn(TaskState.SPEC_APPROVED, false)).toBe("Ready");
    expect(deriveColumn(TaskState.READY, false)).toBe("Ready");
    expect(deriveColumn(TaskState.BLOCKED, false)).toBe("Ready");
  });

  it("IMPLEMENTING with no waiting execution -> Implementing", () => {
    expect(deriveColumn(TaskState.IMPLEMENTING, false)).toBe("Implementing");
  });

  it("IMPLEMENTING with a waiting execution -> Waiting for You", () => {
    expect(deriveColumn(TaskState.IMPLEMENTING, true)).toBe("Waiting for You");
  });

  it("REVIEWING with no waiting execution -> Implementing", () => {
    expect(deriveColumn(TaskState.REVIEWING, false)).toBe("Implementing");
  });

  it("CI_RUNNING -> CI", () => {
    expect(deriveColumn(TaskState.CI_RUNNING, false)).toBe("CI");
  });

  it("READY_FOR_MERGE -> Ready for Merge", () => {
    expect(deriveColumn(TaskState.READY_FOR_MERGE, false)).toBe("Ready for Merge");
  });

  it("NEEDS_HUMAN -> Needs Human", () => {
    expect(deriveColumn(TaskState.NEEDS_HUMAN, false)).toBe("Needs Human");
  });

  it("DONE, CANCELLED -> Done", () => {
    expect(deriveColumn(TaskState.DONE, false)).toBe("Done");
    expect(deriveColumn(TaskState.CANCELLED, false)).toBe("Done");
  });
});

describe("deriveColumn: Waiting for You wins for any task state", () => {
  it("wins even for a state that would otherwise map to Ready", () => {
    expect(deriveColumn(TaskState.SPEC_APPROVED, true)).toBe("Waiting for You");
  });

  it("wins even for NEEDS_HUMAN", () => {
    expect(deriveColumn(TaskState.NEEDS_HUMAN, true)).toBe("Waiting for You");
  });
});
