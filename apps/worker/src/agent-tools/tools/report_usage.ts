import {
  addExecutionUsageTotals,
  appendEvent,
  insertExecutionUsage,
} from "@orchestra/db";
import { defineTool } from "../tool.js";

/**
 * design.md §9.7: `orchestra-review` runs report their own usage. Inserts an
 * `execution_usage` row whose runtime is the execution's, adds the tokens
 * and cost to the execution's totals, and writes `usage.recorded` (§9.6).
 * No state change.
 */
export const reportUsage = defineTool({
  name: "report_usage",
  description:
    "Record token usage and cost for a session run on behalf of this execution, such as an orchestra-review round. Returns the usage_id to pass to report_review_result.",
  async run({ tx, auth, now }, input) {
    // `numeric(12, 6)`: fixed notation so a tiny cost never reaches Postgres
    // in exponent form, rounded to the column's scale.
    const costUsd = input.cost_usd.toFixed(6);

    const usage = await insertExecutionUsage(tx, {
      executionId: auth.execution.id,
      kind: input.kind,
      round: input.round ?? null,
      runtime: auth.execution.runtime,
      model: input.model,
      inputTokens: input.input_tokens,
      cachedInputTokens: input.cached_input_tokens,
      outputTokens: input.output_tokens,
      costUsd,
      recordedAt: now,
    });

    await addExecutionUsageTotals(tx, auth.execution.id, {
      inputTokens: input.input_tokens,
      cachedInputTokens: input.cached_input_tokens,
      outputTokens: input.output_tokens,
      costUsd,
    });

    await appendEvent(tx, {
      taskId: auth.task.id,
      executionId: auth.execution.id,
      type: "usage.recorded",
      payload: {
        usage_id: usage.id,
        kind: input.kind,
        round: input.round ?? null,
        model: input.model,
        input_tokens: input.input_tokens,
        cached_input_tokens: input.cached_input_tokens,
        output_tokens: input.output_tokens,
        cost_usd: input.cost_usd,
      },
    });

    return { output: { usage_id: usage.id } };
  },
});
