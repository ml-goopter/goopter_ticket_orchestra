import { runReview, type RunDeps } from "./run.js";

/** Writes to a stream and resolves once the chunk is flushed. */
function writer(stream: NodeJS.WriteStream): (text: string) => Promise<void> {
  return (text) =>
    new Promise((resolve) => {
      stream.write(text, () => resolve());
    });
}

/**
 * Process entry for the `orchestra-review` bin: real env, cwd, git, Claude
 * adapter and MCP reporter. SIGINT and SIGTERM abort the review session.
 *
 * `overrides` lets a test substitute the adapter, reporter, cwd or streams
 * while still exercising the env handling below; production callers pass
 * nothing.
 */
export async function main(overrides: Partial<RunDeps> = {}): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    // `ClaudeAdapter` builds the subprocess env as
    // `{ ...process.env, ...req.env }` (packages/adapters/src/claude.ts), so
    // a `req.env` that merely omits ORCHESTRA_TOKEN does not remove it: the
    // real process.env still supplies it through the first spread. Deleting
    // the token from the real process.env here, before the adapter ever
    // starts, is what actually keeps it out of the subprocess. The copy
    // below still carries it so `runReview` can read it for the MCP call.
    const token = process.env.ORCHESTRA_TOKEN;
    delete process.env.ORCHESTRA_TOKEN;
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (token !== undefined) env.ORCHESTRA_TOKEN = token;

    return await runReview({
      argv: process.argv.slice(2),
      env,
      cwd: process.cwd(),
      stdout: writer(process.stdout),
      stderr: writer(process.stderr),
      signal: controller.signal,
      ...overrides,
    });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
