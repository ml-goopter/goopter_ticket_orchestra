import { useCallback, useEffect, useRef } from "react";

export interface LatestRequestGuard {
  /** Call at the start of an async fetch; returns that call's generation. */
  begin: () => number;
  /**
   * True if `generation` is still the most recently begun call and the
   * component is still mounted. Check this before applying a resolved
   * fetch's result to state.
   */
  isCurrent: (generation: number) => boolean;
}

/**
 * Guards against a stale-response race (review finding F1/F2, GOT.36-fix1):
 * two overlapping fetches from the same function (or, when shared, from
 * two different fetch functions racing the same state) can resolve out of
 * order, letting a slower earlier response overwrite a faster later one.
 *
 * Callers grab a generation number from `begin()` when a fetch starts, and
 * gate every state update on `isCurrent(generation)` once it resolves.
 * Unmounting bumps the generation too, so any resolution still in flight
 * after unmount is also treated as stale and never applies.
 */
export function useLatestRequest(): LatestRequestGuard {
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  const begin = useCallback(() => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  const isCurrent = useCallback(
    (generation: number) => mountedRef.current && generation === generationRef.current,
    [],
  );

  return { begin, isCurrent };
}
