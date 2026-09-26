import { describe, expect, it, vi } from "vitest";
import { createCostsApi } from "./costs.js";

describe("createCostsApi", () => {
  it("getCosts() builds the query string from group/from/to and maps rows to camelCase", async () => {
    const request = vi.fn().mockResolvedValue([
      {
        key: { id: "p1", label: "Proj 1" },
        cost_usd: 1.75,
        input_tokens: 190,
        cached_input_tokens: 15,
        output_tokens: 80,
        unpriced_rows: 0,
        by_kind: {
          main: { cost_usd: 1, input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, unpriced_rows: 0 },
          review: { cost_usd: 0.5, input_tokens: 60, cached_input_tokens: 5, output_tokens: 20, unpriced_rows: 0 },
          resume: { cost_usd: 0.25, input_tokens: 30, cached_input_tokens: 0, output_tokens: 10, unpriced_rows: 0 },
        },
      },
    ]);

    const api = createCostsApi(request);
    const rows = await api.getCosts({ group: "project", from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" });

    expect(request).toHaveBeenCalledWith(
      "GET",
      "/costs?group=project&from=2026-01-01T00%3A00%3A00.000Z&to=2026-02-01T00%3A00%3A00.000Z",
    );
    expect(rows).toEqual([
      {
        key: { id: "p1", label: "Proj 1" },
        costUsd: 1.75,
        inputTokens: 190,
        cachedInputTokens: 15,
        outputTokens: 80,
        unpricedRows: 0,
        byKind: {
          main: { costUsd: 1, inputTokens: 100, cachedInputTokens: 10, outputTokens: 50, unpricedRows: 0 },
          review: { costUsd: 0.5, inputTokens: 60, cachedInputTokens: 5, outputTokens: 20, unpricedRows: 0 },
          resume: { costUsd: 0.25, inputTokens: 30, cachedInputTokens: 0, outputTokens: 10, unpricedRows: 0 },
        },
      },
    ]);
  });

  it("getCosts() omits from/to from the query string when not supplied", async () => {
    const request = vi.fn().mockResolvedValue([]);
    const api = createCostsApi(request);

    await api.getCosts({ group: "runtime" });

    expect(request).toHaveBeenCalledWith("GET", "/costs?group=runtime");
  });

  it("getCosts() throws when the response fails schema validation", async () => {
    const request = vi.fn().mockResolvedValue([{ nope: true }]);
    const api = createCostsApi(request);

    await expect(api.getCosts({ group: "project" })).rejects.toThrow();
  });

  it("getTaskCosts() maps the per-execution breakdown to camelCase, preserving null cost_usd and estimated flags", async () => {
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
          total: {
            cost_usd: 0,
            input_tokens: 200,
            cached_input_tokens: 0,
            output_tokens: 100,
            unpriced_rows: 1,
          },
        },
      ],
      total: { cost_usd: 0, input_tokens: 200, cached_input_tokens: 0, output_tokens: 100, unpriced_rows: 1 },
    });

    const api = createCostsApi(request);
    const breakdown = await api.getTaskCosts("task-1");

    expect(request).toHaveBeenCalledWith("GET", "/tasks/task-1/costs");
    expect(breakdown.taskId).toBe("task-1");
    expect(breakdown.total).toEqual({
      costUsd: 0,
      inputTokens: 200,
      cachedInputTokens: 0,
      outputTokens: 100,
      unpricedRows: 1,
    });
    expect(breakdown.executions[0]!.executionId).toBe("exec-1");
    expect(breakdown.executions[0]!.usage[0]!.costUsd).toBeNull();
    expect(breakdown.executions[0]!.usage[0]!.estimated).toBe(false);
  });

  it("getTaskCosts() throws when the response fails schema validation", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const api = createCostsApi(request);

    await expect(api.getTaskCosts("task-1")).rejects.toThrow();
  });
});
