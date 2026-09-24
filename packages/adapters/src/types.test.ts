import { describe, expect, it } from "vitest";
import { AGENT_EVENT_TYPES } from "./types.js";
import {
  AGENT_EVENT_SAMPLES,
  RESUME_REQUEST_SAMPLE,
  START_REQUEST_SAMPLE,
  agentEventTypeOf,
} from "./types.contract.js";

describe("AgentEvent union (design.md §7)", () => {
  it("pins every member of the union", () => {
    expect([...AGENT_EVENT_TYPES].sort()).toEqual(
      [
        "error",
        "session",
        "text",
        "tool_call",
        "tool_result",
        "turn_done",
        "usage",
      ].sort(),
    );
  });

  it("has a compile-only fixture covering every member", () => {
    // `src/types.contract.ts` is part of `tsc -b` (tsconfig includes `src`),
    // so a union member added without a fixture fails the build, and the
    // exhaustive switch in `agentEventTypeOf` fails to narrow to `never`.
    expect(AGENT_EVENT_SAMPLES.map(agentEventTypeOf).sort()).toEqual(
      [...AGENT_EVENT_TYPES].sort(),
    );
  });

  it("gives each member exactly the fields design.md §7 specifies", () => {
    // The field-for-field assertions live in `src/types.contract.ts`, which
    // `tsc -b` compiles. They cannot live here: this file is excluded from
    // the build, so a type assertion in it is never checked by anything.
    // What is checkable at runtime is that the fixtures carry those fields.
    expect(
      AGENT_EVENT_SAMPLES.map((event) => Object.keys(event).sort()),
    ).toEqual([
      ["sessionId", "type"],
      ["delta", "type"],
      ["input", "name", "type"],
      ["name", "ok", "type"],
      ["cached", "input", "model", "output", "type"],
      ["finalText", "type"],
      ["message", "retriable", "type"],
    ]);
  });
});

describe("request samples (design.md §7)", () => {
  it("carries every StartRequest field", () => {
    expect(Object.keys(START_REQUEST_SAMPLE).sort()).toEqual(
      [
        "allowedTools",
        "cwd",
        "env",
        "maxBudgetUsd",
        "mcp",
        "model",
        "prompt",
        "systemPrompt",
      ].sort(),
    );
  });

  it("carries every ResumeRequest field and no system prompt", () => {
    expect(Object.keys(RESUME_REQUEST_SAMPLE).sort()).toEqual(
      [
        "allowedTools",
        "cwd",
        "env",
        "maxBudgetUsd",
        "mcp",
        "model",
        "prompt",
        "sessionId",
        "usageBaseline",
      ].sort(),
    );
    expect(RESUME_REQUEST_SAMPLE).not.toHaveProperty("systemPrompt");
  });
});
