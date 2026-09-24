import os from "node:os";
import path from "node:path";
import { z } from "zod";

/** pino levels, plus `silent`. */
export const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Worker configuration, one field per `design.md` §15.3 variable the worker
 * reads. Credentials are optional at this step: the tasks that need them
 * (Jira poller, GitHub poller, adapters) tighten their own requirement.
 */
export interface WorkerConfig {
  databaseUrl: string;
  host: string;
  capabilities: string[];
  maxConcurrent: number;
  /** Absolute path; a leading `~` is expanded. */
  workspaceRoot: string;
  toolsPort: number;
  diskHighWaterPct: number;
  agentQuietTimeoutMs: number;
  pricingFile: string;
  publicUrl?: string;
  jiraBaseUrl?: string;
  jiraEmail?: string;
  jiraApiToken?: string;
  githubToken?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  logLevel: LogLevel;
}

/** Thrown when the environment is missing or malformed. Names every variable. */
export class ConfigError extends Error {
  readonly code = "CONFIG_INVALID" as const;
  /** Environment variable names that failed, in schema order. */
  readonly variables: string[];

  constructor(variables: string[], detail: string) {
    super(`Invalid worker environment: ${detail}`);
    this.name = "ConfigError";
    this.variables = variables;
  }
}

/** Treats "" the same as unset so a blank line in `.env` does not pass. */
const present = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value;

const required = (name: string) =>
  z
    .string()
    .optional()
    .transform((v) => present(v))
    .refine((v): v is string => v !== undefined, {
      message: `${name} is required`,
    });

const optional = () =>
  z
    .string()
    .optional()
    .transform((v) => present(v));

/**
 * Integer with a range. The message never echoes the received value, so a
 * secret pasted into the wrong variable cannot leak through a stack trace.
 */
const integer = (name: string, min: number, max: number, fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => present(v))
    .transform((v) => (v === undefined ? fallback : Number(v)))
    .refine(
      (n) => Number.isInteger(n) && n >= min && n <= max,
      { message: `${name} must be an integer between ${min} and ${max}` },
    );

/** `~` and `~/x` expand against the current user's home directory. */
export function expandHome(input: string, home: string = os.homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

const schema = z.object({
  DATABASE_URL: required("DATABASE_URL"),
  WORKER_HOST: z
    .string()
    .optional()
    .transform((v) => present(v) ?? os.hostname()),
  WORKER_CAPABILITIES: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  WORKER_MAX_CONCURRENT: integer("WORKER_MAX_CONCURRENT", 1, 1024, 2),
  WORKER_WORKSPACE_ROOT: z
    .string()
    .optional()
    .transform((v) => expandHome(present(v) ?? "~/orchestra")),
  WORKER_TOOLS_PORT: integer("WORKER_TOOLS_PORT", 1, 65535, 4317),
  WORKER_DISK_HIGH_WATER_PCT: integer("WORKER_DISK_HIGH_WATER_PCT", 1, 100, 85),
  AGENT_QUIET_TIMEOUT_MS: integer(
    "AGENT_QUIET_TIMEOUT_MS",
    1000,
    24 * 60 * 60 * 1000,
    1_200_000,
  ),
  PRICING_FILE: z
    .string()
    .optional()
    .transform((v) => present(v) ?? "config/pricing.json"),
  PUBLIC_URL: optional(),
  JIRA_BASE_URL: optional(),
  JIRA_EMAIL: optional(),
  JIRA_API_TOKEN: optional(),
  GITHUB_TOKEN: optional(),
  ANTHROPIC_API_KEY: optional(),
  OPENAI_API_KEY: optional(),
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => present(v) ?? "info")
    .refine((v): v is LogLevel => (LOG_LEVELS as readonly string[]).includes(v), {
      message: `LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`,
    }),
});

/**
 * Reads and validates the worker environment (design.md §15.3). Throws
 * `ConfigError` naming every missing or invalid variable. Values are never
 * included in the message, so secrets cannot reach a log through a failure.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const variables = parsed.error.issues.map((issue) =>
      String(issue.path[0] ?? "environment"),
    );
    const detail = parsed.error.issues
      .map((issue) => `${String(issue.path[0] ?? "environment")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError([...new Set(variables)], detail);
  }

  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    host: e.WORKER_HOST,
    capabilities: e.WORKER_CAPABILITIES,
    maxConcurrent: e.WORKER_MAX_CONCURRENT,
    workspaceRoot: e.WORKER_WORKSPACE_ROOT,
    toolsPort: e.WORKER_TOOLS_PORT,
    diskHighWaterPct: e.WORKER_DISK_HIGH_WATER_PCT,
    agentQuietTimeoutMs: e.AGENT_QUIET_TIMEOUT_MS,
    pricingFile: e.PRICING_FILE,
    publicUrl: e.PUBLIC_URL,
    jiraBaseUrl: e.JIRA_BASE_URL,
    jiraEmail: e.JIRA_EMAIL,
    jiraApiToken: e.JIRA_API_TOKEN,
    githubToken: e.GITHUB_TOKEN,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    openaiApiKey: e.OPENAI_API_KEY,
    logLevel: e.LOG_LEVEL,
  };
}

/** Fields that carry a credential and must never be logged (design.md §15.3). */
const SECRET_FIELDS = [
  "databaseUrl",
  "jiraApiToken",
  "githubToken",
  "anthropicApiKey",
  "openaiApiKey",
] as const satisfies readonly (keyof WorkerConfig)[];

export type RedactedConfig = Omit<
  WorkerConfig,
  (typeof SECRET_FIELDS)[number]
> & {
  /** Which credentials are set, without any value. */
  credentialsPresent: string[];
};

/** Strips every secret-bearing field so the result is safe to log verbatim. */
export function redactConfig(config: WorkerConfig): RedactedConfig {
  const safe = { ...config } as Partial<WorkerConfig>;
  for (const field of SECRET_FIELDS) delete safe[field];
  return {
    ...(safe as Omit<WorkerConfig, (typeof SECRET_FIELDS)[number]>),
    credentialsPresent: SECRET_FIELDS.filter((f) => config[f] !== undefined),
  };
}
