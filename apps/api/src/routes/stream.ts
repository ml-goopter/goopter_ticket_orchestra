import { findSessionWithUser, getTaskState } from "@orchestra/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import type { StreamOwner } from "../realtime/index.js";

const TaskIdParamsSchema = z.object({ id: z.uuid() });
const CursorSchema = z.string().regex(/^\d+$/);
const StreamQuerySchema = z.object({ after: CursorSchema.optional() });

/**
 * H3 resume cursor: `Last-Event-ID` wins, `?after=` is the fallback, and
 * neither means live-only. Validated before the stream opens so a bad
 * cursor is a plain 400.
 */
function parseCursor(lastEventId: unknown, query: unknown): number | undefined {
  if (lastEventId !== undefined) {
    const parsed = CursorSchema.safeParse(lastEventId);
    if (!parsed.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Last-Event-ID must be a non-negative integer.",
      );
    }
    return Number(parsed.data);
  }
  const parsed = StreamQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "after must be a non-negative integer.");
  }
  return parsed.data.after === undefined ? undefined : Number(parsed.data.after);
}

/** The auth preHandler has set both on every stream route (H6). */
function streamOwner(request: FastifyRequest): StreamOwner {
  return { userId: request.user!.id, sessionId: request.session!.id };
}

/**
 * GOT.61 F2: a disable ends the user's open streams once it commits
 * (`closeUserStreams`, users route), but a stream whose auth passed before
 * that commit and that registers after the close ran would be missed.
 * Re-reading the session once the stream is registered closes that gap:
 * a disable committed before this read is seen here, and one committed
 * after it runs its close with this stream already registered. A failed
 * read ends the stream too; the client reconnects through auth.
 */
async function closeIfRevoked(app: FastifyInstance, owner: StreamOwner): Promise<void> {
  try {
    const current = await findSessionWithUser(app.db, owner.sessionId);
    if (current && current.user.disabledAt === null) return;
  } catch (err) {
    app.log.error({ err }, "stream: session re-check failed");
  }
  app.realtime.closeSessionStreams(owner.sessionId);
}

/**
 * SSE routes (design.md §12.6). Both sit behind the auth preHandler (H6);
 * validation and the task lookup run before `reply.hijack()`, so errors
 * still use the normal `{ error }` JSON response.
 */
export default async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tasks/:id/stream", async (request, reply) => {
    const params = TaskIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(400, "VALIDATION_ERROR", "id must be a UUID.");
    }
    const id = params.data.id;
    const cursor = parseCursor(request.headers["last-event-id"], request.query);

    if ((await getTaskState(app.db, id)) === null) {
      throw new AppError(404, "NOT_FOUND", `task not found: ${id}`);
    }

    const owner = streamOwner(request);
    reply.hijack();
    app.realtime.openTaskStream(reply.raw, id, cursor, owner);
    await closeIfRevoked(app, owner);
  });

  app.get("/stream", async (request, reply) => {
    const owner = streamOwner(request);
    reply.hijack();
    app.realtime.openGlobalStream(reply.raw, owner);
    await closeIfRevoked(app, owner);
  });
}
