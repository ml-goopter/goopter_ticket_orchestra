import postgres from "postgres";
import { NOTIFY_CHANNEL, type NotifyPayload } from "./events.js";

/** `application_name` of the dedicated `LISTEN` connection, so it is identifiable in `pg_stat_activity`. */
export const LISTEN_APPLICATION_NAME = "orchestra-listen";

export interface ListenHandlers {
  /** One committed `NOTIFY orchestra` payload (design.md §12.6). */
  onNotify(payload: NotifyPayload): void;
  /**
   * Fires once `LISTEN orchestra` is in effect: on the initial connect and
   * again after every reconnect. Notifications sent while the connection
   * was down are lost, so callers re-read anything they may have missed.
   */
  onListen(): void;
  /** A payload on the channel that is not a valid `NotifyPayload`. */
  onError?(err: unknown): void;
}

export interface Listener {
  close(): Promise<void>;
}

function parsePayload(raw: string): NotifyPayload {
  const value = JSON.parse(raw) as Partial<NotifyPayload> | null;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.task_id !== "string" ||
    typeof value.event_id !== "number"
  ) {
    throw new Error(`invalid ${NOTIFY_CHANNEL} payload: ${raw}`);
  }
  return { task_id: value.task_id, event_id: value.event_id };
}

/**
 * Opens one dedicated `LISTEN orchestra` connection (design.md §12.6).
 * `db` is the only package that imports `postgres` (design.md §3), so the
 * api reaches the channel through this callback API. postgres.js
 * re-issues `LISTEN` on a fresh connection after a drop and calls
 * `onListen` again. Resolves once the first `LISTEN` is in effect; rejects
 * (and releases the connection) if it cannot be established.
 */
export async function startListener(
  connectionString: string,
  handlers: ListenHandlers,
): Promise<Listener> {
  const sql = postgres(connectionString, {
    max: 1,
    connection: { application_name: LISTEN_APPLICATION_NAME },
    onnotice: () => {},
  });

  const onNotify = (raw: string): void => {
    let payload: NotifyPayload;
    try {
      payload = parsePayload(raw);
    } catch (err) {
      handlers.onError?.(err);
      return;
    }
    handlers.onNotify(payload);
  };

  try {
    await sql.listen(NOTIFY_CHANNEL, onNotify, () => handlers.onListen());
  } catch (err) {
    await sql.end({ timeout: 0 });
    throw err;
  }

  return {
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
