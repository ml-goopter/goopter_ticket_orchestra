import { EXECUTION_EVENT_TYPES } from "@orchestra/core";
import { describe, expect, it } from "vitest";
import { EVENT_FAMILIES, familyOf } from "./eventFamilies.js";

describe("familyOf", () => {
  it("assigns every execution event type to exactly one known family", () => {
    for (const type of EXECUTION_EVENT_TYPES) {
      const family = familyOf(type);
      expect(family).not.toBeNull();
      expect(EVENT_FAMILIES).toContain(family);
    }
  });

  it("groups state: execution.*, task.state_changed, worktree.*", () => {
    expect(familyOf("execution.started")).toBe("state");
    expect(familyOf("task.state_changed")).toBe("state");
    expect(familyOf("worktree.prepared")).toBe("state");
  });

  it("groups agent: agent.*", () => {
    expect(familyOf("agent.message")).toBe("agent");
    expect(familyOf("agent.message.delta")).toBe("agent");
    expect(familyOf("agent.tool_call")).toBe("agent");
  });

  it("groups issues: issue.*", () => {
    expect(familyOf("issue.created")).toBe("issues");
    expect(familyOf("issue.resolved")).toBe("issues");
  });

  it("groups review: review.*, spec.*", () => {
    expect(familyOf("review.result")).toBe("review");
    expect(familyOf("spec.approved")).toBe("review");
  });

  it("groups pr_ci: pull_request.*, ci.*", () => {
    expect(familyOf("pull_request.created")).toBe("pr_ci");
    expect(familyOf("ci.passed")).toBe("pr_ci");
  });

  it("returns null for an unknown type", () => {
    expect(familyOf("bogus.type")).toBeNull();
  });
});
