import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const validEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/orchestra",
  SESSION_SECRET: "a".repeat(32),
};

describe("loadConfig", () => {
  it("parses a minimal valid environment with defaults", () => {
    const config = loadConfig(validEnv);
    expect(config.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(config.SESSION_SECRET).toBe(validEnv.SESSION_SECRET);
    expect(config.PORT).toBe(3000);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.NODE_ENV).toBe("production");
    expect(config.TRUST_PROXY).toBe(false);
    expect(config.PUBLIC_URL).toBeUndefined();
  });

  it("fails fast naming SESSION_SECRET when it is missing", () => {
    const env = { DATABASE_URL: validEnv.DATABASE_URL };
    expect(() => loadConfig(env)).toThrowError(/SESSION_SECRET/);
  });

  it("fails fast naming DATABASE_URL when it is missing", () => {
    const env = { SESSION_SECRET: validEnv.SESSION_SECRET };
    expect(() => loadConfig(env)).toThrowError(/DATABASE_URL/);
  });

  it("rejects a SESSION_SECRET shorter than 32 characters", () => {
    const env = { ...validEnv, SESSION_SECRET: "short" };
    expect(() => loadConfig(env)).toThrowError(/SESSION_SECRET/);
  });

  it("coerces PORT and parses TRUST_PROXY from strings", () => {
    const config = loadConfig({
      ...validEnv,
      PORT: "4000",
      TRUST_PROXY: "true",
    });
    expect(config.PORT).toBe(4000);
    expect(config.TRUST_PROXY).toBe(true);
  });
});
