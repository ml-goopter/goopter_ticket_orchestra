import { agentWorkers, type Db } from "@orchestra/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type WorkerConfig } from "../src/config.js";
import { startHeartbeat } from "../src/heartbeat.js";
import type { LogFields, Logger } from "../src/logger.js";
import { createDefaultPhases, PHASE_ORDER } from "../src/phases/index.js";
import { registerWorker } from "../src/registration.js";
import { createTickLoop } from "../src/tick.js";
import { sleep, startTestDb, waitFor, type TestDb } from "./harness.js";

const records: Array<{ fields: LogFields; msg: string }> = [];
const logger: Logger = {
  debug: (fields, msg) => void records.push({ fields, msg }),
  info: (fields, msg) => void records.push({ fields, msg }),
  warn: (fields, msg) => void records.push({ fields, msg }),
  error: (fields, msg) => void records.push({ fields, msg }),
  child: () => logger,
};

let testDb: TestDb;
let db: Db;

const configFor = (
  host: string,
  overrides: Record<string, string> = {},
): WorkerConfig =>
  loadConfig({
    DATABASE_URL: testDb.connectionString,
    WORKER_HOST: host,
    ...overrides,
  });

const rowsFor = async (host: string) =>
  (await db.select().from(agentWorkers)).filter((r) => r.host === host);

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
});

afterAll(async () => {
  await testDb?.stop();
});

describe("registerWorker (design.md §4.2 agent_workers)", () => {
  it("creates the row with the configured fields", async () => {
    const config = configFor("reg-host-1", {
      WORKER_CAPABILITIES: "node, odoo",
      WORKER_MAX_CONCURRENT: "3",
      WORKER_WORKSPACE_ROOT: "/srv/orchestra",
    });

    const workerId = await registerWorker(db, config);

    const rows = await rowsFor("reg-host-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: workerId,
      host: "reg-host-1",
      capabilities: ["node", "odoo"],
      maxConcurrent: 3,
      workspaceRoot: "/srv/orchestra",
    });
    expect(rows[0]!.startedAt).toBeInstanceOf(Date);
    expect(rows[0]!.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it("is idempotent on restart: same host updates the same row", async () => {
    const first = await registerWorker(
      db,
      configFor("reg-host-2", { WORKER_CAPABILITIES: "node" }),
    );
    const second = await registerWorker(
      db,
      configFor("reg-host-2", {
        WORKER_CAPABILITIES: "node, odoo",
        WORKER_MAX_CONCURRENT: "5",
      }),
    );

    expect(second).toBe(first);
    const rows = await rowsFor("reg-host-2");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first,
      capabilities: ["node", "odoo"],
      maxConcurrent: 5,
    });
  });

  it("refreshes started_at and last_heartbeat_at on re-registration", async () => {
    const config = configFor("reg-host-3");
    const past = new Date("2026-01-01T00:00:00.000Z");

    await registerWorker(db, config, past);
    const before = (await rowsFor("reg-host-3"))[0]!;
    expect(before.startedAt.getTime()).toBe(past.getTime());

    await registerWorker(db, config);
    const after = (await rowsFor("reg-host-3"))[0]!;

    expect(after.id).toBe(before.id);
    expect(after.startedAt.getTime()).toBeGreaterThan(before.startedAt.getTime());
    expect(after.lastHeartbeatAt.getTime()).toBeGreaterThan(
      before.lastHeartbeatAt.getTime(),
    );
  });

  it("keeps one row per host across two hosts", async () => {
    await registerWorker(db, configFor("reg-host-4a"));
    await registerWorker(db, configFor("reg-host-4b"));

    expect(await rowsFor("reg-host-4a")).toHaveLength(1);
    expect(await rowsFor("reg-host-4b")).toHaveLength(1);
  });
});

describe("startHeartbeat (design.md §6.4)", () => {
  it("advances last_heartbeat_at across two beats and stops on stop()", async () => {
    const workerId = await registerWorker(
      db,
      configFor("beat-host-1"),
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const beatAt = async () => (await rowsFor("beat-host-1"))[0]!.lastHeartbeatAt;
    const registered = await beatAt();

    const stop = startHeartbeat(db, workerId, { intervalMs: 40, logger });

    const first = await waitFor(async () => {
      const at = await beatAt();
      return at.getTime() > registered.getTime() ? at : undefined;
    }, { what: "first beat" });

    const second = await waitFor(async () => {
      const at = await beatAt();
      return at.getTime() > first.getTime() ? at : undefined;
    }, { what: "second beat" });

    expect(second.getTime()).toBeGreaterThan(first.getTime());

    await stop();
    const atStop = await beatAt();
    await sleep(200);

    expect((await beatAt()).getTime()).toBe(atStop.getTime());
  });

  it("invokes the renewLeases hook on the same cadence (§6.4)", async () => {
    const workerId = await registerWorker(db, configFor("beat-host-2"));
    let renewals = 0;

    const stop = startHeartbeat(db, workerId, {
      intervalMs: 30,
      logger,
      renewLeases: async () => void (renewals += 1),
    });

    await waitFor(async () => (renewals >= 2 ? renewals : undefined), {
      what: "two lease renewals",
    });
    await stop();

    const atStop = renewals;
    await sleep(150);
    expect(renewals).toBe(atStop);
  });

  it("keeps beating when renewLeases throws", async () => {
    const workerId = await registerWorker(db, configFor("beat-host-3"));
    const beatAt = async () => (await rowsFor("beat-host-3"))[0]!.lastHeartbeatAt;
    const registered = await beatAt();
    let attempts = 0;

    const stop = startHeartbeat(db, workerId, {
      intervalMs: 30,
      logger,
      renewLeases: async () => {
        attempts += 1;
        throw new Error("renewal exploded");
      },
    });

    await waitFor(
      async () => {
        const at = await beatAt();
        return attempts >= 2 && at.getTime() > registered.getTime()
          ? at
          : undefined;
      },
      { what: "a beat despite a throwing renewal" },
    );
    await stop();

    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it("stop() is safe to call twice", async () => {
    const workerId = await registerWorker(db, configFor("beat-host-4"));
    const stop = startHeartbeat(db, workerId, { intervalMs: 5000, logger });
    await stop();
    await expect(stop()).resolves.toBeUndefined();
  });
});

describe("tick loop with the real phase registry (design.md §6)", () => {
  it("runs the section 6 phases in order, twice, against the database", async () => {
    const config = configFor("tick-host-1");
    const workerId = await registerWorker(db, config);
    const seen: Array<{ phase: string; tick: number }> = [];

    const phases = createDefaultPhases().map((phase) => ({
      ...phase,
      run: async (ctx: Parameters<typeof phase.run>[0]) => {
        await phase.run(ctx);
        seen.push({ phase: phase.name, tick: ctx.tick });
      },
    }));

    const loop = createTickLoop({ db, workerId, config, phases, logger });

    await loop.runOnce();
    await loop.runOnce();

    // Every phase but the hourly worktree sweeper runs on both ticks.
    const everyTick = PHASE_ORDER.filter((n) => n !== "worktree_sweeper");
    expect(seen).toEqual([
      ...everyTick.map((phase) => ({ phase, tick: 1 })),
      ...everyTick.map((phase) => ({ phase, tick: 2 })),
    ]);
  });
});
