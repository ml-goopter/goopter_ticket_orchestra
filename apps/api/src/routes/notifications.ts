import { listNotificationsForUser, lockNotification, markNotificationRead } from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";

const NotificationIdParamsSchema = z.object({ id: z.uuid() });

function parseNotificationId(params: unknown): string {
  const parsed = NotificationIdParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "id must be a UUID.");
  }
  return parsed.data.id;
}

/**
 * Notification routes (design.md §12.5). Broadcast rows (`user_id` null)
 * are visible to every user; a targeted row only to its own user, and a
 * caller trying to read another user's targeted row gets the same 404 as
 * an unknown id.
 */
export default async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    return listNotificationsForUser(app.db, request.user!.id);
  });

  app.post("/:id/read", async (request) => {
    const id = parseNotificationId(request.params);
    const userId = request.user!.id;

    return app.db.transaction(async (tx) => {
      const row = await lockNotification(tx, id);
      if (!row || (row.userId !== null && row.userId !== userId)) {
        throw new AppError(404, "NOT_FOUND", `notification not found: ${id}`);
      }
      if (row.readAt !== null) {
        return row;
      }
      return markNotificationRead(tx, id, app.now());
    });
  });
}
