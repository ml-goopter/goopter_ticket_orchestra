import { useEffect, useRef } from "react";
import type { EventStreamStatus } from "../sse/useEventStream.js";

/**
 * Calls `refetch` the first time `status` becomes `"open"` again after
 * having been open before -- a reconnect, not the initial connect. `GET
 * /stream` has no replay (user decision Q8, docs/build-order.md GOT.36
 * carry-forward), so a dropped-and-restored connection can only recover
 * by refetching, not by trusting events missed while it was down.
 */
export function useRefetchOnReconnect(status: EventStreamStatus, refetch: () => void): void {
  const openedBeforeRef = useRef(false);

  useEffect(() => {
    if (status === "open") {
      if (openedBeforeRef.current) {
        refetch();
      }
      openedBeforeRef.current = true;
    }
    // `refetch` is intentionally not a dependency: callers pass a new
    // function identity on every render, and depending on it would refire
    // this effect (and, on "open", the reconnect refetch) on every
    // unrelated re-render rather than only on an actual status change.
    // The effect closes over whichever `refetch` was current at the last
    // render that changed `status`, which is always the latest one.
  }, [status]);
}
