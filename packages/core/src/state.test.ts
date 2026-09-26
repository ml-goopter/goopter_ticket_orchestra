import { describe, expect, it } from "vitest";
import { TaskState, ExecutionState } from "./enums.js";
import { resolveTransition, assertTransition, TransitionError } from "./state.js";

describe("resolveTransition: legal moves", () => {
  it("task READY -(task.claimed)-> IMPLEMENTING", () => {
    const result = resolveTransition("task", TaskState.READY, "task.claimed");
    expect(result).toEqual({ ok: true, to: TaskState.IMPLEMENTING });
  });

  it("execution QUEUED -(execution.assigned)-> ASSIGNED", () => {
    const result = resolveTransition(
      "execution",
      ExecutionState.QUEUED,
      "execution.assigned",
    );
    expect(result).toEqual({ ok: true, to: ExecutionState.ASSIGNED });
  });
});

describe("resolveTransition: documented illegal moves (design.md §5)", () => {
  it("task DONE -> CANCELLED is illegal", () => {
    const result = resolveTransition("task", TaskState.DONE, "task.cancelled");
    expect(result.ok).toBe(false);
  });

  it("task NEEDS_SPEC on task.claimed is illegal", () => {
    const result = resolveTransition("task", TaskState.NEEDS_SPEC, "task.claimed");
    expect(result.ok).toBe(false);
  });

  it("task READY on review.started is illegal", () => {
    const result = resolveTransition("task", TaskState.READY, "review.started");
    expect(result.ok).toBe(false);
  });

  // The two back edges, resume_with_ci_failure and execution.resumed (spec
  // send-back, GOT.37 C45), are pinned in transitions.test.ts.
  it("execution COMPLETED on any trigger other than its two back edges is illegal", () => {
    for (const trigger of [
      "execution.assigned",
      "execution.started",
      "execution.waiting",
      "execution.completed",
      "execution.failed",
      "execution.cancelled",
    ]) {
      const result = resolveTransition("execution", ExecutionState.COMPLETED, trigger);
      expect(result.ok).toBe(false);
    }
  });

  it("execution COMPLETED -> CANCELLED is illegal", () => {
    const result = resolveTransition(
      "execution",
      ExecutionState.COMPLETED,
      "execution.cancelled",
    );
    expect(result.ok).toBe(false);
  });

  it("execution FAILED on any trigger is illegal (terminal)", () => {
    for (const trigger of [
      "execution.assigned",
      "execution.started",
      "execution.waiting",
      "execution.resumed",
      "execution.completed",
      "execution.failed",
      "execution.cancelled",
      "resume_with_ci_failure",
    ]) {
      const result = resolveTransition("execution", ExecutionState.FAILED, trigger);
      expect(result.ok).toBe(false);
    }
  });

  it("execution QUEUED -> RUNNING directly is illegal", () => {
    const result = resolveTransition("execution", ExecutionState.QUEUED, "execution.started");
    expect(result.ok).toBe(false);
  });
});

describe("resolveTransition: error shape", () => {
  it("returns an ILLEGAL_TRANSITION error object with entity/from/trigger", () => {
    const result = resolveTransition("task", TaskState.DONE, "task.cancelled");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "ILLEGAL_TRANSITION",
        entity: "task",
        from: TaskState.DONE,
        trigger: "task.cancelled",
      });
    }
  });
});

describe("assertTransition", () => {
  it("returns the new state on a legal move", () => {
    expect(assertTransition("task", TaskState.READY, "task.claimed")).toBe(
      TaskState.IMPLEMENTING,
    );
  });

  it("throws TransitionError on an illegal move", () => {
    expect(() => assertTransition("task", TaskState.DONE, "task.cancelled")).toThrow(
      TransitionError,
    );
  });
});
