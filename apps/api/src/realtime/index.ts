import { startListener, type Listener } from "@orchestra/db";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import {
  RealtimeHub,
  defaultListBacklog,
  defaultLoadEvent,
  type ListBacklog,
  type LoadEvent,
} from "./hub.js";
import { DEFAULT_KEEPALIVE_MS } from "./sse.js";

export {
  GLOBAL_STREAM_TYPES,
  RealtimeHub,
  defaultListBacklog,
  defaultLoadEvent,
  type ListBacklog,
  type LoadEvent,
} from "./hub.js";

/** Overrides for tests; production uses the defaults. */
export interface RealtimeOptions {
  /** H7: keepalive comment interval. Defaults to 25 seconds. */
  keepaliveMs?: number;
  loadEvent?: LoadEvent;
  listBacklog?: ListBacklog;
}

declare module "fastify" {
  interface FastifyInstance {
    realtime: RealtimeHub;
  }
}

/**
 * Owns the api's one dedicated `LISTEN orchestra` connection and the SSE
 * hub it feeds (design.md §12.6). The connection opens on `onReady`, so
 * `listen()`/`inject()` resolve only once LISTEN is in effect. H8:
 * `preClose` ends every open stream before the server stops accepting,
 * so `close()` is not held open by long-lived responses; `onClose` then
 * releases the LISTEN connection.
 */
export default fp(
  async function realtimePlugin(app: FastifyInstance, options: RealtimeOptions) {
    const hub = new RealtimeHub({
      db: app.db,
      log: app.log,
      keepaliveMs: options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS,
      loadEvent: options.loadEvent ?? defaultLoadEvent,
      listBacklog: options.listBacklog ?? defaultListBacklog,
    });
    app.decorate("realtime", hub);

    let listener: Listener | null = null;

    app.addHook("onReady", async () => {
      listener = await startListener(app.config.DATABASE_URL, {
        onNotify: (payload) => hub.handleNotify(payload),
        onListen: () => {
          app.log.info("realtime: LISTEN established");
          hub.handleListen();
        },
        onError: (err) => app.log.warn({ err }, "realtime: ignored notify payload"),
      });
    });

    app.addHook("preClose", async () => {
      hub.closeAll();
    });

    app.addHook("onClose", async () => {
      await listener?.close();
      listener = null;
    });
  },
  { name: "realtime-plugin" },
);
