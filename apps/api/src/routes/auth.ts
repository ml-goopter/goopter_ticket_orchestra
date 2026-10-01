import { deleteSession, findUserByEmail, insertSessionIfEnabled } from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, AUTH_INVALID_CREDENTIALS, AUTH_REQUIRED } from "../lib/errors.js";
import { getDummyPasswordHash, verifyPassword } from "../lib/passwords.js";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "../plugins/auth.js";

const LoginBodySchema = z.object({
  email: z.string().min(1, "email is required"),
  password: z.string().min(1, "password is required"),
});

/**
 * Only routes are login/logout/me (design.md §12.1). Every other user
 * mutation (admin create, GOT.20) is out of scope here.
 */
export default async function authRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/login",
    {
      config: {
        // 10 per minute per IP (design.md §13).
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          keyGenerator: (request) => request.ip,
        },
      },
    },
    async (request, reply) => {
      const parsed = LoginBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "email and password are required.",
        );
      }
      const { email, password } = parsed.data;

      const row = await findUserByEmail(app.db, email);

      // Unknown email, disabled user, and wrong password all return the
      // exact same body so a caller cannot enumerate accounts. `verifyPassword`
      // always runs, against a fixed dummy hash when there is no live user,
      // so the three cases also cost the same argon2id work (R5).
      const digest =
        row && row.disabledAt === null
          ? row.passwordHash
          : await getDummyPasswordHash();
      const passwordOk = await verifyPassword(digest, password);
      if (!row || row.disabledAt !== null || !passwordOk) {
        throw AUTH_INVALID_CREDENTIALS;
      }

      const now = app.now();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      // A disable can commit after the read above. The insert re-checks
      // `disabled_at` under a row lock that serializes with the disable,
      // so a login racing it ends as the same refusal (GOT.61 F1).
      const session = await insertSessionIfEnabled(app.db, {
        userId: row.id,
        expiresAt,
        now,
      });
      if (!session) {
        throw AUTH_INVALID_CREDENTIALS;
      }

      reply.setCookie(SESSION_COOKIE_NAME, session.id, {
        httpOnly: true,
        // Secure everywhere except development/test, where there is no TLS.
        secure:
          app.config.NODE_ENV !== "development" &&
          app.config.NODE_ENV !== "test",
        sameSite: "lax",
        path: "/",
        signed: true,
        expires: expiresAt,
      });

      return { id: row.id, email: row.email, displayName: row.displayName };
    },
  );

  app.post("/logout", async (request, reply) => {
    if (!request.session) {
      throw AUTH_REQUIRED;
    }
    const sessionId = request.session.id;
    await deleteSession(app.db, sessionId);
    // Close all SSE streams opened with this session (GOT.88).
    // Session delete must commit before the close, so a failed delete closes nothing.
    app.realtime.closeSessionStreams(sessionId);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return {};
  });

  app.get("/me", async (request) => {
    if (!request.user) {
      throw AUTH_REQUIRED;
    }
    return request.user;
  });
}
