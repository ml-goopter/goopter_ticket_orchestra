import { describe, expect, it } from "vitest";
import { makeTimelineEvent } from "./fixtures.js";
import { buildTimelineItems, mergeTimelineEvents } from "./timelineItems.js";

describe("mergeTimelineEvents", () => {
  it("dedupes by id and sorts ascending", () => {
    const existing = [makeTimelineEvent({ id: 1 }), makeTimelineEvent({ id: 2 })];
    const incoming = [makeTimelineEvent({ id: 2 }), makeTimelineEvent({ id: 3 })];

    const merged = mergeTimelineEvents(existing, incoming);

    expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);
  });
});

describe("buildTimelineItems", () => {
  it("collapses agent.message.delta rows for one execution into one item, replaced by the final agent.message text (AC4)", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        executionId: "exec-1",
        type: "agent.message.delta",
        payload: { text: "Hello" },
      }),
      makeTimelineEvent({
        id: 2,
        executionId: "exec-1",
        type: "agent.message.delta",
        payload: { text: ", world" },
      }),
      makeTimelineEvent({
        id: 3,
        executionId: "exec-1",
        type: "agent.message",
        payload: { text: "Hello, world!" },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect(items[0]!.final).toBe(true);
    expect(items[0]!.text).toBe("Hello, world!");
  });

  it("keeps a delta-only message in progress (not yet final) when no agent.message has arrived", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        executionId: "exec-1",
        type: "agent.message.delta",
        payload: { text: "Hel" },
      }),
      makeTimelineEvent({
        id: 2,
        executionId: "exec-1",
        type: "agent.message.delta",
        payload: { text: "lo" },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items).toHaveLength(1);
    expect(items[0]!.final).toBe(false);
    expect(items[0]!.text).toBe("Hello");
  });

  it("starts a fresh message item for a second delta/message round on the same execution", () => {
    const events = [
      makeTimelineEvent({ id: 1, executionId: "exec-1", type: "agent.message.delta", payload: { text: "A" } }),
      makeTimelineEvent({ id: 2, executionId: "exec-1", type: "agent.message", payload: { text: "A" } }),
      makeTimelineEvent({ id: 3, executionId: "exec-1", type: "agent.message.delta", payload: { text: "B" } }),
      makeTimelineEvent({ id: 4, executionId: "exec-1", type: "agent.message", payload: { text: "B" } }),
    ];

    const items = buildTimelineItems(events);

    expect(items).toHaveLength(2);
    expect(items[0]!.text).toBe("A");
    expect(items[1]!.text).toBe("B");
  });

  it("renders agent.tool_call collapsed, with name and input", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        executionId: "exec-1",
        type: "agent.tool_call",
        payload: { name: "raise_issue", input: { title: "x" } },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("tool_call");
    expect(items[0]!.toolName).toBe("raise_issue");
    expect(items[0]!.toolInput).toEqual({ title: "x" });
  });

  it("renders task.state_changed with from and to", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        type: "task.state_changed",
        payload: { from: "READY", to: "IMPLEMENTING", trigger: "execution.assigned" },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("state_changed");
    expect(items[0]!.from).toBe("READY");
    expect(items[0]!.to).toBe("IMPLEMENTING");
  });

  it("renders any other event type with a compact payload summary", () => {
    const events = [
      makeTimelineEvent({ id: 1, type: "issue.created", payload: { issueId: "i1" } }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("generic");
    expect(items[0]!.summary).toContain("i1");
  });
});
