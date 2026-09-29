/**
 * §6.4: calls `renew` every `intervalMs` while `body` runs, and once before
 * it when `renewNow` is set. `shouldRun` is checked after that first renewal:
 * false skips `body`. `renew` must not throw.
 *
 * No renewal outlives the call (GOT.78): on the way out the interval is
 * stopped and every renewal still in flight is awaited. A renewal left
 * running after the run ended took `task_leases` then `executions` locks
 * concurrently with whatever came next, and deadlocked a test reset's
 * TRUNCATE that locks them the other way round (40P01).
 */
export async function runWithRenewal(
  renew: () => Promise<void>,
  options: { intervalMs: number; renewNow: boolean; shouldRun: () => boolean },
  body: () => Promise<void>,
): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  const tick = (): void => {
    const p = renew().finally(() => inFlight.delete(p));
    inFlight.add(p);
  };
  const interval = setInterval(tick, options.intervalMs);
  try {
    if (options.renewNow) {
      await renew();
      if (!options.shouldRun()) return;
    }
    await body();
  } finally {
    clearInterval(interval);
    await Promise.allSettled([...inFlight]);
  }
}
