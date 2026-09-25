import type { Db } from "@orchestra/db";
import { describe, expect, it } from "vitest";
import type { WorkerConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { LogFields, Logger } from "./logger.js";
import { createTickLoop, type Phase, type TickContext } from "./tick.js";

interface Recorded {
  level: "debug" | "info" | "warn" | "error";
  fields: LogFields;
  msg: string;
}

/** Collects structured records so tests can assert on fields, not strings. */
function recordingLogger(records: Recorded[] = []): Logger & {
  records: Recorded[];
} {
  const at = (level: Recorded["level"]) => (fields: LogFields, msg: string) => {
    records.push({ level, fields, msg });
  };
  const logger: Logger & { records: Recorded[] } = {
    records,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: () => logger,
  };
  return logger;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const config: WorkerConfig = loadConfig({
  DATABASE_URL: "postgres://localhost:5432/unused",
  WORKER_HOST: "test-host",
});

/** The loop never touches `db`; the phases it runs do. */
const db = {} as Db;

function build(phases: Phase[], overrides: Partial<{
  intervalMs: number;
  onError: (err: unknown, phase: string, tick: number) => void;
  now: () => Date;
}> = {}) {
  const logger = recordingLogger();
  const loop = createTickLoop({
    db,
    workerId: "worker-1",
    config,
    phases,
    logger,
    ...overrides,
  });
  return { loop, logger };
}

describe("createTickLoop (design.md §6)", () => {
  it("runs phases in registration order with tick numbers 1 then 2", async () => {
    const seen: string[] = [];
    const record = (name: string): Phase => ({
      name,
      run: async (ctx: TickContext) => {
        seen.push(`${name}@${ctx.tick}`);
      },
    });
    const { loop } = build([record("a"), record("b"), record("c")]);

    await loop.runOnce();
    await loop.runOnce();

    expect(seen).toEqual([
      "a@1",
      "b@1",
      "c@1",
      "a@2",
      "b@2",
      "c@2",
    ]);
  });

  it("hands each phase the db, workerId, config and a tick timestamp", async () => {
    const seen: TickContext[] = [];
    const now = new Date("2026-09-24T10:00:00.000Z");
    const { loop } = build(
      [{ name: "capture", run: async (ctx) => void seen.push(ctx) }],
      { now: () => now },
    );

    await loop.runOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.db).toBe(db);
    expect(seen[0]!.workerId).toBe("worker-1");
    expect(seen[0]!.config).toBe(config);
    expect(seen[0]!.now).toEqual(now);
    expect(seen[0]!.tick).toBe(1);
  });

  it("runs an `every: 2` phase on tick 2 only", async () => {
    const ticks: number[] = [];
    const { loop } = build([
      { name: "always", run: async () => {} },
      { name: "sometimes", every: 2, run: async (ctx) => void ticks.push(ctx.tick) },
    ]);

    await loop.runOnce();
    await loop.runOnce();
    await loop.runOnce();
    await loop.runOnce();

    expect(ticks).toEqual([2, 4]);
  });

  it("runs an `every: 720` phase on the 720th tick (hourly at 5s)", async () => {
    const ticks: number[] = [];
    const { loop } = build([
      { name: "hourly", every: 720, run: async (ctx) => void ticks.push(ctx.tick) },
    ]);

    for (let i = 0; i < 720; i += 1) await loop.runOnce();

    expect(ticks).toEqual([720]);
  });

  it("reports a throwing phase through onError with its name and tick", async () => {
    const errors: Array<{ phase: string; tick: number; message: string }> = [];
    const boom = new Error("phase exploded");
    const after: string[] = [];
    const { loop, logger } = build(
      [
        { name: "first", run: async () => {} },
        { name: "explodes", run: async () => { throw boom; } },
        { name: "third", run: async () => void after.push("third") },
      ],
      {
        onError: (err, phase, tick) =>
          void errors.push({ phase, tick, message: (err as Error).message }),
      },
    );

    await loop.runOnce();

    expect(errors).toEqual([
      { phase: "explodes", tick: 1, message: "phase exploded" },
    ]);
    expect(after).toEqual(["third"]);
    const logged = logger.records.find((r) => r.level === "error");
    expect(logged?.fields.phase).toBe("explodes");
    expect(logged?.fields.tick).toBe(1);
  });

  it("keeps ticking after a phase throws", async () => {
    let calls = 0;
    const { loop } = build([
      { name: "explodes", run: async () => { calls += 1; throw new Error("nope"); } },
    ]);

    await loop.runOnce();
    await loop.runOnce();

    expect(calls).toBe(2);
  });

  it("survives an onError that throws: the next phase and the next tick still run", async () => {
    const ran: string[] = [];
    let onErrorCalls = 0;
    const { loop } = build(
      [
        {
          name: "explodes",
          run: async (ctx) => {
            ran.push(`explodes@${ctx.tick}`);
            throw new Error("phase exploded");
          },
        },
        { name: "after", run: async (ctx) => void ran.push(`after@${ctx.tick}`) },
      ],
      {
        onError: () => {
          onErrorCalls += 1;
          throw new Error("onError exploded");
        },
      },
    );

    await expect(loop.runOnce()).resolves.toBeUndefined();
    await expect(loop.runOnce()).resolves.toBeUndefined();

    expect(onErrorCalls).toBe(2);
    expect(ran).toEqual(["explodes@1", "after@1", "explodes@2", "after@2"]);
    expect(loop.tick).toBe(2);
  });

  it("survives a phase that throws with no onError registered", async () => {
    const { loop } = build([
      { name: "explodes", run: async () => { throw new Error("nope"); } },
      { name: "after", run: async () => {} },
    ]);

    await expect(loop.runOnce()).resolves.toBeUndefined();
  });

  it("never overlaps ticks when one overruns the interval", async () => {
    let live = 0;
    let maxLive = 0;
    let completed = 0;
    const { loop, logger } = build(
      [
        {
          name: "slow",
          run: async () => {
            live += 1;
            maxLive = Math.max(maxLive, live);
            await sleep(60);
            live -= 1;
            completed += 1;
          },
        },
      ],
      { intervalMs: 10 },
    );

    loop.start();
    await sleep(200);
    await loop.stop();

    expect(maxLive).toBe(1);
    expect(completed).toBeGreaterThanOrEqual(1);
    const skipped = logger.records.filter((r) => r.msg.includes("skip"));
    expect(skipped.length).toBeGreaterThan(0);
  });

  it("does not advance the tick counter for a skipped tick", async () => {
    const ticks: number[] = [];
    const { loop } = build(
      [
        {
          name: "slow",
          run: async (ctx) => {
            ticks.push(ctx.tick);
            await sleep(60);
          },
        },
      ],
      { intervalMs: 10 },
    );

    loop.start();
    await sleep(200);
    await loop.stop();

    expect(ticks).toEqual(Array.from(ticks, (_, i) => i + 1));
  });

  it("stop() resolves only after the in-flight tick finishes", async () => {
    let finished = false;
    const { loop } = build(
      [
        {
          name: "slow",
          run: async () => {
            await sleep(80);
            finished = true;
          },
        },
      ],
      { intervalMs: 5 },
    );

    loop.start();
    await sleep(30);
    expect(finished).toBe(false);

    await loop.stop();

    expect(finished).toBe(true);
  });

  it("runs no further ticks after stop()", async () => {
    let calls = 0;
    const { loop } = build([{ name: "count", run: async () => void (calls += 1) }], {
      intervalMs: 10,
    });

    loop.start();
    await sleep(55);
    await loop.stop();
    const atStop = calls;
    await sleep(60);

    expect(calls).toBe(atStop);
    expect(atStop).toBeGreaterThan(0);
  });

  it("start() twice does not double the tick rate", async () => {
    let calls = 0;
    const { loop } = build([{ name: "count", run: async () => void (calls += 1) }], {
      intervalMs: 20,
    });

    loop.start();
    loop.start();
    await sleep(110);
    await loop.stop();

    expect(calls).toBeLessThanOrEqual(6);
  });

  it("stop() before start() resolves", async () => {
    const { loop } = build([{ name: "noop", run: async () => {} }]);
    await expect(loop.stop()).resolves.toBeUndefined();
  });

  it("rejects a phase list with duplicate names", () => {
    expect(() =>
      createTickLoop({
        db,
        workerId: "worker-1",
        config,
        logger: recordingLogger(),
        phases: [
          { name: "dup", run: async () => {} },
          { name: "dup", run: async () => {} },
        ],
      }),
    ).toThrow(/dup/);
  });

  it("rejects an `every` below 1", () => {
    expect(() =>
      createTickLoop({
        db,
        workerId: "worker-1",
        config,
        logger: recordingLogger(),
        phases: [{ name: "bad", every: 0, run: async () => {} }],
      }),
    ).toThrow(/bad/);
  });
});
