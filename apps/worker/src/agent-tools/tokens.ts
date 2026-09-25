import { createHash, randomBytes } from "node:crypto";
import { ExecutionState, type AgentToolName } from "@orchestra/core";
import {
  findExecutionByTokenHash,
  lockExecutionForTool,
  lockTaskForTool,
  setExecutionToolsTokenHash,
  type AgentToolsExecutionContext,
  type DbOrTx,
  type Tx,
} from "@orchestra/db";

/**
 * Per-execution bearer tokens for the agent-tools server (design.md §8):
 * "a random 32-byte value stored on the execution row as a hash, issued at
 * start or resume, and revoked when the execution leaves RUNNING".
 *
 * The plaintext exists only in the return value of `issueToken` and in the
 * agent's environment. Nothing here logs it.
 */

export type AuthContext = AgentToolsExecutionContext;

/** sha-256, hex. The only form of the token that is ever stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Generates a fresh token for `executionId`, stores its hash, and returns
 * the plaintext once. 32 random bytes as base64url is 43 characters.
 * Issuing again replaces the previous hash, so a resume invalidates the
 * token the previous session held.
 */
export async function issueToken(
  tx: DbOrTx,
  executionId: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await setExecutionToolsTokenHash(tx, executionId, hashToken(token));
  return token;
}

/** Nulls the stored hash. Every later call with the old token fails auth. */
export async function revokeToken(
  tx: DbOrTx,
  executionId: string,
): Promise<void> {
  await setExecutionToolsTokenHash(tx, executionId, null);
}

/**
 * Tools that may also be called while the execution is still `ASSIGNED`.
 *
 * §9.3 issues the token before `adapter.start()`, and the runner flips
 * `ASSIGNED -> RUNNING` ("session started", §5.2) when it handles the
 * adapter's `session` event. The agent runs in its own process, so its
 * first tool call can reach this server before that transition commits.
 * Only the tools that just record something (`raise_issue`, `note`) are
 * allowed in that window. Every tool that moves an execution or task waits
 * for `RUNNING`, including `report_failed`: the core table has no
 * `ASSIGNED -> FAILED` edge (§5.2), so it is refused as UNAUTHORIZED rather
 * than failing later with ILLEGAL_TRANSITION.
 */
export const ASSIGNED_TOOLS: ReadonlySet<AgentToolName> = new Set<AgentToolName>([
  "raise_issue",
  "note",
]);

/**
 * Whether an execution in `state` may call `tool`. `RUNNING` may call
 * anything; `ASSIGNED` only the tools above; every other state none. With
 * no `tool`, only `RUNNING` passes.
 */
export function tokenAllows(
  state: ExecutionState,
  tool?: AgentToolName,
): boolean {
  if (state === ExecutionState.RUNNING) return true;
  if (state === ExecutionState.ASSIGNED) {
    return tool !== undefined && ASSIGNED_TOOLS.has(tool);
  }
  return false;
}

/**
 * Resolves a bearer token to its execution, task and project with no state
 * check. The HTTP layer uses this to turn away unknown and revoked tokens
 * before any MCP handling; per-tool authorization is `authenticate`.
 */
export async function resolveToken(
  db: DbOrTx,
  bearer: string,
): Promise<AuthContext | null> {
  if (bearer === "") return null;
  return findExecutionByTokenHash(db, hashToken(bearer));
}

/**
 * Resolves a bearer token and checks the execution is in a state that may
 * call `tool` (see `tokenAllows`). Returns `null` for an unknown, revoked,
 * or out-of-state token.
 */
export async function authenticate(
  db: DbOrTx,
  bearer: string,
  tool?: AgentToolName,
): Promise<AuthContext | null> {
  const ctx = await resolveToken(db, bearer);
  if (!ctx || !tokenAllows(ctx.execution.state, tool)) return null;
  return ctx;
}

/** Thrown inside a tool transaction when the token no longer authorizes the call. */
export class TokenRevokedError extends Error {
  constructor() {
    super("agent-tools token no longer valid for this tool");
    this.name = "TokenRevokedError";
  }
}

/**
 * The in-transaction half of authorization, and the tool transaction's
 * first statements. `authenticate` runs before the transaction without a
 * lock, so the execution may leave RUNNING and have its token revoked
 * before the tool writes. This locks the task row, then the execution row,
 * then confirms the stored hash still matches `bearer` and the state still
 * allows `tool`. Throws `TokenRevokedError` otherwise, which rolls the
 * transaction back.
 *
 * Lock order is task, then execution: the order the api cancel route takes
 * them. Locking the execution first deadlocks against a concurrent cancel,
 * because every tool later touches the task row (a `transition()`, or the
 * foreign-key check of any insert that references the task). `taskId` comes
 * from the pre-transaction `authenticate`; `executions.task_id` never
 * changes, so it is safe to lock by.
 */
export async function reauthorize(
  tx: Tx,
  taskId: string,
  executionId: string,
  bearer: string,
  tool: AgentToolName,
): Promise<void> {
  if (!(await lockTaskForTool(tx, taskId))) {
    throw new TokenRevokedError();
  }
  const row = await lockExecutionForTool(tx, executionId);
  if (
    !row ||
    row.toolsTokenHash === null ||
    row.toolsTokenHash !== hashToken(bearer) ||
    !tokenAllows(row.state, tool)
  ) {
    throw new TokenRevokedError();
  }
}
