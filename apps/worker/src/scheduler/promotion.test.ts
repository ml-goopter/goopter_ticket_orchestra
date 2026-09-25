import type { TaskState } from "@orchestra/core";
import { describe, expect, it } from "vitest";
import { decidePromotion } from "./promotion.js";

describe("decidePromotion (design.md §6.2)", () => {
  it("promotes a task with no dependencies", () => {
    expect(decidePromotion([])).toBe("dependency.satisfied");
  });

  it("promotes when every dependency is DONE", () => {
    expect(decidePromotion(["DONE", "DONE"])).toBe("dependency.satisfied");
  });

  it.each<TaskState>(["FAILED", "CANCELLED"])(
    "blocks when any dependency is %s",
    (bad) => {
      expect(decidePromotion(["DONE", bad])).toBe("dependency.failed");
    },
  );

  it("blocks on a failed dependency even while another is still open", () => {
    expect(decidePromotion(["IMPLEMENTING", "CANCELLED"])).toBe(
      "dependency.failed",
    );
  });

  it.each<TaskState>([
    "NEEDS_SPEC",
    "SPEC_IN_PROGRESS",
    "SPEC_REVIEW",
    "SPEC_APPROVED",
    "READY",
    "BLOCKED",
    "IMPLEMENTING",
    "REVIEWING",
    "CI_RUNNING",
    "READY_FOR_MERGE",
    "NEEDS_HUMAN",
  ])("leaves the task unchanged while a dependency is %s", (open) => {
    expect(decidePromotion(["DONE", open])).toBeNull();
  });
});
