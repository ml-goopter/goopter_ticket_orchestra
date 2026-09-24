import { describe, expect, it } from "vitest";
import { EXECUTION_EVENT_TYPES } from "./events.js";

/**
 * design.md §9.6, hard-coded here (not read from the doc at runtime).
 */
const EXPECTED_EVENT_TYPES = [
  "execution.queued",
  "execution.assigned",
  "execution.started",
  "execution.resumed",
  "execution.heartbeat",
  "execution.waiting",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
  "worktree.prepared",
  "worktree.evicted",
  "agent.message.delta",
  "agent.message",
  "agent.tool_call",
  "agent.note",
  "spec.proposed",
  "spec.review_requested",
  "spec.approved",
  "spec.sent_back",
  "spec.revised",
  "issue.created",
  "issue.message",
  "issue.resolved",
  "review.started",
  "review.result",
  "pull_request.created",
  "ci.started",
  "ci.failed",
  "ci.passed",
  "pull_request.merged",
  "pull_request.closed",
  "task.state_changed",
  "usage.recorded",
];

describe("EXECUTION_EVENT_TYPES (design.md §9.6)", () => {
  it("contains exactly the §9.6 list, in full and nothing extra", () => {
    expect([...EXECUTION_EVENT_TYPES].sort()).toEqual(
      [...EXPECTED_EVENT_TYPES].sort(),
    );
  });

  it("includes task.state_changed and usage.recorded", () => {
    expect(EXECUTION_EVENT_TYPES).toContain("task.state_changed");
    expect(EXECUTION_EVENT_TYPES).toContain("usage.recorded");
  });
});
