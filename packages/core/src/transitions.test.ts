import { describe, expect, it } from "vitest";
import { TaskState, ExecutionState } from "./enums.js";
import { TRANSITIONS } from "./transitions.js";
import { resolveTransition } from "./state.js";

/**
 * §5.1 and §5.2 edges, hard-coded here (not derived from the table under
 * test) so this test fails if `transitions.ts` drifts from the design doc.
 */
const EXPECTED_EDGES: {
  entity: "task" | "execution";
  from: string;
  trigger: string;
  to: string;
}[] = [
  // --- Task machine (§5.1) ---
  { entity: "task", from: "NEEDS_SPEC", trigger: "spec.session_started", to: "SPEC_IN_PROGRESS" },
  { entity: "task", from: "SPEC_IN_PROGRESS", trigger: "spec.review_requested", to: "SPEC_REVIEW" },
  { entity: "task", from: "SPEC_REVIEW", trigger: "spec.sent_back", to: "SPEC_IN_PROGRESS" },
  { entity: "task", from: "SPEC_REVIEW", trigger: "spec.approved", to: "SPEC_APPROVED" },
  { entity: "task", from: "SPEC_APPROVED", trigger: "dependency.satisfied", to: "READY" },
  { entity: "task", from: "SPEC_APPROVED", trigger: "dependency.failed", to: "BLOCKED" },
  { entity: "task", from: "SPEC_APPROVED", trigger: "spec.approved", to: "IMPLEMENTING" },
  { entity: "task", from: "READY", trigger: "task.claimed", to: "IMPLEMENTING" },
  { entity: "task", from: "IMPLEMENTING", trigger: "review.started", to: "REVIEWING" },
  { entity: "task", from: "REVIEWING", trigger: "review.findings", to: "IMPLEMENTING" },
  { entity: "task", from: "REVIEWING", trigger: "pull_request.created", to: "CI_RUNNING" },
  { entity: "task", from: "CI_RUNNING", trigger: "ci.failed", to: "IMPLEMENTING" },
  { entity: "task", from: "CI_RUNNING", trigger: "ci.passed", to: "READY_FOR_MERGE" },
  { entity: "task", from: "READY_FOR_MERGE", trigger: "pull_request.merged", to: "DONE" },
  { entity: "task", from: "IMPLEMENTING", trigger: "issue.resolved.spec_revision", to: "SPEC_IN_PROGRESS" },
  { entity: "task", from: "REVIEWING", trigger: "issue.resolved.spec_revision", to: "SPEC_IN_PROGRESS" },
  { entity: "task", from: "NEEDS_HUMAN", trigger: "human.retry", to: "READY" },
  { entity: "task", from: "NEEDS_HUMAN", trigger: "task.cancelled", to: "CANCELLED" },
  { entity: "task", from: "READY_FOR_MERGE", trigger: "pull_request.closed", to: "NEEDS_HUMAN" },
  { entity: "task", from: "BLOCKED", trigger: "dependency.resolved", to: "READY" },
  // three NEEDS_HUMAN edges
  { entity: "task", from: "IMPLEMENTING", trigger: "task.escalated", to: "NEEDS_HUMAN" },
  { entity: "task", from: "REVIEWING", trigger: "task.escalated", to: "NEEDS_HUMAN" },
  { entity: "task", from: "CI_RUNNING", trigger: "task.escalated", to: "NEEDS_HUMAN" },
  // at least three cancel edges (any state except DONE -> CANCELLED)
  { entity: "task", from: "NEEDS_SPEC", trigger: "task.cancelled", to: "CANCELLED" },
  { entity: "task", from: "READY", trigger: "task.cancelled", to: "CANCELLED" },
  { entity: "task", from: "IMPLEMENTING", trigger: "task.cancelled", to: "CANCELLED" },

  // --- Execution machine (§5.2) ---
  { entity: "execution", from: "QUEUED", trigger: "execution.assigned", to: "ASSIGNED" },
  { entity: "execution", from: "ASSIGNED", trigger: "execution.started", to: "RUNNING" },
  { entity: "execution", from: "RUNNING", trigger: "execution.waiting", to: "WAITING_FOR_USER" },
  { entity: "execution", from: "WAITING_FOR_USER", trigger: "execution.resumed", to: "RUNNING" },
  { entity: "execution", from: "RUNNING", trigger: "execution.completed", to: "COMPLETED" },
  { entity: "execution", from: "RUNNING", trigger: "execution.failed", to: "FAILED" },
  // GOT.31 (user decision O1): a failure before the session starts
  // (setup_failed, early adapter error, agent_hung, §6.5 lease_expired).
  { entity: "execution", from: "ASSIGNED", trigger: "execution.failed", to: "FAILED" },
  { entity: "execution", from: "QUEUED", trigger: "execution.cancelled", to: "CANCELLED" },
  { entity: "execution", from: "ASSIGNED", trigger: "execution.cancelled", to: "CANCELLED" },
  { entity: "execution", from: "RUNNING", trigger: "execution.cancelled", to: "CANCELLED" },
  { entity: "execution", from: "WAITING_FOR_USER", trigger: "execution.cancelled", to: "CANCELLED" },
  // the backward edges (§5.2 prose): CI feedback, and a spec sent back (GOT.37 C45)
  { entity: "execution", from: "COMPLETED", trigger: "resume_with_ci_failure", to: "RUNNING" },
  { entity: "execution", from: "COMPLETED", trigger: "execution.resumed", to: "RUNNING" },
];

describe("TRANSITIONS covers every §5.1/§5.2 edge", () => {
  it.each(EXPECTED_EDGES)(
    "$entity $from -($trigger)-> $to exists in the table",
    ({ entity, from, trigger, to }) => {
      const row = TRANSITIONS.find(
        (r) => r.entity === entity && r.from === from && r.trigger === trigger,
      );
      expect(row).toBeDefined();
      expect(row?.to).toBe(to);
    },
  );

  it("includes the COMPLETED -> RUNNING backward edge", () => {
    expect(
      TRANSITIONS.some(
        (r) =>
          r.entity === "execution" &&
          r.from === "COMPLETED" &&
          r.trigger === "resume_with_ci_failure" &&
          r.to === "RUNNING",
      ),
    ).toBe(true);
  });

  it("includes the spec send-back COMPLETED -> RUNNING edge on execution.resumed (GOT.37 C45)", () => {
    expect(resolveTransition("execution", "COMPLETED", "execution.resumed")).toEqual({
      ok: true,
      to: "RUNNING",
    });
  });

  it("COMPLETED has exactly the two back edges to RUNNING", () => {
    const fromCompleted = TRANSITIONS.filter(
      (r) => r.entity === "execution" && r.from === "COMPLETED",
    ).map((r) => `${r.trigger}->${r.to}`);
    expect(fromCompleted.sort()).toEqual([
      "execution.resumed->RUNNING",
      "resume_with_ci_failure->RUNNING",
    ]);
  });

  it("includes SPEC_APPROVED -> IMPLEMENTING (approve with paused execution)", () => {
    expect(
      TRANSITIONS.some(
        (r) =>
          r.entity === "task" &&
          r.from === "SPEC_APPROVED" &&
          r.trigger === "spec.approved" &&
          r.to === "IMPLEMENTING",
      ),
    ).toBe(true);
  });
});

describe("every row of TRANSITIONS resolves via resolveTransition", () => {
  it("resolves ok for every task row", () => {
    for (const row of TRANSITIONS.filter((r) => r.entity === "task")) {
      const result = resolveTransition("task", row.from as TaskState, row.trigger);
      expect(result).toEqual({ ok: true, to: row.to });
    }
  });

  it("resolves ok for every execution row", () => {
    for (const row of TRANSITIONS.filter((r) => r.entity === "execution")) {
      const result = resolveTransition(
        "execution",
        row.from as ExecutionState,
        row.trigger,
      );
      expect(result).toEqual({ ok: true, to: row.to });
    }
  });
});

describe("spec.revise edges (design.md §12.3 POST /spec/revise)", () => {
  it.each([
    ["SPEC_APPROVED", "SPEC_IN_PROGRESS"],
    ["READY", "SPEC_IN_PROGRESS"],
  ] as const)("task %s -(spec.revise)-> %s", (from, to) => {
    expect(resolveTransition("task", from, "spec.revise")).toEqual({
      ok: true,
      to,
    });
  });

  it("no other task state accepts spec.revise", () => {
    const accepting = Object.values(TaskState).filter(
      (from) => resolveTransition("task", from, "spec.revise").ok,
    );
    expect(accepting.sort()).toEqual(["READY", "SPEC_APPROVED"]);
  });

  it("no execution state accepts spec.revise", () => {
    for (const from of Object.values(ExecutionState)) {
      expect(resolveTransition("execution", from, "spec.revise").ok).toBe(
        false,
      );
    }
  });
});

describe("no duplicate (entity, from, trigger) keys", () => {
  it("every key is unique", () => {
    const keys = TRANSITIONS.map((r) => `${r.entity}:${r.from}:${r.trigger}`);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});
