import type { ExecutionRole } from "@orchestra/core";
import type { DbOrTx } from "@orchestra/db";
import { renewExecutionLease } from "./lease.js";

/**
 * In-process state for the executions this worker is running. The database
 * is the source of truth; this only carries flags that have no column,
 * chiefly `blockingPending` (design.md §8: a blocking `raise_issue` "sets a
 * flag", which the runner reads at `turn_done`, §9.3). The runner (GOT.31)
 * populates it.
 */
export interface LiveExecution {
  executionId: string;
  taskId: string;
  role: ExecutionRole;
  /** Set by a blocking `raise_issue`; the runner moves to WAITING_FOR_USER. */
  blockingPending: boolean;
  renewLease: () => Promise<void>;
}

export interface ExecutionRegistry {
  get(executionId: string): LiveExecution | undefined;
  set(entry: LiveExecution): void;
  delete(executionId: string): void;
}

export function createExecutionRegistry(): ExecutionRegistry {
  const entries = new Map<string, LiveExecution>();
  return {
    get: (executionId) => entries.get(executionId),
    set: (entry) => void entries.set(entry.executionId, entry),
    delete: (executionId) => void entries.delete(executionId),
  };
}

export interface LiveExecutionInit {
  executionId: string;
  taskId: string;
  role: ExecutionRole;
  /** Defaults to `renewExecutionLease` against `deps.db`. */
  renewLease?: () => Promise<void>;
}

/** Builds a registry entry with `blockingPending = false`. */
export function createLiveExecution(
  init: LiveExecutionInit,
  deps: { db: DbOrTx; now: () => Date },
): LiveExecution {
  return {
    executionId: init.executionId,
    taskId: init.taskId,
    role: init.role,
    blockingPending: false,
    renewLease:
      init.renewLease ??
      (async () => {
        await renewExecutionLease(deps.db, init.executionId, deps.now());
      }),
  };
}
