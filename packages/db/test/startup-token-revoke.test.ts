import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { revokeRunningSpecTokensOnHost } from "../src/queries/index.js";
import * as schema from "../src/schema/index.js";
import {
  seedExecution,
  seedFixtures,
  seedTask,
  startTestDb,
  type TestDb,
} from "./harness.js";

/**
 * GOT.82: the query behind worker startup's stale-token revocation. Scoped
 * to `host`, `role = "spec"`, `state = "RUNNING"` — never an implementation
 * execution, another host's row, or a non-RUNNING row.
 */

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
}, 120000);

afterAll(async () => {
  await h?.stop();
}, 120000);

async function setTokenHash(executionId: string, hash: string | null) {
  await h.db
    .update(schema.executions)
    .set({ toolsTokenHash: hash })
    .where(eq(schema.executions.id, executionId));
}

async function tokenHashOf(executionId: string): Promise<string | null> {
  const [row] = await h.db
    .select({ toolsTokenHash: schema.executions.toolsTokenHash })
    .from(schema.executions)
    .where(eq(schema.executions.id, executionId));
  return row?.toolsTokenHash ?? null;
}

async function setHost(executionId: string, host: string | null) {
  await h.db
    .update(schema.executions)
    .set({ host })
    .where(eq(schema.executions.id, executionId));
}

describe("revokeRunningSpecTokensOnHost (GOT.82)", () => {
  it("revokes this host's RUNNING spec execution's token and reports one revoked", async () => {
    const fixtures = await seedFixtures(h.db, "STR1");
    const taskId = await seedTask(h.db, fixtures, {
      jiraKey: "STR1-1",
      state: "IMPLEMENTING",
    });
    const specId = await seedExecution(h.db, taskId, {
      role: "spec",
      state: "RUNNING",
    });
    await setHost(specId, "str-host-1");
    await setTokenHash(specId, "deadbeef-str1");

    const revoked = await revokeRunningSpecTokensOnHost(h.db, "str-host-1");

    expect(revoked).toBe(1);
    expect(await tokenHashOf(specId)).toBeNull();
  });

  it("never touches a RUNNING spec execution on another host", async () => {
    const fixtures = await seedFixtures(h.db, "STR2");
    const taskId = await seedTask(h.db, fixtures, {
      jiraKey: "STR2-1",
      state: "IMPLEMENTING",
    });
    const specId = await seedExecution(h.db, taskId, {
      role: "spec",
      state: "RUNNING",
    });
    await setHost(specId, "str-host-2-other");
    await setTokenHash(specId, "deadbeef-str2");

    const revoked = await revokeRunningSpecTokensOnHost(h.db, "str-host-2");

    expect(revoked).toBe(0);
    expect(await tokenHashOf(specId)).toBe("deadbeef-str2");
  });

  it("never touches an implementation execution on this host, even RUNNING with a token", async () => {
    const fixtures = await seedFixtures(h.db, "STR3");
    const taskId = await seedTask(h.db, fixtures, {
      jiraKey: "STR3-1",
      state: "IMPLEMENTING",
    });
    const implId = await seedExecution(h.db, taskId, {
      role: "implementation",
      state: "RUNNING",
    });
    await setHost(implId, "str-host-3");
    await setTokenHash(implId, "deadbeef-str3");

    const revoked = await revokeRunningSpecTokensOnHost(h.db, "str-host-3");

    expect(revoked).toBe(0);
    expect(await tokenHashOf(implId)).toBe("deadbeef-str3");
  });

  it("never touches this host's spec execution in a non-RUNNING state", async () => {
    const fixtures = await seedFixtures(h.db, "STR4");
    const taskId = await seedTask(h.db, fixtures, {
      jiraKey: "STR4-1",
      state: "IMPLEMENTING",
    });
    const waitingId = await seedExecution(h.db, taskId, {
      role: "spec",
      state: "WAITING_FOR_USER",
    });
    const assignedId = await seedExecution(h.db, taskId, {
      role: "spec",
      state: "ASSIGNED",
      attempt: 2,
    });
    await setHost(waitingId, "str-host-4");
    await setHost(assignedId, "str-host-4");
    await setTokenHash(waitingId, "deadbeef-str4a");
    await setTokenHash(assignedId, "deadbeef-str4b");

    const revoked = await revokeRunningSpecTokensOnHost(h.db, "str-host-4");

    expect(revoked).toBe(0);
    expect(await tokenHashOf(waitingId)).toBe("deadbeef-str4a");
    expect(await tokenHashOf(assignedId)).toBe("deadbeef-str4b");
  });

  it("is a no-op, reporting zero, on a spec execution that already has no token", async () => {
    const fixtures = await seedFixtures(h.db, "STR5");
    const taskId = await seedTask(h.db, fixtures, {
      jiraKey: "STR5-1",
      state: "IMPLEMENTING",
    });
    const specId = await seedExecution(h.db, taskId, {
      role: "spec",
      state: "RUNNING",
    });
    await setHost(specId, "str-host-5");

    const revoked = await revokeRunningSpecTokensOnHost(h.db, "str-host-5");

    expect(revoked).toBe(0);
    expect(await tokenHashOf(specId)).toBeNull();
  });
});
