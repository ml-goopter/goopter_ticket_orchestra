import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  seedFixtures,
  seedTask,
  sleep,
  startTestDb,
  type Fixtures,
  type TestDb,
} from "../test/harness.js";
import { appendEvent, type NotifyPayload } from "./events.js";
import { LISTEN_APPLICATION_NAME, startListener } from "./listen.js";

let h: TestDb;
let fx: Fixtures;

beforeAll(async () => {
  h = await startTestDb();
  fx = await seedFixtures(h.db, "LSN");
}, 180000);

afterAll(async () => {
  await h?.stop();
});

async function waitFor(check: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(20);
  }
}

describe("startListener (design.md §12.6)", () => {
  it("signals once listening and delivers committed notify payloads", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "LSN-1",
      state: "IMPLEMENTING",
    });
    const received: NotifyPayload[] = [];
    let listens = 0;
    const listener = await startListener(h.connectionString, {
      onNotify: (payload) => received.push(payload),
      onListen: () => {
        listens += 1;
      },
    });
    try {
      expect(listens).toBe(1);

      const { id } = await h.db.transaction((tx) =>
        appendEvent(tx, { taskId, type: "task.state_changed", payload: {} }),
      );

      await waitFor(() => received.length === 1);
      expect(received[0]).toEqual({ task_id: taskId, event_id: Number(id) });
    } finally {
      await listener.close();
    }
  });

  it("never delivers a notify from a rolled-back transaction", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "LSN-2",
      state: "IMPLEMENTING",
    });
    const received: NotifyPayload[] = [];
    const listener = await startListener(h.connectionString, {
      onNotify: (payload) => received.push(payload),
      onListen: () => {},
    });
    try {
      await expect(
        h.db.transaction(async (tx) => {
          await appendEvent(tx, {
            taskId,
            type: "task.state_changed",
            payload: {},
          });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      const { id } = await h.db.transaction((tx) =>
        appendEvent(tx, { taskId, type: "task.state_changed", payload: {} }),
      );
      await waitFor(() => received.length >= 1);
      await sleep(100);
      expect(received).toEqual([{ task_id: taskId, event_id: Number(id) }]);
    } finally {
      await listener.close();
    }
  });

  it("re-listens and signals again after its connection is terminated", async () => {
    const taskId = await seedTask(h.db, fx, {
      jiraKey: "LSN-3",
      state: "IMPLEMENTING",
    });
    const received: NotifyPayload[] = [];
    let listens = 0;
    const listener = await startListener(h.connectionString, {
      onNotify: (payload) => received.push(payload),
      onListen: () => {
        listens += 1;
      },
    });
    try {
      const terminated = await h.sql<{ ok: boolean }[]>`
        select pg_terminate_backend(pid) as ok from pg_stat_activity
        where application_name = ${LISTEN_APPLICATION_NAME}
      `;
      expect(terminated).toHaveLength(1);

      await waitFor(() => listens === 2);

      const { id } = await h.db.transaction((tx) =>
        appendEvent(tx, { taskId, type: "task.state_changed", payload: {} }),
      );
      await waitFor(() => received.length === 1);
      expect(received[0]!.event_id).toBe(Number(id));
    } finally {
      await listener.close();
    }
  });

  it("close() resolves and releases the listen connection", async () => {
    const listener = await startListener(h.connectionString, {
      onNotify: () => {},
      onListen: () => {},
    });
    await listener.close();
    const deadline = Date.now() + 5000;
    let rows: unknown[];
    do {
      rows = await h.sql`
        select pid from pg_stat_activity
        where application_name = ${LISTEN_APPLICATION_NAME}
      `;
      if (rows.length === 0) break;
      await sleep(50);
    } while (Date.now() < deadline);
    expect(rows).toHaveLength(0);
  });

  it("rejects and releases its connection when the database is unreachable", async () => {
    await expect(
      startListener("postgres://nobody:nothing@127.0.0.1:1/none", {
        onNotify: () => {},
        onListen: () => {},
      }),
    ).rejects.toThrow();
  });
});
