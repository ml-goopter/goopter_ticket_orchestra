import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { agentTools, TransitionError, type AgentToolName } from "@orchestra/core";
import {
  appendEvent,
  lockExecutionForTool,
  lockTaskForTool,
  NotFoundError,
  type Db,
} from "@orchestra/db";
import type { Logger } from "../logger.js";
import { renewExecutionLease } from "./lease.js";
import type { ExecutionRegistry, LiveExecution } from "./registry.js";
import type { ToolContext } from "./tool.js";
import {
  authenticate,
  reauthorize,
  TokenRevokedError,
  type AuthContext,
} from "./tokens.js";

/** `error.code` in a tool error's JSON text. */
export type ToolErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "ILLEGAL_TRANSITION"
  | "NOT_FOUND"
  | "INTERNAL";

export const REDACTED = "[REDACTED]";

export interface InvokeDeps {
  db: Db;
  registry: ExecutionRegistry;
  logger: Logger;
  now: () => Date;
  /**
   * Test-only. Runs after the pre-transaction auth and role checks pass and
   * before the tool's transaction opens, so a test can revoke the token in
   * that window.
   */
  afterAuthenticate?: () => Promise<void>;
}

/**
 * A tool definition with its input and output types erased, so the eight
 * differently-typed definitions can share one pipeline. The core zod schema
 * for `name` has already validated `input` by the time `run` sees it.
 */
export interface ErasedToolDefinition {
  name: AgentToolName;
  run(
    ctx: ToolContext,
    input: unknown,
  ): Promise<{
    output: unknown;
    afterCommit?: (live: LiveExecution | undefined) => void;
  }>;
}

/** An MCP tool error whose text is `{ "error": { code, message } }`. */
export function toolError(code: ToolErrorCode, message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

/**
 * Replaces every occurrence of `token` inside string values with
 * `[REDACTED]`. Applied to tool input before anything is stored, so an
 * agent that pastes its own token into a field cannot get it persisted or
 * echoed (design.md §8, "never log or echo the token").
 */
export function redactToken<T>(value: T, token: string): T {
  if (token === "") return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.split(token).join(REDACTED);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return walk(value) as T;
}

function classify(err: unknown): { code: ToolErrorCode; message: string } {
  if (err instanceof TransitionError) {
    return { code: "ILLEGAL_TRANSITION", message: err.message };
  }
  if (err instanceof NotFoundError) {
    return { code: "NOT_FOUND", message: err.message };
  }
  return { code: "INTERNAL", message: "Internal error. The call had no effect." };
}

/**
 * The one path every agent tool call takes (design.md §8):
 *
 *  1. authenticate the bearer for this tool (UNAUTHORIZED, writes nothing);
 *  2. check the execution's role against `agentTools[name].roles`
 *     (FORBIDDEN, writes nothing);
 *  3. run the tool's side effects in one transaction whose first statements
 *     lock the task row, then the execution row, and re-check step 1
 *     (UNAUTHORIZED, rolls back, writes nothing);
 *  4. after commit: in-process follow-ups (`blockingPending`), then lease
 *     renewal, then one `agent.tool_call` event `{ tool, input, ok }`.
 *
 * Input validation against the core schema happens before this, in the
 * MCP SDK, so a malformed call also writes nothing. A call that fails in
 * step 3 rolls back its side effects but is still recorded with
 * `ok: false`. Lease renewal, on success and failure alike, only takes
 * effect while the execution is still ASSIGNED or RUNNING (`renewTaskLease`).
 */
export async function invokeTool(
  def: ErasedToolDefinition,
  rawInput: unknown,
  bearer: string,
  deps: InvokeDeps,
): Promise<CallToolResult> {
  const { db, registry, logger } = deps;
  const tool = def.name;

  const unauthorized = (): CallToolResult =>
    toolError(
      "UNAUTHORIZED",
      "Token is unknown, revoked, or not valid for this tool in the execution's current state.",
    );

  const auth = await authenticate(db, bearer, tool);
  if (!auth) {
    logger.warn({ tool }, "agent tool call rejected: token not valid for this tool");
    return unauthorized();
  }

  const executionId = auth.execution.id;
  const roles: readonly string[] = agentTools[tool].roles;
  if (!roles.includes(auth.execution.role)) {
    logger.warn(
      { tool, executionId, role: auth.execution.role },
      "agent tool call rejected: wrong role",
    );
    return toolError(
      "FORBIDDEN",
      `${tool} is not available to the ${auth.execution.role} role.`,
    );
  }

  const live = registry.get(executionId);
  if (!live) {
    logger.warn(
      { tool, executionId },
      "execution not in registry; serving without in-process flags",
    );
  }

  const input = redactToken(rawInput, bearer);
  const now = deps.now();
  const ctx = (tx: ToolContext["tx"]): ToolContext => ({
    tx,
    auth,
    now,
    actor: { kind: "agent", id: executionId },
  });

  await deps.afterAuthenticate?.();

  let outcome: Awaited<ReturnType<ErasedToolDefinition["run"]>>;
  try {
    outcome = await db.transaction(async (tx) => {
      await reauthorize(tx, auth.task.id, executionId, bearer, tool);
      return def.run(ctx(tx), input);
    });
  } catch (err) {
    if (err instanceof TokenRevokedError) {
      logger.warn(
        { tool, executionId },
        "agent tool call rejected: token revoked or execution left an allowed state",
      );
      return unauthorized();
    }
    const { code, message } = classify(err);
    logger[code === "INTERNAL" ? "error" : "warn"](
      {
        tool,
        executionId,
        code,
        err: err instanceof Error ? err.message : String(err),
      },
      "agent tool call failed",
    );
    await record(auth, live, tool, input, now, deps, code);
    return toolError(code, message);
  }

  try {
    outcome.afterCommit?.(live);
  } catch (err) {
    logger.error(
      { tool, executionId, err: err instanceof Error ? err.message : String(err) },
      "agent tool post-commit hook failed",
    );
  }

  await record(auth, live, tool, input, now, deps);
  logger.info({ tool, executionId }, "agent tool call");

  return {
    content: [{ type: "text", text: JSON.stringify(outcome.output) }],
    structuredContent: outcome.output as Record<string, unknown>,
  };
}

/**
 * Lease renewal and the `agent.tool_call` row. Both run after the tool's
 * transaction has ended, and neither failure is surfaced to the agent:
 * the call's effects already stand, and the heartbeat renews the lease
 * again within 30 seconds (§6.4). The renewal is a no-op once the
 * execution is no longer ASSIGNED or RUNNING, for example after this call
 * completed or failed it, or a cancel landed after a failed call rolled
 * back. The `agent.tool_call` row is written regardless (§8).
 */
async function record(
  auth: AuthContext,
  live: LiveExecution | undefined,
  tool: AgentToolName,
  input: unknown,
  now: Date,
  deps: InvokeDeps,
  error?: ToolErrorCode,
): Promise<void> {
  const executionId = auth.execution.id;
  try {
    if (live) {
      await live.renewLease();
    } else {
      await renewExecutionLease(deps.db, executionId, now);
    }
  } catch (err) {
    deps.logger.error(
      { tool, executionId, err: err instanceof Error ? err.message : String(err) },
      "lease renewal after agent tool call failed",
    );
  }

  try {
    await deps.db.transaction(async (tx) => {
      // Task, then execution: the order of the tool transaction and the api
      // cancel route. The insert's foreign-key checks would lock both rows
      // anyway, but in constraint creation order, which a migration can
      // change. KEY SHARE is the lock those checks take: it waits behind a
      // cancel's FOR UPDATE on the task, which is what fixes the order, and
      // adds no conflict the insert did not already have.
      await lockTaskForTool(tx, auth.task.id, "key share");
      await lockExecutionForTool(tx, executionId, "key share");
      await appendEvent(tx, {
        taskId: auth.task.id,
        executionId,
        type: "agent.tool_call",
        payload: {
          tool,
          input,
          ok: error === undefined,
          ...(error === undefined ? {} : { error }),
        },
      });
    });
  } catch (err) {
    deps.logger.error(
      { tool, executionId, err: err instanceof Error ? err.message : String(err) },
      "recording agent.tool_call failed",
    );
  }
}
