import { describe, expect, it } from "vitest";
import { makeTimelineEvent } from "./fixtures.js";
import { buildTimelineItems, groupTimelineItemsByDay, mergeTimelineEvents } from "./timelineItems.js";

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

  it("reads the tool name from payload.tool when payload.name is absent (AC2, the agent-tools server's actual shape)", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        executionId: "exec-1",
        type: "agent.tool_call",
        payload: { tool: "propose_spec", input: { version: 1 }, ok: true },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.toolName).toBe("propose_spec");
    expect(items[0]!.toolOk).toBe(true);
  });

  it("falls back to the literal 'tool' label when payload has neither name nor tool", () => {
    const events = [makeTimelineEvent({ id: 1, type: "agent.tool_call", payload: {} })];

    const items = buildTimelineItems(events);

    expect(items[0]!.toolName).toBe("tool");
  });

  it("carries the error line for a failed agent.tool_call", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        type: "agent.tool_call",
        payload: { tool: "raise_issue", input: {}, ok: false, error: "VALIDATION_FAILED" },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.toolOk).toBe(false);
    expect(items[0]!.toolError).toBe("VALIDATION_FAILED");
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

  it("renders an execution.* transition event the same way as task.state_changed", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        executionId: "exec-1",
        type: "execution.started",
        payload: { from: "ASSIGNED", to: "RUNNING", trigger: "execution.started" },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("state_changed");
    expect(items[0]!.from).toBe("ASSIGNED");
    expect(items[0]!.to).toBe("RUNNING");
  });

  it("renders a null from as null, not '?', for a transition event with no prior state (AC1)", () => {
    const events = [
      makeTimelineEvent({ id: 1, type: "task.state_changed", payload: { to: "NEEDS_SPEC" } }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.from).toBeNull();
    expect(items[0]!.to).toBe("NEEDS_SPEC");
  });

  it("does not treat execution.queued (no to) as a state_changed row", () => {
    const events = [
      makeTimelineEvent({ id: 1, type: "execution.queued", payload: { attempt: 2, retry_of: "exec-1" } }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("generic");
  });

  it("renders worktree.prepared with branch and path", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        type: "worktree.prepared",
        payload: { worktree_path: "/work/task-1", branch: "tsk-70" },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("worktree");
    expect(items[0]!.worktreeBranch).toBe("tsk-70");
    expect(items[0]!.worktreePath).toBe("/work/task-1");
  });

  it("renders a null branch for worktree.prepared when the payload omits it", () => {
    const events = [
      makeTimelineEvent({ id: 1, type: "worktree.prepared", payload: { worktree_path: "/work/task-1" } }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.worktreeBranch).toBeNull();
  });

  it("renders usage.recorded with model, tokens, cost and round", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        type: "usage.recorded",
        payload: {
          usage_id: "u1",
          kind: "review",
          round: 2,
          model: "claude-sonnet-5",
          input_tokens: 1000,
          cached_input_tokens: 100,
          output_tokens: 200,
          cost_usd: 0.5,
        },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("usage");
    expect(items[0]!.usageModel).toBe("claude-sonnet-5");
    expect(items[0]!.usageInputTokens).toBe(1000);
    expect(items[0]!.usageCachedTokens).toBe(100);
    expect(items[0]!.usageOutputTokens).toBe(200);
    expect(items[0]!.usageCostUsd).toBe(0.5);
    expect(items[0]!.usageRound).toBe(2);
  });

  it("renders review.started and review.result as review rounds", () => {
    const events = [
      makeTimelineEvent({ id: 1, type: "review.started", payload: { round: 1 } }),
      makeTimelineEvent({
        id: 2,
        type: "review.result",
        payload: { review_result_id: "rr1", round: 1, verdict: "findings", findings_count: 3 },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("review");
    expect(items[0]!.reviewRound).toBe(1);
    expect(items[1]!.reviewVerdict).toBe("findings");
    expect(items[1]!.reviewFindingsCount).toBe(3);
  });

  it("renders pull_request.created with number and url", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        type: "pull_request.created",
        payload: { pull_request_id: "pr-1", number: 42, url: "https://example.com/pr/42" },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("pull_request");
    expect(items[0]!.prNumber).toBe(42);
    expect(items[0]!.prUrl).toBe("https://example.com/pr/42");
  });

  it("renders ci.failed and pull_request.merged as readable outcomes", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        type: "ci.failed",
        payload: { round: 2, checks: [{ name: "test", url: "https://x" }] },
      }),
      makeTimelineEvent({ id: 2, type: "pull_request.merged", payload: { pull_request_id: "pr-1" } }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("outcome");
    expect(items[0]!.outcomeText).toContain("round 2");
    expect(items[0]!.outcomeText).toContain("1 check failed");
    expect(items[1]!.outcomeText).toBe("Pull request merged");
  });

  it("renders issue.created with title and blocking flag, and issue.resolved with a kind", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        type: "issue.created",
        payload: { issue_id: "issue-1", type: "QUESTION", severity: "blocking", blocking: true, title: "Pagination?" },
      }),
      makeTimelineEvent({
        id: 2,
        type: "issue.resolved",
        payload: { issue_id: "issue-1", decision_id: "d1", kind: "clarification", blocking: true },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("issue");
    expect(items[0]!.issueId).toBe("issue-1");
    expect(items[0]!.issueTitle).toBe("Pagination?");
    expect(items[0]!.issueBlocking).toBe(true);
    expect(items[1]!.issueKindLabel).toBe("clarification");
  });

  it("renders spec.proposed/revised/approved with a version and revision id", () => {
    const events = [
      makeTimelineEvent({ id: 1, type: "spec.proposed", payload: { revision_id: "rev-1", version: 1 } }),
      makeTimelineEvent({ id: 2, type: "spec.approved", payload: { revision_id: "rev-1", version: 1, runtime: "claude" } }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("spec_revision");
    expect(items[0]!.specVersion).toBe(1);
    expect(items[0]!.specRevisionId).toBe("rev-1");
    expect(items[1]!.kind).toBe("spec_revision");
  });

  it("renders an agent.message with no prior deltas for that execution as a complete message item (F2)", () => {
    const events = [
      makeTimelineEvent({
        id: 1,
        executionId: "exec-1",
        type: "agent.message",
        payload: { text: "Hi there" },
      }),
    ];

    const items = buildTimelineItems(events);

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect(items[0]!.final).toBe(true);
    expect(items[0]!.text).toBe("Hi there");
  });

  it("keeps deltas from two interleaved executions as separate in-progress items, each collapsed by its own final message (F2)", () => {
    const deltaEvents = [
      makeTimelineEvent({ id: 1, executionId: "exec-a", type: "agent.message.delta", payload: { text: "A1" } }),
      makeTimelineEvent({ id: 2, executionId: "exec-b", type: "agent.message.delta", payload: { text: "B1" } }),
      makeTimelineEvent({ id: 3, executionId: "exec-a", type: "agent.message.delta", payload: { text: "A2" } }),
      makeTimelineEvent({ id: 4, executionId: "exec-b", type: "agent.message.delta", payload: { text: "B2" } }),
    ];

    const inProgress = buildTimelineItems(deltaEvents);

    expect(inProgress).toHaveLength(2);
    expect(inProgress.every((item) => item.final === false)).toBe(true);
    expect(inProgress.find((item) => item.executionId === "exec-a")!.text).toBe("A1A2");
    expect(inProgress.find((item) => item.executionId === "exec-b")!.text).toBe("B1B2");

    const finalEvents = [
      ...deltaEvents,
      makeTimelineEvent({ id: 5, executionId: "exec-a", type: "agent.message", payload: { text: "A1A2!" } }),
      makeTimelineEvent({ id: 6, executionId: "exec-b", type: "agent.message", payload: { text: "B1B2!" } }),
    ];

    const items = buildTimelineItems(finalEvents);

    expect(items).toHaveLength(2);
    const a = items.find((item) => item.executionId === "exec-a")!;
    const b = items.find((item) => item.executionId === "exec-b")!;
    expect(a.final).toBe(true);
    expect(a.text).toBe("A1A2!");
    expect(b.final).toBe(true);
    expect(b.text).toBe("B1B2!");
  });

  it("renders any other event type generic, with the raw payload retained (not stringified) for a collapsed details block (AC1)", () => {
    const events = [
      makeTimelineEvent({ id: 1, type: "worktree.evicted", payload: { execution_id: "exec-1", branch: "tsk-70" } }),
    ];

    const items = buildTimelineItems(events);

    expect(items[0]!.kind).toBe("generic");
    expect(items[0]!.payload).toEqual({ execution_id: "exec-1", branch: "tsk-70" });
    expect(typeof items[0]!.payload).not.toBe("string");
  });
});

describe("groupTimelineItemsByDay", () => {
  /**
   * Every timestamp and `now` below is built from local `Date` field
   * constructors (`new Date(year, month, date, ...)`), never a fixed UTC
   * ISO literal: the grouping is defined in terms of the viewer's local
   * calendar day, so a test asserting it must vary with the runner's own
   * time zone the same way the component does, rather than assuming UTC
   * (AC11: timezone-independent).
   */
  it("orders items newest-first overall and within each group, and labels Today/Yesterday/an older formatted date (AC4)", () => {
    const now = new Date(2026, 5, 15, 12, 0, 0);
    const todayEarlier = new Date(2026, 5, 15, 9, 0, 0);
    const todayLater = new Date(2026, 5, 15, 10, 30, 0);
    const yesterday = new Date(2026, 5, 14, 18, 0, 0);
    const older = new Date(2026, 5, 1, 8, 0, 0);

    const events = [
      makeTimelineEvent({ id: 1, type: "issue.created", createdAt: older.toISOString() }),
      makeTimelineEvent({ id: 2, type: "issue.created", createdAt: yesterday.toISOString() }),
      makeTimelineEvent({ id: 3, type: "issue.created", createdAt: todayEarlier.toISOString() }),
      makeTimelineEvent({ id: 4, type: "issue.created", createdAt: todayLater.toISOString() }),
    ];

    const groups = groupTimelineItemsByDay(buildTimelineItems(events), now);

    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", "Jun 1, 2026"]);
    // Newest first within "Today": id 4 (10:30) before id 3 (09:00).
    expect(groups[0]!.items.map((item) => item.eventId)).toEqual([4, 3]);
    expect(groups[1]!.items.map((item) => item.eventId)).toEqual([2]);
    expect(groups[2]!.items.map((item) => item.eventId)).toEqual([1]);
  });

  it("puts a live item appended after an older one at the top of its day group (AC4 live SSE placement)", () => {
    const now = new Date(2026, 5, 15, 12, 0, 0);
    const earlier = new Date(2026, 5, 15, 9, 0, 0);
    const justArrived = new Date(2026, 5, 15, 11, 59, 0);

    // Ascending by id, as `mergeTimelineEvents` always keeps the list: the
    // live event is appended last even though both fall on "Today".
    const events = [
      makeTimelineEvent({ id: 1, type: "issue.created", createdAt: earlier.toISOString() }),
      makeTimelineEvent({ id: 2, type: "issue.created", createdAt: justArrived.toISOString() }),
    ];

    const groups = groupTimelineItemsByDay(buildTimelineItems(events), now);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Today");
    expect(groups[0]!.items.map((item) => item.eventId)).toEqual([2, 1]);
  });

  it("returns no groups for an empty item list", () => {
    expect(groupTimelineItemsByDay([])).toEqual([]);
  });
});
