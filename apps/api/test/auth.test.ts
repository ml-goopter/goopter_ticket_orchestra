import {
  findSessionWithUser,
  listSessionsForUser,
  sessions,
  setUserDisabledAt,
  users,
} from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type Clock,
  type TestDb,
  buildTestApp,
  createClock,
  seedSession,
  seedUser,
  sessionCookieHeader,
  startTestDb,
} from "./harness.js";

// Wraps the real `verifyPassword` so R5's tests can assert it is called
// exactly once per login attempt (including unknown-email and
// disabled-user cases) and inspect the digest it was called with, without
// changing its behaviour.
vi.mock("../src/lib/passwords.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/passwords.js")>();
  return {
    ...actual,
    verifyPassword: vi.fn(actual.verifyPassword),
  };
});

import { PASSWORD_HASH_OPTIONS, verifyPassword } from "../src/lib/passwords.js";

function extractCookie(setCookieHeader: string | string[] | undefined): {
  raw: string;
} {
  const header = Array.isArray(setCookieHeader)
    ? setCookieHeader[0]
    : setCookieHeader;
  if (!header) throw new Error("no Set-Cookie header on response");
  const [pair] = header.split(";");
  const value = pair!.split("=").slice(1).join("=");
  return { raw: `${pair!.split("=")[0]}=${value}` };
}

describe("auth", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  let clock: Clock;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 120000);

  afterAll(async () => {
    await testDb?.stop();
  }, 120000);

  afterEach(async () => {
    await app?.close();
    await testDb.db.delete(sessions);
    await testDb.db.delete(users);
  });

  async function withApp(): Promise<FastifyInstance> {
    clock = createClock(new Date("2026-01-01T00:00:00Z"));
    app = await buildTestApp(testDb, clock);
    return app;
  }

  it("GET /api/health returns 200 without a cookie", async () => {
    const app = await withApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects an unauthenticated request to a protected route", async () => {
    const app = await withApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  describe("login round trip", () => {
    it("logs in, reads /me, then logs out (AC1)", async () => {
      const app = await withApp();
      const user = await seedUser(testDb.db, {
        email: "alice@example.com",
        password: "correct horse battery",
      });

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "alice@example.com", password: "correct horse battery" },
      });
      expect(loginRes.statusCode).toBe(200);
      expect(loginRes.json()).toEqual({
        id: user.id,
        email: "alice@example.com",
        displayName: user.displayName,
      });

      const cookie = extractCookie(loginRes.headers["set-cookie"]);

      const meRes = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: cookie.raw },
      });
      expect(meRes.statusCode).toBe(200);
      expect(meRes.json()).toEqual({
        id: user.id,
        email: "alice@example.com",
        displayName: user.displayName,
      });

      const sessionRowsBefore = await listSessionsForUser(
        testDb.db,
        user.id,
      );
      expect(sessionRowsBefore).toHaveLength(1);

      const logoutRes = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie: cookie.raw },
      });
      expect(logoutRes.statusCode).toBe(200);

      const meAfterLogout = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: cookie.raw },
      });
      expect(meAfterLogout.statusCode).toBe(401);

      const sessionRowsAfter = await listSessionsForUser(testDb.db, user.id);
      expect(sessionRowsAfter).toHaveLength(0);
    });
  });

  describe("invalid credentials (AC2)", () => {
    it("wrong password and unknown email return the same 401 body", async () => {
      const app = await withApp();
      await seedUser(testDb.db, {
        email: "bob@example.com",
        password: "correct horse battery",
      });

      const wrongPasswordRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "bob@example.com", password: "wrong password" },
      });
      const unknownEmailRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "nobody@example.com", password: "irrelevant" },
      });

      expect(wrongPasswordRes.statusCode).toBe(401);
      expect(unknownEmailRes.statusCode).toBe(401);
      expect(wrongPasswordRes.json()).toEqual(unknownEmailRes.json());
    });

    it("rejects login for a disabled user", async () => {
      const app = await withApp();
      await seedUser(testDb.db, {
        email: "disabled@example.com",
        password: "correct horse battery",
        disabled: true,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "disabled@example.com",
          password: "correct horse battery",
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects an existing session once the user is disabled", async () => {
      const app = await withApp();
      const user = await seedUser(testDb.db, {
        email: "soon-disabled@example.com",
        password: "correct horse battery",
      });

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "soon-disabled@example.com",
          password: "correct horse battery",
        },
      });
      const cookie = extractCookie(loginRes.headers["set-cookie"]);

      await setUserDisabledAt(testDb.db, user.id, clock.now());

      const meRes = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: cookie.raw },
      });
      expect(meRes.statusCode).toBe(401);
    });
  });

  describe("argon2 verification path (R5)", () => {
    function parseArgon2Params(encoded: string) {
      const paramsSection = encoded.match(/\$argon2id\$v=\d+\$([^$]+)\$/)?.[1];
      if (!paramsSection) {
        throw new Error(`unparseable argon2 digest: ${encoded}`);
      }
      const params = Object.fromEntries(
        paramsSection.split(",").map((pair) => pair.split("=")),
      );
      return {
        memoryCost: Number(params.m),
        timeCost: Number(params.t),
        parallelism: Number(params.p),
      };
    }

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("runs verifyPassword exactly once against a hash matching PASSWORD_HASH_OPTIONS for an unknown email", async () => {
      const app = await withApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "nobody@example.com", password: "irrelevant" },
      });

      expect(res.statusCode).toBe(401);
      expect(verifyPassword).toHaveBeenCalledTimes(1);
      const [digest] = vi.mocked(verifyPassword).mock.calls[0]!;
      expect(parseArgon2Params(digest)).toEqual({
        memoryCost: PASSWORD_HASH_OPTIONS.memoryCost,
        timeCost: PASSWORD_HASH_OPTIONS.timeCost,
        parallelism: PASSWORD_HASH_OPTIONS.parallelism,
      });
    });

    it("runs verifyPassword exactly once against the same dummy hash for a disabled user, even with the correct password", async () => {
      const app = await withApp();
      await seedUser(testDb.db, {
        email: "disabled-r5@example.com",
        password: "correct horse battery",
        disabled: true,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "disabled-r5@example.com",
          password: "correct horse battery",
        },
      });

      expect(res.statusCode).toBe(401);
      expect(verifyPassword).toHaveBeenCalledTimes(1);
      const [digest] = vi.mocked(verifyPassword).mock.calls[0]!;
      expect(parseArgon2Params(digest)).toEqual({
        memoryCost: PASSWORD_HASH_OPTIONS.memoryCost,
        timeCost: PASSWORD_HASH_OPTIONS.timeCost,
        parallelism: PASSWORD_HASH_OPTIONS.parallelism,
      });

      // Same cached dummy hash as the unknown-email case, not the user's
      // own (disabled) password hash: proves the disabled path takes the
      // identical branch rather than happening to also match parameters.
      const unknownEmailRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "nobody-2@example.com", password: "irrelevant" },
      });
      expect(unknownEmailRes.statusCode).toBe(401);
      const [unknownDigest] = vi.mocked(verifyPassword).mock.calls[1]!;
      expect(unknownDigest).toBe(digest);
    });

    it("runs verifyPassword exactly once for a wrong password on an existing user", async () => {
      const app = await withApp();
      await seedUser(testDb.db, {
        email: "wrongpw-r5@example.com",
        password: "correct horse battery",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "wrongpw-r5@example.com", password: "wrong password" },
      });

      expect(res.statusCode).toBe(401);
      expect(verifyPassword).toHaveBeenCalledTimes(1);
    });

    it("runs verifyPassword exactly once for a correct password", async () => {
      const app = await withApp();
      await seedUser(testDb.db, {
        email: "rightpw-r5@example.com",
        password: "correct horse battery",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "rightpw-r5@example.com",
          password: "correct horse battery",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(verifyPassword).toHaveBeenCalledTimes(1);
    });
  });

  describe("session expiry and refresh (AC3)", () => {
    it("rejects an expired session", async () => {
      const app = await withApp();
      const user = await seedUser(testDb.db, {
        email: "expired@example.com",
        password: "correct horse battery",
      });
      const sessionId = await seedSession(testDb.db, {
        userId: user.id,
        expiresAt: new Date(clock.now().getTime() - 1000),
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: sessionCookieHeader(sessionId) },
      });
      expect(res.statusCode).toBe(401);
    });

    it("extends expires_at on a request more than a minute after last seen", async () => {
      const app = await withApp();
      const user = await seedUser(testDb.db, {
        email: "refresh@example.com",
        password: "correct horse battery",
      });
      const originalExpiresAt = new Date(
        clock.now().getTime() + 10 * 24 * 60 * 60 * 1000,
      );
      const sessionId = await seedSession(testDb.db, {
        userId: user.id,
        expiresAt: originalExpiresAt,
        lastSeenAt: clock.now(),
      });

      clock.advance(2 * 60 * 1000);

      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: sessionCookieHeader(sessionId) },
      });
      expect(res.statusCode).toBe(200);

      const sessionWithUser = await findSessionWithUser(
        testDb.db,
        sessionId,
      );
      const row = sessionWithUser?.session;
      expect(row!.expiresAt.getTime()).toBeGreaterThan(
        originalExpiresAt.getTime(),
      );
      expect(row!.lastSeenAt.getTime()).toBe(clock.now().getTime());
    });
  });

  describe("rate limiting (AC4)", () => {
    it("returns 429 on the 11th login attempt from one IP within a minute", async () => {
      const app = await withApp();
      await seedUser(testDb.db, {
        email: "ratelimited@example.com",
        password: "correct horse battery",
      });

      const attempt = () =>
        app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: "10.0.0.1",
          payload: {
            email: "ratelimited@example.com",
            password: "wrong password",
          },
        });

      let lastStatus = 0;
      for (let i = 0; i < 10; i++) {
        const res = await attempt();
        lastStatus = res.statusCode;
      }
      expect(lastStatus).toBe(401);

      const eleventh = await attempt();
      expect(eleventh.statusCode).toBe(429);

      const otherIpRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.0.0.2",
        payload: {
          email: "ratelimited@example.com",
          password: "wrong password",
        },
      });
      expect(otherIpRes.statusCode).toBe(401);
    });
  });

  describe("cookie tampering (AC5)", () => {
    it("rejects a tampered cookie signature", async () => {
      const app = await withApp();
      const user = await seedUser(testDb.db, {
        email: "tampered@example.com",
        password: "correct horse battery",
      });
      const sessionId = await seedSession(testDb.db, {
        userId: user.id,
        expiresAt: new Date(clock.now().getTime() + 1000 * 60 * 60),
      });
      const good = sessionCookieHeader(sessionId);
      const tampered = good.slice(0, -1) + (good.endsWith("a") ? "b" : "a");

      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: tampered },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
