import { describe, expect, it } from "vitest";
import { SPEC_SYSTEM_PROMPT } from "./spec.js";

/**
 * GOT.90/GOT.100: `dependencies` must hold only Jira issue keys, so a bad
 * `propose_spec` call fails before the agent needs a second round-trip --
 * the prompt states the rule up front (design.md §4.3).
 */
describe("SPEC_SYSTEM_PROMPT dependencies rule (GOT.90/GOT.100)", () => {
  it("states dependencies holds only Jira issue keys of tasks this one depends on", () => {
    expect(SPEC_SYSTEM_PROMPT.toLowerCase()).toContain("jira issue key");
    expect(SPEC_SYSTEM_PROMPT.toLowerCase()).toContain("dependencies");
  });

  it("states the list is empty when there are none", () => {
    expect(SPEC_SYSTEM_PROMPT.toLowerCase()).toContain("empty when none");
  });

  it("tells the agent other blockers go in risks or a raised issue", () => {
    const lower = SPEC_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("risks");
    expect(lower).toMatch(/raised issue|raise_issue/);
  });
});
