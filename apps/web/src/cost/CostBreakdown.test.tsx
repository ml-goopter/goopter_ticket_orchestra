// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CostBreakdown } from "./CostBreakdown.js";

afterEach(cleanup);

describe("CostBreakdown", () => {
  it("shows a loading state before the breakdown resolves", () => {
    const request = vi.fn(() => new Promise<never>(() => {}));
    render(<CostBreakdown taskId="task-1" request={request} />);

    expect(screen.getByText("Loading costs...")).toBeTruthy();
  });

  it("renders main, review round, and resume rows with an estimated badge for claude", async () => {
    const request = vi.fn().mockResolvedValue({
      task_id: "task-1",
      executions: [
        {
          execution_id: "exec-1",
          role: "implementation",
          attempt: 1,
          runtime: "claude",
          estimated: true,
          usage: [
            {
              id: "u1",
              kind: "main",
              round: null,
              runtime: "claude",
              model: "claude-sonnet-5",
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 50,
              cost_usd: 1,
              recorded_at: "2026-02-01T00:00:00.000Z",
              estimated: true,
            },
            {
              id: "u2",
              kind: "review",
              round: 1,
              runtime: "claude",
              model: "claude-sonnet-5",
              input_tokens: 60,
              cached_input_tokens: 5,
              output_tokens: 20,
              cost_usd: 0.5,
              recorded_at: "2026-02-02T00:00:00.000Z",
              estimated: true,
            },
            {
              id: "u3",
              kind: "resume",
              round: null,
              runtime: "claude",
              model: "claude-sonnet-5",
              input_tokens: 30,
              cached_input_tokens: 0,
              output_tokens: 10,
              cost_usd: 0.25,
              recorded_at: "2026-02-03T00:00:00.000Z",
              estimated: true,
            },
          ],
          total: { cost_usd: 1.75, input_tokens: 190, cached_input_tokens: 15, output_tokens: 80, unpriced_rows: 0 },
        },
      ],
      total: { cost_usd: 1.75, input_tokens: 190, cached_input_tokens: 15, output_tokens: 80, unpriced_rows: 0 },
    });

    render(<CostBreakdown taskId="task-1" request={request} />);

    await waitFor(() => expect(screen.getByTestId("cost-breakdown")).toBeTruthy());
    expect(screen.getByText(/Main: \$1\.00/)).toBeTruthy();
    expect(screen.getByText(/Review round 1: \$0\.50/)).toBeTruthy();
    expect(screen.getByText(/Resume: \$0\.25/)).toBeTruthy();
    expect(screen.getAllByText("(estimated)").length).toBeGreaterThan(0);
    expect(screen.getByText(/Task total: \$1\.75/)).toBeTruthy();
  });

  it("shows a dash for a null cost_usd row and no estimated badge for codex", async () => {
    const request = vi.fn().mockResolvedValue({
      task_id: "task-1",
      executions: [
        {
          execution_id: "exec-1",
          role: "implementation",
          attempt: 1,
          runtime: "codex",
          estimated: false,
          usage: [
            {
              id: "u1",
              kind: "main",
              round: null,
              runtime: "codex",
              model: "gpt-5-codex-preview",
              input_tokens: 200,
              cached_input_tokens: 0,
              output_tokens: 100,
              cost_usd: null,
              recorded_at: "2026-03-01T00:00:00.000Z",
              estimated: false,
            },
          ],
          total: { cost_usd: 0, input_tokens: 200, cached_input_tokens: 0, output_tokens: 100, unpriced_rows: 1 },
        },
      ],
      total: { cost_usd: 0, input_tokens: 200, cached_input_tokens: 0, output_tokens: 100, unpriced_rows: 1 },
    });

    render(<CostBreakdown taskId="task-1" request={request} />);

    await waitFor(() => expect(screen.getByText(/Main: -/)).toBeTruthy());
    expect(screen.queryByText("(estimated)")).toBeNull();
  });

  it("shows a visible error, not a crash, when the request rejects", async () => {
    const request = vi.fn().mockRejectedValue(new Error("network down"));
    render(<CostBreakdown taskId="task-1" request={request} />);

    await waitFor(() => expect(screen.getByTestId("cost-breakdown-error").textContent).toBe("network down"));
  });

  it("shows a visible error, not a crash, when the response fails schema validation (e.g. an unconfigured test double)", async () => {
    const request = vi.fn();
    render(<CostBreakdown taskId="task-1" request={request} />);

    await waitFor(() => expect(screen.getByTestId("cost-breakdown-error")).toBeTruthy());
  });
});
