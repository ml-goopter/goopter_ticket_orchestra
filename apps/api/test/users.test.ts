import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sessions, users } from "@orchestra/db";
import { createUser, DuplicateEmailError, WeakPasswordError } from "../src/lib/users.js";
import { buildTestApp, createClock, type TestDb, startTestDb } from "./harness.js";

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
