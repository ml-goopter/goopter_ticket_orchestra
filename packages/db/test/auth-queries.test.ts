import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DuplicateEmailError,
  deleteSession,
  findSessionWithUser,
  findUserByEmail,
  findUserById,
  insertSession,
  insertSessionIfEnabled,
  insertUser,
  setUserDisabledAt,
  touchSession,
  updateAdminUser,
} from "../src/queries/index.js";
import type { Db } from "../src/client.js";
import { sleep, startTestDb, type TestDb } from "./harness.js";

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
}, 120000);

afterAll(async () => {
  await h?.stop();
}, 120000);

describe("insertUser / findUserByEmail / findUserById (AC4)", () => {
  it("inserts a user and finds it by email and by id", async () => {
    const inserted = await insertUser(h.db, {
      email: "auth-a@example.com",
      passwordHash: "argon2id$stub-a",
      displayName: "Auth A",
    });
    expect(inserted.email).toBe("auth-a@example.com");

    const byEmail = await findUserByEmail(h.db, "auth-a@example.com");
    expect(byEmail).not.toBeNull();
    expect(byEmail!.id).toBe(inserted.id);
    expect(byEmail!.passwordHash).toBe("argon2id$stub-a");

    const byId = await findUserById(h.db, inserted.id);
    expect(byId).not.toBeNull();
    expect(byId!.email).toBe("auth-a@example.com");
  });

  it("returns null for an email that does not exist", async () => {
    const row = await findUserByEmail(h.db, "nobody@example.com");
    expect(row).toBeNull();
  });

  it("rejects a duplicate email with DuplicateEmailError", async () => {
    await insertUser(h.db, {
      email: "auth-dup@example.com",
      passwordHash: "argon2id$stub-dup-1",
      displayName: "First",
    });

    await expect(
      insertUser(h.db, {
        email: "auth-dup@example.com",
        passwordHash: "argon2id$stub-dup-2",
        displayName: "Second",
      }),
    ).rejects.toBeInstanceOf(DuplicateEmailError);
  });
});

describe("insertSession / findSessionWithUser / touchSession / deleteSession (AC4)", () => {
  it("inserts a session and finds it with its user", async () => {
    const user = await insertUser(h.db, {
      email: "auth-session@example.com",
      passwordHash: "argon2id$stub-session",
      displayName: "Session User",
    });
    const now = new Date("2026-01-01T00:00:00Z");
    const expiresAt = new Date(now.getTime() + 1000 * 60 * 60);

    const session = await insertSession(h.db, {
      userId: user.id,
      expiresAt,
      now,
    });

    const found = await findSessionWithUser(h.db, session.id);
    expect(found).not.toBeNull();
    expect(found!.session.id).toBe(session.id);
    expect(found!.session.expiresAt.getTime()).toBe(expiresAt.getTime());
    expect(found!.user.id).toBe(user.id);
    expect(found!.user.email).toBe("auth-session@example.com");
  });

  it("returns null for a non-UUID session id instead of throwing", async () => {
    await expect(
      findSessionWithUser(h.db, "not-a-uuid"),
    ).resolves.toBeNull();
  });

  it("returns null for a well-formed UUID that has no session", async () => {
    const found = await findSessionWithUser(
      h.db,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(found).toBeNull();
  });

  it("touchSession updates expires_at and last_seen_at", async () => {
    const user = await insertUser(h.db, {
      email: "auth-touch@example.com",
      passwordHash: "argon2id$stub-touch",
      displayName: "Touch User",
    });
    const now = new Date("2026-01-01T00:00:00Z");
    const session = await insertSession(h.db, {
      userId: user.id,
      expiresAt: new Date(now.getTime() + 1000),
      now,
    });

    const newExpiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24);
    const newLastSeenAt = new Date(now.getTime() + 1000 * 60);
    await touchSession(h.db, session.id, {
      expiresAt: newExpiresAt,
      lastSeenAt: newLastSeenAt,
    });

    const found = await findSessionWithUser(h.db, session.id);
    expect(found!.session.expiresAt.getTime()).toBe(newExpiresAt.getTime());
    expect(found!.session.lastSeenAt.getTime()).toBe(newLastSeenAt.getTime());
  });

  it("deleteSession removes the row", async () => {
    const user = await insertUser(h.db, {
      email: "auth-delete@example.com",
      passwordHash: "argon2id$stub-delete",
      displayName: "Delete User",
    });
    const now = new Date("2026-01-01T00:00:00Z");
    const session = await insertSession(h.db, {
      userId: user.id,
      expiresAt: new Date(now.getTime() + 1000),
      now,
    });

    await deleteSession(h.db, session.id);

    const found = await findSessionWithUser(h.db, session.id);
    expect(found).toBeNull();
  });
});

/**
 * Resolves once at least `n` backends are blocked waiting on a lock, so a
 * race test knows the second side has reached the contended row before
 * the first side is released.
 */
async function waitForLockWaiters(n: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await h.sql<{ count: number }[]>`
      select count(*)::int as count from pg_stat_activity
      where wait_event_type = 'Lock' and datname = current_database()
    `;
    if ((row?.count ?? 0) >= n) return;
    if (Date.now() > deadline) throw new Error("waitForLockWaiters timed out");
    await sleep(20);
  }
}

describe("insertSessionIfEnabled (GOT.61 F1)", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60);

  async function sessionCount(userId: string): Promise<number> {
    const [row] = await h.sql<{ count: number }[]>`
      select count(*)::int as count from sessions where user_id = ${userId}
    `;
    return row?.count ?? 0;
  }

  it("inserts a session for an enabled user", async () => {
    const user = await insertUser(h.db, {
      email: "sie-enabled@example.com",
      passwordHash: "argon2id$stub",
      displayName: "Enabled",
    });

    const session = await insertSessionIfEnabled(h.db, {
      userId: user.id,
      expiresAt,
      now,
    });

    expect(session).not.toBeNull();
    expect(await sessionCount(user.id)).toBe(1);
  });

  it("returns null and inserts nothing for a disabled user", async () => {
    const user = await insertUser(h.db, {
      email: "sie-disabled@example.com",
      passwordHash: "argon2id$stub",
      displayName: "Disabled",
    });
    await setUserDisabledAt(h.db, user.id, now);

    const session = await insertSessionIfEnabled(h.db, {
      userId: user.id,
      expiresAt,
      now,
    });

    expect(session).toBeNull();
    expect(await sessionCount(user.id)).toBe(0);
  });

  it("a session insert racing an uncommitted disable waits for it, then inserts nothing", async () => {
    await insertUser(h.db, {
      email: "sie-race1-other@example.com",
      passwordHash: "argon2id$stub",
      displayName: "Other",
    });
    const user = await insertUser(h.db, {
      email: "sie-race1@example.com",
      passwordHash: "argon2id$stub",
      displayName: "Target",
    });

    let disabled!: () => void;
    const disabledPromise = new Promise<void>((resolve) => (disabled = resolve));
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => (release = resolve));

    // The real disable, held open uncommitted: `updateAdminUser` runs in a
    // savepoint of this outer transaction, so its row locks stay held until
    // the barrier below releases the outer commit.
    const disableTx = h.db.transaction(async (tx) => {
      const result = await updateAdminUser(tx as unknown as Db, user.id, { disabled: true }, now);
      expect(result.status).toBe("ok");
      disabled();
      await releasePromise;
    });
    disableTx.catch(() => {});
    await disabledPromise;

    // A login that verified the password against the pre-disable row.
    const insert = insertSessionIfEnabled(h.db, { userId: user.id, expiresAt, now });
    insert.catch(() => {});
    await waitForLockWaiters(1);

    release();
    await disableTx;

    expect(await insert).toBeNull();
    expect(await sessionCount(user.id)).toBe(0);
  });

  it("a disable racing an uncommitted session insert waits for it, then deletes the session", async () => {
    await insertUser(h.db, {
      email: "sie-race2-other@example.com",
      passwordHash: "argon2id$stub",
      displayName: "Other",
    });
    const user = await insertUser(h.db, {
      email: "sie-race2@example.com",
      passwordHash: "argon2id$stub",
      displayName: "Target",
    });

    let inserted!: () => void;
    const insertedPromise = new Promise<void>((resolve) => (inserted = resolve));
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => (release = resolve));

    const loginTx = h.db.transaction(async (tx) => {
      const session = await insertSessionIfEnabled(tx as unknown as Db, {
        userId: user.id,
        expiresAt,
        now,
      });
      expect(session).not.toBeNull();
      inserted();
      await releasePromise;
    });
    loginTx.catch(() => {});
    await insertedPromise;

    const disable = updateAdminUser(h.db, user.id, { disabled: true }, now);
    disable.catch(() => {});
    await waitForLockWaiters(1);

    release();
    await loginTx;

    expect((await disable).status).toBe("ok");
    expect(await sessionCount(user.id)).toBe(0);
  });
});
