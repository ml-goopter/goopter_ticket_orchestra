import { sessions, users } from "@orchestra/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { AUTH_REQUIRED } from "../lib/errors.js";

export const SESSION_COOKIE_NAME = "orchestra_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Idle expiry is refreshed on every request (design.md §13), but writing
 * `expires_at`/`last_seen_at` on every single request is wasted work. Only
 * write when the session is more than a minute stale; well inside the
 * 30-day window this cannot expire a session early.
 */
const REFRESH_THROTTLE_MS = 60 * 1000;

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
}

export interface AuthedSession {
  id: string;
  expiresAt: Date;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser;
    session?: AuthedSession;
  }
}

interface PublicRoute {
  method: string;
  url: string;
}

/** Routes reachable without a session (design.md §12.1, §13). */
export const PUBLIC_ROUTES: PublicRoute[] = [
  { method: "POST", url: "/api/auth/login" },
  { method: "GET", url: "/api/health" },
];

function isPublicRoute(request: FastifyRequest): boolean {
  const url = request.routeOptions.url;
  return PUBLIC_ROUTES.some(
    (route) => route.method === request.method && route.url === url,
  );
}

/**
 * Auth preHandler (design.md §13): unsigns the session cookie, loads the
 * session and its user, rejects 401 when absent/expired/disabled, and
 * otherwise sets `request.user` / `request.session` and refreshes idle
 * expiry. Registered with `fastify-plugin` so the hook applies to every
 * route in the parent scope, not just this plugin's own encapsulation.
 */
export default fp(
  async function authPlugin(app: FastifyInstance) {
    app.decorateRequest("user", undefined);
    app.decorateRequest("session", undefined);

    app.addHook("preHandler", async (request) => {
      if (isPublicRoute(request)) {
        return;
      }

      const raw = request.cookies[SESSION_COOKIE_NAME];
      if (!raw) {
        throw AUTH_REQUIRED;
      }

      const unsigned = request.unsignCookie(raw);
      if (!unsigned.valid || !unsigned.value) {
        throw AUTH_REQUIRED;
      }
      const sessionId = unsigned.value;

      const [row] = await app.db
        .select({
          sessionId: sessions.id,
          expiresAt: sessions.expiresAt,
          lastSeenAt: sessions.lastSeenAt,
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          disabledAt: users.disabledAt,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.id, sessionId))
        .limit(1);

      const now = app.now();

      if (!row || row.expiresAt < now || row.disabledAt !== null) {
        throw AUTH_REQUIRED;
      }

      request.user = {
        id: row.userId,
        email: row.email,
        displayName: row.displayName,
      };

      const newExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      request.session = { id: row.sessionId, expiresAt: newExpiresAt };

      if (now.getTime() - row.lastSeenAt.getTime() > REFRESH_THROTTLE_MS) {
        await app.db
          .update(sessions)
          .set({ expiresAt: newExpiresAt, lastSeenAt: now })
          .where(eq(sessions.id, sessionId));
      }
    });
  },
  { name: "auth-plugin" },
);
