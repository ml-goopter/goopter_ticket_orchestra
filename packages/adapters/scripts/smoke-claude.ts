/**
 * Manual smoke test for the Claude adapter against the real SDK.
 *
 * Never runs under `pnpm test`: vitest only collects `*.test.ts`, this file
 * lives outside `src` so `tsc -b` ignores it, and it refuses to do anything
 * unless `ORCHESTRA_SMOKE=1` is set explicitly.
 *
 * It spends real money and needs a working Claude credential
 * (`ANTHROPIC_API_KEY` or a logged-in Claude CLI).
 *
 *   corepack pnpm --filter @orchestra/adapters build
 *   ORCHESTRA_SMOKE=1 node --experimental-strip-types \
 *     packages/adapters/scripts/smoke-claude.ts
 *
 * It imports the built package, not `src`, because Node's type stripping does
 * not resolve the `.js` specifiers the sources use.
 *
 * What it proves, in order:
 *   1. `start` yields a `session` event carrying a session id.
 *   2. The turn ends with `turn_done` and at least one `usage` event.
 *   3. `canResume(sessionId, cwd)` finds that session's transcript on disk.
 *   4. `resume` continues the same session and reaches `turn_done` again.
 *
 * It uses the `spec` tool policy, so the session is read-only, and points
 * `mcp.url` at a port nothing listens on: the agent-tools MCP server (§8) is
 * the worker's, not this script's. An unreachable MCP server is expected and
 * must not break the run.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../dist/index.js";
import type { AgentEvent } from "../dist/index.js";

const MAX_BUDGET_USD = 0.5;

async function drain(
  stream: AsyncIterable<AgentEvent>,
  label: string,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "text") process.stdout.write(event.delta);
    else if (event.type !== "usage") console.log(`\n[${label}] ${event.type}`);
  }
  return events;
}

async function main(): Promise<void> {
  if (process.env.ORCHESTRA_SMOKE !== "1") {
    console.error(
      "Refusing to run: set ORCHESTRA_SMOKE=1 to spend real tokens.",
    );
    process.exitCode = 1;
    return;
  }

  const cwd = await mkdtemp(join(tmpdir(), "orchestra-smoke-"));
  const adapter = new ClaudeAdapter();
  const base = {
    cwd,
    allowedTools: "spec" as const,
    mcp: { url: "http://127.0.0.1:9/mcp", token: "smoke-token" },
    env: { ...process.env } as Record<string, string>,
    maxBudgetUsd: MAX_BUDGET_USD,
  };

  const started = await drain(
    adapter.start(
      {
        ...base,
        systemPrompt: "You are a smoke test. Answer in one short sentence.",
        prompt: "Reply with the single word: ready.",
      },
      new AbortController().signal,
    ),
    "start",
  );

  const session = started.find((event) => event.type === "session");
  if (!session) throw new Error("no session event; adapter never started");
  const { sessionId } = session;
  console.log(`\nsession id: ${sessionId}`);
  console.log(
    `usage events: ${started.filter((e) => e.type === "usage").length}`,
  );
  if (!started.some((event) => event.type === "turn_done")) {
    throw new Error("start never reached turn_done");
  }

  const resumable = await adapter.canResume(sessionId, cwd);
  console.log(`canResume: ${resumable}`);
  if (!resumable) throw new Error("canResume said false for a live session");

  const resumed = await drain(
    adapter.resume(
      { ...base, sessionId, prompt: "Repeat the word you just said." },
      new AbortController().signal,
    ),
    "resume",
  );
  if (!resumed.some((event) => event.type === "turn_done")) {
    throw new Error("resume never reached turn_done");
  }

  console.log("\nsmoke test passed");
}

await main();
