import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, redactConfig } from "./config.js";

const DATABASE_URL = "postgres://orchestra:orchestra@localhost:5432/orchestra";

/** Only the keys under test; `loadConfig` never reads `process.env` here. */
const env = (overrides: Record<string, string | undefined> = {}) => ({
  DATABASE_URL,
  ...overrides,
});

describe("loadConfig (design.md §15.3)", () => {
  it("names DATABASE_URL when it is missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("names DATABASE_URL when it is present but empty", () => {
    expect(() => loadConfig({ DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("names every invalid variable in one message", () => {
    let message = "";
    try {
      loadConfig({ WORKER_MAX_CONCURRENT: "zero", WORKER_TOOLS_PORT: "-1" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/WORKER_MAX_CONCURRENT/);
    expect(message).toMatch(/WORKER_TOOLS_PORT/);
  });

  it("never echoes a secret value in the failure message", () => {
    let message = "";
    try {
      loadConfig({
        GITHUB_TOKEN: "ghp_supersecret",
        ANTHROPIC_API_KEY: "sk-ant-supersecret",
        DATABASE_URL: "",
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toMatch(/supersecret/);
  });

  it("applies every documented default", () => {
    const config = loadConfig(env());

    expect(config.databaseUrl).toBe(DATABASE_URL);
    expect(config.host).toBe(os.hostname());
    expect(config.capabilities).toEqual([]);
    expect(config.maxConcurrent).toBe(2);
    expect(config.workspaceRoot).toBe(path.join(os.homedir(), "orchestra"));
    expect(config.toolsPort).toBe(4317);
    expect(config.diskHighWaterPct).toBe(85);
    expect(config.agentQuietTimeoutMs).toBe(1200000);
    expect(config.pricingFile).toBe("config/pricing.json");
    expect(config.logLevel).toBe("info");
    expect(config.publicUrl).toBeUndefined();
  });

  it("leaves every later-step credential optional", () => {
    const config = loadConfig(env());
    expect(config.jiraBaseUrl).toBeUndefined();
    expect(config.jiraEmail).toBeUndefined();
    expect(config.jiraApiToken).toBeUndefined();
    expect(config.githubToken).toBeUndefined();
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.openaiApiKey).toBeUndefined();
  });

  it("parses WORKER_CAPABILITIES 'node, odoo' into a trimmed list", () => {
    expect(loadConfig(env({ WORKER_CAPABILITIES: "node, odoo" })).capabilities)
      .toEqual(["node", "odoo"]);
  });

  it("drops blank entries from WORKER_CAPABILITIES", () => {
    expect(loadConfig(env({ WORKER_CAPABILITIES: " , node ,, " })).capabilities)
      .toEqual(["node"]);
  });

  it("expands a leading ~ in WORKER_WORKSPACE_ROOT", () => {
    const config = loadConfig(env({ WORKER_WORKSPACE_ROOT: "~/work/agents" }));
    expect(config.workspaceRoot).toBe(
      path.join(os.homedir(), "work", "agents"),
    );
  });

  it("keeps an absolute WORKER_WORKSPACE_ROOT as given", () => {
    const config = loadConfig(env({ WORKER_WORKSPACE_ROOT: "/srv/orchestra" }));
    expect(config.workspaceRoot).toBe("/srv/orchestra");
  });

  it("reads the explicit overrides", () => {
    const config = loadConfig(
      env({
        WORKER_HOST: "mac-mini",
        WORKER_MAX_CONCURRENT: "4",
        WORKER_TOOLS_PORT: "5000",
        WORKER_DISK_HIGH_WATER_PCT: "70",
        AGENT_QUIET_TIMEOUT_MS: "60000",
        PRICING_FILE: "config/codex.json",
        PUBLIC_URL: "http://localhost:8080",
        LOG_LEVEL: "debug",
        JIRA_BASE_URL: "https://goopter.atlassian.net",
        GITHUB_TOKEN: "ghp_x",
      }),
    );

    expect(config.host).toBe("mac-mini");
    expect(config.maxConcurrent).toBe(4);
    expect(config.toolsPort).toBe(5000);
    expect(config.diskHighWaterPct).toBe(70);
    expect(config.agentQuietTimeoutMs).toBe(60000);
    expect(config.pricingFile).toBe("config/codex.json");
    expect(config.publicUrl).toBe("http://localhost:8080");
    expect(config.logLevel).toBe("debug");
    expect(config.jiraBaseUrl).toBe("https://goopter.atlassian.net");
    expect(config.githubToken).toBe("ghp_x");
  });

  it("rejects a disk high water mark outside 1-100", () => {
    expect(() => loadConfig(env({ WORKER_DISK_HIGH_WATER_PCT: "0" })))
      .toThrow(/WORKER_DISK_HIGH_WATER_PCT/);
    expect(() => loadConfig(env({ WORKER_DISK_HIGH_WATER_PCT: "101" })))
      .toThrow(/WORKER_DISK_HIGH_WATER_PCT/);
  });

  it("rejects an unknown LOG_LEVEL by name", () => {
    expect(() => loadConfig(env({ LOG_LEVEL: "chatty" }))).toThrow(/LOG_LEVEL/);
  });
});

describe("redactConfig", () => {
  it("drops every secret-bearing field", () => {
    const redacted = redactConfig(
      loadConfig(
        env({
          GITHUB_TOKEN: "ghp_supersecret",
          JIRA_API_TOKEN: "jira_supersecret",
          ANTHROPIC_API_KEY: "sk-ant-supersecret",
          OPENAI_API_KEY: "sk-supersecret",
        }),
      ),
    );

    expect(JSON.stringify(redacted)).not.toMatch(/supersecret/);
    expect(JSON.stringify(redacted)).not.toMatch(/orchestra:orchestra/);
    expect(redacted.host).toBe(os.hostname());
    expect(redacted.maxConcurrent).toBe(2);
  });
});
