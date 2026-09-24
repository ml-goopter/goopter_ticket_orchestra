import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, type Logger } from "./logger.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return {
    stream,
    records: () =>
      lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("createLogger (design.md §15.2 structured logging)", () => {
  it("emits one JSON object per record carrying the host binding", () => {
    const sink = capture();
    const logger = createLogger({ level: "info", host: "mac-mini" }, sink.stream);

    logger.info({ tick: 3 }, "tick complete");

    const [record] = sink.records();
    expect(record).toMatchObject({
      host: "mac-mini",
      tick: 3,
      msg: "tick complete",
    });
    expect(typeof record!.time).toBe("number");
  });

  it("honours the configured level", () => {
    const sink = capture();
    const logger = createLogger({ level: "warn", host: "h" }, sink.stream);

    logger.info({}, "dropped");
    logger.warn({}, "kept");

    expect(sink.records().map((r) => r.msg)).toEqual(["kept"]);
  });

  it("carries child bindings such as workerId and phase onto every record", () => {
    const sink = capture();
    const logger: Logger = createLogger(
      { level: "info", host: "h" },
      sink.stream,
    )
      .child({ workerId: "w-1" })
      .child({ phase: "claim" });

    logger.error({ tick: 9 }, "phase failed");

    expect(sink.records()[0]).toMatchObject({
      host: "h",
      workerId: "w-1",
      phase: "claim",
      tick: 9,
      msg: "phase failed",
    });
  });

  it("writes nothing at level silent", () => {
    const sink = capture();
    const logger = createLogger({ level: "silent", host: "h" }, sink.stream);

    logger.error({}, "nope");

    expect(sink.records()).toEqual([]);
  });
});
