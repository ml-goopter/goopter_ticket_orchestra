import type { Db } from "@orchestra/db";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import type { LogFields, Logger } from "../logger.js";
import type { TickContext } from "../tick.js";
import {
  PHASE_ORDER,
  WORKTREE_SWEEPER_EVERY_TICKS,
  createDefaultPhases,
} from "./index.js";

const records: Array<{ fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ fields, msg }),
  info: (fields, msg) => void records.push({ fields, msg }),
  warn: (fields, msg) => void records.push({ fields, msg }),
  error: (fields, msg) => void records.push({ fields, msg }),
  child: () => logger,
};

const ctx = (tick: number): TickContext => ({
  db: {} as Db,
  workerId: "w-1",
  config: loadConfig({ DATABASE_URL: "postgres://localhost/unused" }),
  now: new Date("2026-09-24T10:00:00.000Z"),
  tick,
  logger,
});

describe("default phase registry (design.md §6.1-§6.6)", () => {
  it("lists the scheduler phases in the order section 6 fixes", () => {
    expect(PHASE_ORDER).toEqual([
      "consume_commands",
      "promote_approved",
      "claim",
      "lease_sweeper",
      "worktree_sweeper",
    ]);
  });

  it("builds one phase per registry entry, in the same order", () => {
    expect(createDefaultPhases().map((p) => p.name)).toEqual([...PHASE_ORDER]);
  });

  it("runs the worktree sweeper hourly: 720 ticks at 5 seconds (§6.6)", () => {
    expect(WORKTREE_SWEEPER_EVERY_TICKS).toBe(720);
    expect(WORKTREE_SWEEPER_EVERY_TICKS * 5000).toBe(60 * 60 * 1000);

    const sweeper = createDefaultPhases().find(
      (p) => p.name === "worktree_sweeper",
    );
    expect(sweeper?.every).toBe(720);
  });

  it("runs every other phase on every tick (§6.5 sweeps each tick)", () => {
    for (const phase of createDefaultPhases()) {
      if (phase.name === "worktree_sweeper") continue;
      expect(phase.every ?? 1).toBe(1);
    }
  });

  it("returns a fresh array so a caller cannot mutate the registry", () => {
    expect(createDefaultPhases()).not.toBe(createDefaultPhases());
  });

  it("stubs resolve without touching the database and log their name", async () => {
    records.length = 0;
    const stubs = ["consume_commands", "lease_sweeper", "worktree_sweeper"];

    for (const phase of createDefaultPhases()) {
      if (!stubs.includes(phase.name)) continue;
      await expect(phase.run(ctx(1))).resolves.toBeUndefined();
    }

    expect(records.map((r) => r.fields.phase)).toEqual(stubs);
    expect(records.every((r) => r.fields.tick === 1)).toBe(true);
  });

  it("claim without an onClaimed handler never touches the database (G1)", async () => {
    const claim = createDefaultPhases({ runtimes: ["claude", "codex"] }).find(
      (p) => p.name === "claim",
    );
    // `db` is an empty object: any query would throw.
    await expect(claim!.run(ctx(1))).resolves.toBeUndefined();
  });
});
