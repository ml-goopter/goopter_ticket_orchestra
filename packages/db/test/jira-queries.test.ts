import { TaskState } from "@orchestra/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listJiraWritebackEvents } from "../src/queries/jira.js";
import { transition } from "../src/transition.js";
import {
  seedFixtures,
  seedTask,
  startTestDb,
  type Fixtures,
  type TestDb,
} from "./harness.js";

/**
 * F4 regression (design.md §11.2, C51): `listJiraWritebackEvents` must
 * exclude a `task.state_changed` -> READY_FOR_MERGE event carrying the
 * `via: "merged_externally"` marker `markPullRequestMerged` stamps when a PR
 * was merged before CI finished, so Jira never gets told "CI passed" for a
 * task that was merged without CI ever passing. A normal READY_FOR_MERGE
 * event (no marker) and a NEEDS_HUMAN event must still come through.
 */
describe("listJiraWritebackEvents (F4, C51)", () => {
  let h: TestDb;
  let fx: Fixtures;

  beforeAll(async () => {
    h = await startTestDb();
    fx = await seedFixtures(h.db, "JIRA");
  }, 180000);

  afterAll(async () => {
    await h?.stop();
  });

  const actor = { kind: "worker" as const, id: "test-worker" };

  it("excludes the merged_externally marked event but keeps a normal READY_FOR_MERGE and a NEEDS_HUMAN event", async () => {
    const markedTaskId = await seedTask(h.db, fx, {
      jiraKey: "JIRA-1",
      state: TaskState.CI_RUNNING,
    });
    const normalTaskId = await seedTask(h.db, fx, {
      jiraKey: "JIRA-2",
      state: TaskState.CI_RUNNING,
    });
    const humanTaskId = await seedTask(h.db, fx, {
      jiraKey: "JIRA-3",
      state: TaskState.CI_RUNNING,
    });

    // The merged-externally path: `markPullRequestMerged` stamps this.
    const marked = await h.db.transaction((tx) =>
      transition(tx, {
        entity: "task",
        id: markedTaskId,
        trigger: "ci.passed",
        actor,
        eventPayload: { via: "merged_externally" },
      }),
    );

    // A normal CI pass: no marker.
    const normal = await h.db.transaction((tx) =>
      transition(tx, {
        entity: "task",
        id: normalTaskId,
        trigger: "ci.passed",
        actor,
      }),
    );

    const human = await h.db.transaction((tx) =>
      transition(tx, {
        entity: "task",
        id: humanTaskId,
        trigger: "task.escalated",
        actor,
      }),
    );

    const rows = await listJiraWritebackEvents(h.db, 0n);
    const ids = rows.map((r) => r.id);

    expect(ids).not.toContain(marked.eventId);
    expect(ids).toContain(normal.eventId);
    expect(ids).toContain(human.eventId);

    const normalRow = rows.find((r) => r.id === normal.eventId)!;
    expect(normalRow.jiraKey).toBe("JIRA-2");
    expect((normalRow.payload as { to: string }).to).toBe("READY_FOR_MERGE");

    const humanRow = rows.find((r) => r.id === human.eventId)!;
    expect(humanRow.jiraKey).toBe("JIRA-3");
    expect((humanRow.payload as { to: string }).to).toBe("NEEDS_HUMAN");
  });
});
