import { and, desc, eq, isNull, or } from "drizzle-orm";
import { notifications } from "../schema/notifications.js";
import type { DbOrTx, Tx } from "../transition.js";

/**
 * Queries behind the notification routes (design.md §12.5). `notifications`
 * has no `apps/api`-visible drizzle import (§3), so every statement those
 * routes run lives here.
 */

export type NotificationRow = typeof notifications.$inferSelect;

/**
 * A user's notifications, newest first: broadcast rows (`user_id` null)
 * plus the ones targeted at `userId`, never another user's targeted row
 * (design.md §12.5, user decision Q3).
 */
export async function listNotificationsForUser(
  db: DbOrTx,
  userId: string,
): Promise<NotificationRow[]> {
  return db
    .select()
    .from(notifications)
    .where(or(isNull(notifications.userId), eq(notifications.userId, userId)))
    .orderBy(desc(notifications.createdAt), desc(notifications.id));
}

/**
 * Locks one notification row `FOR UPDATE`, so two concurrent
 * `POST /notifications/:id/read` calls serialise rather than racing on the
 * conditional update below. `null` when the notification does not exist.
 */
export async function lockNotification(
  tx: Tx,
  id: string,
): Promise<NotificationRow | null> {
  const [row] = await tx
    .select()
    .from(notifications)
    .where(eq(notifications.id, id))
    .for("update");
  return row ?? null;
}

/**
 * Sets `read_at = now`, but only while it is still null, so a second call
 * for an already-read row is a no-op rather than overwriting the original
 * timestamp (design.md §12.5: idempotent, broadcast rows share one
 * `read_at` across every user). Caller already holds the row lock and has
 * confirmed `read_at` is null; throws if that no longer holds (a race the
 * lock should have prevented).
 */
export async function markNotificationRead(
  tx: Tx,
  id: string,
  now: Date,
): Promise<NotificationRow> {
  const [row] = await tx
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
    .returning();
  if (!row) {
    throw new Error(`markNotificationRead: notification ${id} already read or missing`);
  }
  return row;
}
