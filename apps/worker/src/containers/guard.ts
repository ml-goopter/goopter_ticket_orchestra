/**
 * Process-wide coordination between `ContainerManager.ensure` and container
 * removal (design.md §6.6, §9.9 Removal, Recreation). Both run under one
 * in-process lock per execution, so a removal and an `ensure` of the same
 * execution never interleave: an `ensure` that arrives during a removal
 * waits, then finds the container missing and recreates it.
 *
 * The lock is the innermost the worker takes. Nothing is acquired while it
 * is held, no database row and no repository lock, so it cannot join a
 * wait cycle. Like the repository lock it is per process, which matches
 * one worker process per host.
 */

const locks = new Map<string, Promise<void>>();

/**
 * The latest `ensure` of each execution's container in this process that
 * no removal has followed. Values come from one increasing counter, so a
 * mark is never reused, even after its entry is deleted.
 */
const marks = new Map<string, number>();
let sequence = 0;

const key = (executionId: string): string => executionId.toLowerCase();

/** Runs `fn` holding the execution's container lock. */
export async function withExecutionContainerLock<T>(
  executionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const k = key(executionId);
  const previous = locks.get(k) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(k, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(k) === tail) locks.delete(k);
  }
}

/**
 * The mark of the execution's latest `ensure` in this process, or 0 when
 * none has run since the container was last removed. A sweeper reads it
 * before deciding and compares under the lock: a different value means an
 * `ensure` ran in between, so a resume is using the container.
 */
export function ensureMark(executionId: string): number {
  return marks.get(key(executionId)) ?? 0;
}

/** Records an `ensure`. Call while holding the execution's lock. */
export function recordEnsure(executionId: string): void {
  marks.set(key(executionId), ++sequence);
}

/** Records a removal. Call while holding the execution's lock. */
export function forgetEnsure(executionId: string): void {
  marks.delete(key(executionId));
}
