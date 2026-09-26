import fs from "node:fs/promises";
import { z } from "zod";

/**
 * design.md §9.7: `config/pricing.json` (`PRICING_FILE`, §15.3), USD per
 * million tokens, maintained by hand. Example row:
 * `{ "gpt-5-codex": { "input": 1.25, "cached_input": 0.125, "output": 10.0 } }`.
 */
const ModelPricingSchema = z.object({
  input: z.number().nonnegative(),
  cached_input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});

const PricingFileSchema = z.record(z.string(), ModelPricingSchema);

export type ModelPricing = z.infer<typeof ModelPricingSchema>;
export type PricingTable = z.infer<typeof PricingFileSchema>;

/** Thrown by `loadPricing` for a missing, unreadable, or malformed file. */
export class PricingFileError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Invalid pricing file at ${path}: ${detail}`);
    this.name = "PricingFileError";
    this.path = path;
  }
}

/**
 * Reads and validates `PRICING_FILE` (design.md §15.3, §9.7). Throws
 * `PricingFileError` for anything short of a valid `{ model: { input,
 * cached_input, output } }` map, so a bad deploy fails loudly at startup
 * rather than silently pricing every model as unknown.
 */
export async function loadPricing(path: string): Promise<PricingTable> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    throw new PricingFileError(
      path,
      err instanceof Error ? err.message : String(err),
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new PricingFileError(
      path,
      `not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const parsed = PricingFileSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new PricingFileError(path, detail);
  }
  return parsed.data;
}

export interface UsageToPrice {
  model: string;
  input: number;
  cached: number;
  output: number;
}

/**
 * Models we have already warned about, so a busy process logs once per
 * model rather than once per usage row (design.md §9.7: "logs a warning
 * rather than failing the execution").
 */
const warnedUnknownModels = new Set<string>();

/** Test-only: lets each test start from a clean warning state. */
export function resetPricingWarnings(): void {
  warnedUnknownModels.clear();
}

/**
 * Prices one usage row against the loaded table (design.md §9.7). Returns
 * `null`, and warns once per unknown model for the life of the process,
 * rather than failing the execution.
 */
export function priceUsage(
  pricing: PricingTable,
  usage: UsageToPrice,
): number | null {
  const rate = pricing[usage.model];
  if (!rate) {
    if (!warnedUnknownModels.has(usage.model)) {
      warnedUnknownModels.add(usage.model);
      console.warn(
        `orchestra: no pricing entry for model "${usage.model}"; recording cost_usd = NULL (design.md §9.7).`,
      );
    }
    return null;
  }

  const cost =
    (usage.input / 1_000_000) * rate.input +
    (usage.cached / 1_000_000) * rate.cached_input +
    (usage.output / 1_000_000) * rate.output;

  // `numeric(12, 6)` is the column's scale (design.md §4.2); round here so
  // callers get the same value they will read back from Postgres.
  return Math.round(cost * 1e6) / 1e6;
}
