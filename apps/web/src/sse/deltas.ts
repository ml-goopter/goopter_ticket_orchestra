/**
 * Concatenates `agent.message.delta` payloads per execution id and clears
 * the buffer when the matching `agent.message` (the final text) arrives
 * (design.md §12.6: "Agent text arrives as agent.message.delta ... most
 * every 200ms, concatenated by client").
 */
export interface DeltaAccumulator {
  /** Appends `text` to the buffer for `executionId`, returns the buffer. */
  append(executionId: string, text: string): string;
  /** Returns the buffer for `executionId` and clears it. */
  flush(executionId: string): string;
  /** Returns the current buffer for `executionId` without clearing it. */
  get(executionId: string): string;
}

export function createDeltaAccumulator(): DeltaAccumulator {
  const buffers = new Map<string, string>();

  return {
    append(executionId, text) {
      const next = (buffers.get(executionId) ?? "") + text;
      buffers.set(executionId, next);
      return next;
    },
    flush(executionId) {
      const value = buffers.get(executionId) ?? "";
      buffers.delete(executionId);
      return value;
    },
    get(executionId) {
      return buffers.get(executionId) ?? "";
    },
  };
}
