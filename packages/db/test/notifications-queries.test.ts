import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertNotification } from "../src/queries/agent-tools.js";
import { clearReadyForMergeNotifications } from "../src/queries/notifications.js";
import {
  seedFixtures,
  seedTask,
  startTestDb,
  type Fixtures,
  type TestDb,
} from "./harness.js";

/**
 * GOT.U6: `clearReadyForMergeNotifications` marks a task's unread
 * `ready_for_merge` notifications read (design.md §4.2), the query
 * `markPullRequestMerged` (packages/db/src/queries/github.ts) runs in the
 * same transaction as its DONE transition.
 */

let h: TestDb;
let fx: Fixtures;

beforeAll(async () => {
  h = await startTestDb();
  fx = await seedFixtures(h.db, "NTQ");
}, 180000);

afterAll(async () => {
  await h?.stop();
});

let seq = 0;
const nextKey = () => `NTQ-${++seq}`;

const NOW = new Date("2026-09-28T10:00:00.000Z");

async function notificationsFor(taskId: string) {
  return h.db.query.notifications.findMany({
    where: (n, { eq }) => eq(n.taskId, taskId),
  });
}

describe("clearReadyForMergeNotifications", () => {
  it("marks an unread broadcast ready_for_merge notification read, leaves other kinds and other tasks alone", async () => {
    const taskId = await seedTask(h.db, fx, { jiraKey: nextKey(), state: "READY_FOR_MERGE" });
    const otherTaskId = await seedTask(h.db, fx, { jiraKey: nextKey(), state: "READY_FOR_MERGE" });

    const target = await insertNotification(h.db, {
      userId: null,
      taskId,
      kind: "ready_for_merge",
      title: "ready",
    });
    const blocking = await insertNotification(h.db, {
      userId: null,
      taskId,
      kind: "issue_raised",
      title: "blocking",
    });
    const otherTask = await insertNotification(h.db, {
      userId: null,
      taskId: otherTaskId,
      kind: "ready_for_merge",
      title: "ready elsewhere",
    });

    await h.db.transaction(async (tx) => {
      await clearReadyForMergeNotifications(tx, taskId, NOW);
    });

    const notes = await notificationsFor(taskId);
    const targetRow = notes.find((n) => n.id === target.id)!;
    const blockingRow = notes.find((n) => n.id === blocking.id)!;
    expect(targetRow.readAt?.toISOString()).toBe(NOW.toISOString());
    expect(blockingRow.readAt).toBeNull();

    const otherNotes = await notificationsFor(otherTaskId);
    expect(otherNotes.find((n) => n.id === otherTask.id)!.readAt).toBeNull();
  });

  it("leaves an already-read notification's original read_at untouched", async () => {
    const taskId = await seedTask(h.db, fx, { jiraKey: nextKey(), state: "READY_FOR_MERGE" });
    const originalReadAt = new Date("2026-09-01T00:00:00.000Z");
    const already = await insertNotification(h.db, {
      userId: null,
      taskId,
      kind: "ready_for_merge",
      title: "ready",
      readAt: originalReadAt,
    });

    await h.db.transaction(async (tx) => {
      await clearReadyForMergeNotifications(tx, taskId, NOW);
    });

    const notes = await notificationsFor(taskId);
    expect(notes.find((n) => n.id === already.id)!.readAt?.toISOString()).toBe(
      originalReadAt.toISOString(),
    );
  });

  it("is a no-op when the task has no ready_for_merge notification", async () => {
    const taskId = await seedTask(h.db, fx, { jiraKey: nextKey(), state: "READY_FOR_MERGE" });

    await h.db.transaction(async (tx) => {
      await clearReadyForMergeNotifications(tx, taskId, NOW);
    });

    expect(await notificationsFor(taskId)).toEqual([]);
  });
});
