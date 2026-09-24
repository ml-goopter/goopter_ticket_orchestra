import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { heartbeatWorker, upsertWorker } from "../src/queries/index.js";
import * as schema from "../src/schema/index.js";
import { startTestDb, type TestDb } from "./harness.js";

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
}, 120000);

afterAll(async () => {
  await h?.stop();
}, 120000);

const rowsFor = async (host: string) =>
  (await h.db.select().from(schema.agentWorkers)).filter(
    (r) => r.host === host,
  );

describe("upsertWorker (AC4)", () => {
  it("creates the row with the configured fields", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { id } = await upsertWorker(h.db, {
      host: "wrk-host-1",
      capabilities: ["node"],
      maxConcurrent: 2,
      workspaceRoot: "/srv/orchestra",
      now,
    });

    const rows = await rowsFor("wrk-host-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      host: "wrk-host-1",
      capabilities: ["node"],
      maxConcurrent: 2,
      workspaceRoot: "/srv/orchestra",
    });
  });

  it("keeps one row per host and updates fields on a second call", async () => {
    const first = await upsertWorker(h.db, {
      host: "wrk-host-2",
      capabilities: ["node"],
      maxConcurrent: 1,
      workspaceRoot: "/srv/a",
      now: new Date("2026-01-01T00:00:00Z"),
    });

    const second = await upsertWorker(h.db, {
      host: "wrk-host-2",
      capabilities: ["node", "odoo"],
      maxConcurrent: 5,
      workspaceRoot: "/srv/b",
      now: new Date("2026-01-02T00:00:00Z"),
    });

    expect(second.id).toBe(first.id);
    const rows = await rowsFor("wrk-host-2");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id,
      capabilities: ["node", "odoo"],
      maxConcurrent: 5,
      workspaceRoot: "/srv/b",
    });
  });
});

describe("heartbeatWorker (AC4)", () => {
  it("advances last_heartbeat_at", async () => {
    const registeredAt = new Date("2026-01-01T00:00:00Z");
    const { id } = await upsertWorker(h.db, {
      host: "wrk-host-3",
      capabilities: ["node"],
      maxConcurrent: 1,
      workspaceRoot: "/srv/orchestra",
      now: registeredAt,
    });

    const beatAt = new Date("2026-01-01T00:01:00Z");
    await heartbeatWorker(h.db, id, beatAt);

    const rows = await rowsFor("wrk-host-3");
    expect(rows[0]!.lastHeartbeatAt.getTime()).toBe(beatAt.getTime());
  });
});
