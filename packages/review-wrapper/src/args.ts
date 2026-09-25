import { ReviewError, USAGE } from "./errors.js";

/**
 * Parses `--round N` or `--round=N` (Q6: required, integer >= 1). Anything
 * else, including an extra argument, is a usage error.
 */
export function parseRound(argv: readonly string[]): number {
  let raw: string | undefined;
  let seen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!seen && arg === "--round") {
      raw = argv[++i];
      seen = true;
    } else if (!seen && arg.startsWith("--round=")) {
      raw = arg.slice("--round=".length);
      seen = true;
    } else {
      throw new ReviewError(`unexpected argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  if (raw === undefined || !/^[0-9]+$/.test(raw) || Number(raw) < 1) {
    throw new ReviewError(USAGE);
  }
  const round = Number(raw);
  if (!Number.isSafeInteger(round)) throw new ReviewError(USAGE);
  return round;
}
