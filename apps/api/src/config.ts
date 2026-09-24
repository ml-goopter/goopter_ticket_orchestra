import { z } from "zod";

/**
 * Environment schema (design.md §15.3). `DATABASE_URL` and `SESSION_SECRET`
 * are required; everything else has a default so a minimal `.env` still
 * boots.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_URL: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z.string().default("production"),
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});

export type Config = z.infer<typeof EnvSchema>;

/**
 * Parses `env` into a `Config`, failing fast with a message naming every
 * invalid or missing variable (design.md §15.3). Throws rather than
 * returning a result so callers (the CLI and `index.ts`) do not need to
 * remember to check.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  return result.data;
}
