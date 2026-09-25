import { getTaskState } from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";

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

    reply.hijack();
    app.realtime.openTaskStream(reply.raw, id, cursor);
  });

  app.get("/stream", async (_request, reply) => {
    reply.hijack();
    app.realtime.openGlobalStream(reply.raw);
  });
}
