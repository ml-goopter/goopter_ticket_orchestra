import { describe, expect, it } from "vitest";
import type { LogFields, Logger } from "./logger.js";
import { installSignalHandlers } from "./shutdown.js";

function harness() {
  const records: Array<{ fields: LogFields; msg: string }> = [];
  const logger: Logger = {
    debug: (fields, msg) => void records.push({ fields, msg }),
    info: (fields, msg) => void records.push({ fields, msg }),
    warn: (fields, msg) => void records.push({ fields, msg }),
    error: (fields, msg) => void records.push({ fields, msg }),
    child: () => logger,
  };
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  return {
    records,
    logger,
    handlers,
    exits,
    on: (signal: string, handler: () => void) => void handlers.set(signal, handler),
    off: (signal: string) => void handlers.delete(signal),
    exit: (code: number) => void exits.push(code),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("installSignalHandlers (design.md §15.2 graceful shutdown)", () => {
  it("registers SIGTERM and SIGINT by default", () => {
    const h = harness();
    installSignalHandlers({ logger: h.logger, stop: async () => {}, on: h.on, off: h.off, exit: h.exit });

    expect([...h.handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("stops the worker then exits 0 on SIGTERM", async () => {
    const h = harness();
    const order: string[] = [];
    installSignalHandlers({
      logger: h.logger,
      stop: async () => {
        await flush();
        order.push("stopped");
      },
      on: h.on,
      off: h.off,
      exit: (code) => void order.push(`exit:${code}`),
    });

    h.handlers.get("SIGTERM")!();
    await flush();
    await flush();

    expect(order).toEqual(["stopped", "exit:0"]);
  });

  it("exits 1 immediately on a second signal, without waiting for stop", async () => {
    const h = harness();
    let stopFinished = false;
    installSignalHandlers({
      logger: h.logger,
      stop: async () => {
        await new Promise((r) => setTimeout(r, 500));
        stopFinished = true;
      },
      on: h.on,
      off: h.off,
      exit: h.exit,
    });

    h.handlers.get("SIGTERM")!();
    await flush();
    h.handlers.get("SIGINT")!();

    expect(h.exits).toEqual([1]);
    expect(stopFinished).toBe(false);
    expect(h.records.some((r) => r.msg.includes("forc"))).toBe(true);
  });

  it("exits 1 when the graceful stop throws", async () => {
    const h = harness();
    installSignalHandlers({
      logger: h.logger,
      stop: async () => {
        throw new Error("stop exploded");
      },
      on: h.on,
      off: h.off,
      exit: h.exit,
    });

    h.handlers.get("SIGTERM")!();
    await flush();

    expect(h.exits).toEqual([1]);
    expect(h.records.some((r) => r.msg.includes("shutdown failed"))).toBe(true);
  });

  it("logs the signal that triggered the shutdown", async () => {
    const h = harness();
    installSignalHandlers({ logger: h.logger, stop: async () => {}, on: h.on, off: h.off, exit: h.exit });

    h.handlers.get("SIGINT")!();
    await flush();

    expect(h.records[0]!.fields.signal).toBe("SIGINT");
  });

  it("removes its handlers when uninstalled", () => {
    const h = harness();
    const uninstall = installSignalHandlers({
      logger: h.logger,
      stop: async () => {},
      on: h.on,
      off: h.off,
      exit: h.exit,
    });

    uninstall();

    expect([...h.handlers.keys()]).toEqual([]);
  });
});
