import { getCosts, type CostGroup, type CostRow, type CostTotals } from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";

const CostsQuerySchema = z.object({
  group: z.enum(["project", "task", "runtime"]),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

function serializeTotals(totals: CostTotals) {
  return {
    cost_usd: totals.costUsd,
    input_tokens: totals.inputTokens,
    cached_input_tokens: totals.cachedInputTokens,
    output_tokens: totals.outputTokens,
    unpriced_rows: totals.unpricedRows,
  };
}

function serializeRow(row: CostRow) {
  return {
    key: row.key,
    cost_usd: row.costUsd,
    input_tokens: row.inputTokens,
    cached_input_tokens: row.cachedInputTokens,
    output_tokens: row.outputTokens,
    unpriced_rows: row.unpricedRows,
    by_kind: {
      main: serializeTotals(row.byKind.main),
      review: serializeTotals(row.byKind.review),
      resume: serializeTotals(row.byKind.resume),
    },
  };
}

/** design.md §12.5 `GET /costs?group=project|task|runtime&from=&to=`, §9.7. */
export default async function costsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/costs", async (request) => {
    const parsed = CostsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "group must be 'project', 'task', or 'runtime'; from/to must be ISO timestamps.",
      );
    }
    const { group, from, to } = parsed.data;

    const fromDate = from === undefined ? undefined : new Date(from);
    const toDate = to === undefined ? undefined : new Date(to);
    if (fromDate && toDate && fromDate > toDate) {
      throw new AppError(400, "VALIDATION_ERROR", "from must not be after to.");
    }

    const rows = await getCosts(app.db, {
      group: group as CostGroup,
      from: fromDate,
      to: toDate,
    });
    return rows.map(serializeRow);
  });
}
