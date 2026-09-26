import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadPricing,
  priceUsage,
  PricingFileError,
  resetPricingWarnings,
  type PricingTable,
} from "../src/pricing/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("pricing (design.md §9.7, §15.3)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "orchestra-pricing-"));
    resetPricingWarnings();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writePricing(content: unknown): Promise<string> {
    const file = path.join(dir, "pricing.json");
    await writeFile(
      file,
      typeof content === "string" ? content : JSON.stringify(content),
      "utf8",
    );
    return file;
  }

  describe("loadPricing", () => {
    it("loads and validates the repo's config/pricing.json (AC1)", async () => {
      const repoRoot = path.resolve(__dirname, "..", "..", "..");
      const table = await loadPricing(
        path.join(repoRoot, "config", "pricing.json"),
      );
      expect(table["gpt-5-codex"]).toEqual({
        input: 1.25,
        cached_input: 0.125,
        output: 10.0,
      });
    });

    it("rejects a missing file", async () => {
      await expect(
        loadPricing(path.join(dir, "does-not-exist.json")),
      ).rejects.toThrow(PricingFileError);
    });

    it("rejects a file that is not valid JSON (AC1)", async () => {
      const file = await writePricing("{ not json");
      await expect(loadPricing(file)).rejects.toThrow(PricingFileError);
    });

    it("rejects a file whose shape does not match the pricing schema (AC1)", async () => {
      const file = await writePricing({
        "gpt-5-codex": { input: "cheap", cached_input: 0.125, output: 10.0 },
      });
      await expect(loadPricing(file)).rejects.toThrow(PricingFileError);
    });

    it("rejects a file missing a required rate", async () => {
      const file = await writePricing({
        "gpt-5-codex": { input: 1.25, output: 10.0 },
      });
      await expect(loadPricing(file)).rejects.toThrow(PricingFileError);
    });
  });

  describe("priceUsage", () => {
    const pricing: PricingTable = {
      "gpt-5-codex": { input: 1.25, cached_input: 0.125, output: 10.0 },
    };

    it("prices a known model to six decimals (AC1)", () => {
      const cost = priceUsage(pricing, {
        model: "gpt-5-codex",
        input: 100_000,
        cached: 40_000,
        output: 20_000,
      });
      // (100000/1e6)*1.25 + (40000/1e6)*0.125 + (20000/1e6)*10
      // = 0.125 + 0.005 + 0.2 = 0.33
      expect(cost).toBe(0.33);
    });

    it("rounds to the numeric(12,6) column scale", () => {
      // (1/1e6)*1.25 = 0.00000125, which rounds to 0.000001 at 6 decimals.
      const cost = priceUsage(pricing, {
        model: "gpt-5-codex",
        input: 1,
        cached: 0,
        output: 0,
      });
      expect(cost).toBe(0.000001);
    });

    it("returns null for an unknown model and warns once per model per process (AC1)", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const first = priceUsage(pricing, {
          model: "some-future-model",
          input: 100,
          cached: 0,
          output: 100,
        });
        const second = priceUsage(pricing, {
          model: "some-future-model",
          input: 200,
          cached: 0,
          output: 200,
        });
        expect(first).toBeNull();
        expect(second).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("warns again for a different unknown model", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        priceUsage(pricing, { model: "model-a", input: 1, cached: 0, output: 0 });
        priceUsage(pricing, { model: "model-b", input: 1, cached: 0, output: 0 });
        expect(warn).toHaveBeenCalledTimes(2);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
