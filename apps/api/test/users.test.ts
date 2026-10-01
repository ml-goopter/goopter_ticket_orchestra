import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sessions, users } from "@orchestra/db";
import { createUser, DuplicateEmailError, WeakPasswordError } from "../src/lib/users.js";
import {
  buildTestApp,
  createClock,
  seedUser,
  startTestDb,
  type TestDb,
} from "./harness.js";

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const header = Array.isArray(setCookieHeader)
    ? setCookieHeader[0]
    : setCookieHeader;
  if (!header) throw new Error("no Set-Cookie header on response");
  const [pair] = header.split(";");
  return pair!;
}

describe("createUser (AC6)", () => {
  let testDb: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await testDb?.stop();
  }, 120000);

  afterEach(async () => {
    await testDb.db.delete(sessions);
    await testDb.db.delete(users);
  });

  it("creates a user who can then log in through the app with that password", async () => {
    const created = await createUser({
      db: testDb.db,
      email: "cli-user@example.com",
      password: "a very long password",
      displayName: "CLI User",
    });
    expect(created.email).toBe("cli-user@example.com");

    app = await buildTestApp(testDb, createClock());
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "cli-user@example.com",
        password: "a very long password",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: created.id,
      email: "cli-user@example.com",
      displayName: "CLI User",
    });
  });

  it("rejects a duplicate email", async () => {
    await createUser({
      db: testDb.db,
      email: "dup@example.com",
      password: "a very long password",
      displayName: "First",
    });

    await expect(
      createUser({
        db: testDb.db,
        email: "dup@example.com",
        password: "a different long password",
        displayName: "Second",
      }),
    ).rejects.toBeInstanceOf(DuplicateEmailError);
  });

  it("rejects a password shorter than 12 characters", async () => {
    await expect(
      createUser({
        db: testDb.db,
        email: "short-pw@example.com",
        password: "short11chr",
        displayName: "Short",
      }),
    ).rejects.toBeInstanceOf(WeakPasswordError);
  });
});

describe("PATCH /api/users/:id uuid handling (GOT.89 F2)", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await testDb?.stop();
  }, 120000);

  afterEach(async () => {
    await app?.close();
    await testDb.db.delete(sessions);
    await testDb.db.delete(users);
  });

  /** Builds the app, seeds one admin user, logs in, and returns the session cookie. */
  async function withAuthedApp(): Promise<FastifyInstance> {
    app = await buildTestApp(testDb, createClock());
    await seedUser(testDb.db, {
      email: "admin@example.com",
      password: "correct horse battery",
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "correct horse battery" },
    });
    cookie = extractCookie(loginRes.headers["set-cookie"]);
    return app;
  }

  it("rejects a malformed id with 400 and writes nothing (AC1)", async () => {
    const app = await withAuthedApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/users/not-a-uuid",
      headers: { cookie },
      payload: { disabled: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");

    const rows = await testDb.db.select().from(users);
    expect(rows.every((row) => row.disabledAt === null)).toBe(true);
  });

  it("disables another user identified by an uppercase UUID (AC2)", async () => {
    const app = await withAuthedApp();
    const target = await seedUser(testDb.db, {
      email: "target@example.com",
      password: "correct horse battery",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${target.id.toUpperCase()}`,
      headers: { cookie },
      payload: { disabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().disabled_at).not.toBeNull();
  });

  it("refuses to disable the caller's own account when the id is passed in uppercase, same as lowercase (AC2)", async () => {
    const app = await withAuthedApp();
    // A second enabled user so the refusal below can only be
    // CANNOT_DISABLE_SELF, never LAST_ENABLED_USER.
    await seedUser(testDb.db, {
      email: "other@example.com",
      password: "correct horse battery",
    });

    const meRes = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    const selfId: string = meRes.json().id;

    const lowerRes = await app.inject({
      method: "PATCH",
      url: `/api/users/${selfId}`,
      headers: { cookie },
      payload: { disabled: true },
    });
    expect(lowerRes.statusCode).toBe(409);
    expect(lowerRes.json().error.code).toBe("CANNOT_DISABLE_SELF");

    const upperRes = await app.inject({
      method: "PATCH",
      url: `/api/users/${selfId.toUpperCase()}`,
      headers: { cookie },
      payload: { disabled: true },
    });
    expect(upperRes.statusCode).toBe(409);
    expect(upperRes.json().error.code).toBe("CANNOT_DISABLE_SELF");

    const row = await testDb.db.select().from(users);
    expect(row.find((u) => u.id === selfId)?.disabledAt).toBeNull();
  });
});
