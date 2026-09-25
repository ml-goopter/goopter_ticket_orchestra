import { runReview } from "./run.js";

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
 */
export async function main(): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    return await runReview({
      argv: process.argv.slice(2),
      env: process.env,
      cwd: process.cwd(),
      stdout: writer(process.stdout),
      stderr: writer(process.stderr),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
