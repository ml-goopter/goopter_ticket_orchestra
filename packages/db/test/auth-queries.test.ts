import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DuplicateEmailError,
  deleteSession,
  findSessionWithUser,
  findUserByEmail,
  findUserById,
  insertSession,
  insertUser,
  touchSession,
} from "../src/queries/index.js";
import { startTestDb, type TestDb } from "./harness.js";

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
