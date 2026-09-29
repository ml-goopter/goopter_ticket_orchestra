import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteRepository, lockRepositoryById } from "../src/queries/index.js";
import * as schema from "../src/schema/index.js";
import { seedFixtures, seedTask, sleep, startTestDb, type TestDb } from "./harness.js";

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
}, 120000);

afterAll(async () => {
  await h?.stop();
});

/**
 * GOT.52 F2, kept by GOT.80 D2: `lockRepositoryById` locks the repository row
 * it resolves, the same lock `deleteRepository` takes before it counts
 * referencing tasks (design.md §12.3). Approval now resolves the task's own
 * (already locked-in) `repository_id` instead of a name, so these seed the
 * task with that repository up front and lock by id. These reproduce both
 * interleavings deterministically by holding one side's transaction open,
 * proving the fix rather than relying on scheduling luck.
 */
describe("lockRepositoryById vs deleteRepository (GOT.52 F2, GOT.80 D2)", () => {
  it("the approve-side lookup's lock wins: delete blocks, then sees the referencing task and blocks (never races past a delete)", async () => {
    const fx = await seedFixtures(h.db, "SPQ1");
    await seedTask(h.db, fx, {
      jiraKey: "SPQ1-1",
      state: "SPEC_REVIEW",
    });

    let lookupLocked!: () => void;
    const lookupLockedPromise = new Promise<void>((resolve) => {
      lookupLocked = resolve;
    });
    let releaseLookup!: () => void;
    const releaseLookupPromise = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });

    // Mirrors the approve route: lock the task's own repository by id.
    const lookupTxPromise = h.db.transaction(async (tx) => {
      await lockRepositoryById(tx, fx.repositoryId);
      lookupLocked();
      await releaseLookupPromise;
    });
    lookupTxPromise.catch(() => {});

    await lookupLockedPromise;

    let deleteSettled = false;
    const deletePromise = deleteRepository(h.db, fx.repositoryId).then((result) => {
      deleteSettled = true;
      return result;
    });
    deletePromise.catch(() => {});

    // deleteRepository's `SELECT ... FOR UPDATE` on the repository row
    // conflicts with the lookup's lock: it must still be pending.
    await sleep(200);
    expect(deleteSettled).toBe(false);

    releaseLookup();
    await lookupTxPromise;

    const result = await deletePromise;
    expect(result).toEqual({ status: "blocked", taskCount: 1 });
    expect(
      await h.db
        .select({ id: schema.repositories.id })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, fx.repositoryId)),
    ).toHaveLength(1);
  });

  it("delete's lock wins: the approve-side lookup blocks, then sees the repository gone instead of racing an FK violation into the caller", async () => {
    const fx = await seedFixtures(h.db, "SPQ2");

    let deleteLocked!: () => void;
    const deleteLockedPromise = new Promise<void>((resolve) => {
      deleteLocked = resolve;
    });
    let releaseDelete!: () => void;
    const releaseDeletePromise = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    const deleteTxPromise = h.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.repositories.id })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, fx.repositoryId))
        .for("update");
      deleteLocked();
      await releaseDeletePromise;
      await tx
        .delete(schema.repositories)
        .where(eq(schema.repositories.id, fx.repositoryId));
    });
    deleteTxPromise.catch(() => {});

    await deleteLockedPromise;

    let lookupSettled = false;
    const lookupPromise = h.db
      .transaction((tx) => lockRepositoryById(tx, fx.repositoryId))
      .then((result) => {
        lookupSettled = true;
        return result;
      });
    lookupPromise.catch(() => {});

    // The lookup's own `FOR UPDATE` conflicts with the delete transaction's
    // lock: it must still be pending while that transaction holds it.
    await sleep(200);
    expect(lookupSettled).toBe(false);

    releaseDelete();
    await deleteTxPromise;

    expect(await lookupPromise).toBeNull();
  });
});
