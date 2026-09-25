/**
 * `orchestra-review` (design.md §9.8, D14): the fresh-context reviewer the
 * implementation agent runs from its worktree. The bin is a thin entry
 * over `cli.ts`; the logic below is importable for tests.
 */
export const PACKAGE_NAME = "@orchestra/review-wrapper";

export { parseRound } from "./args.js";
export { ExitCode, ReviewError, USAGE } from "./errors.js";
export { collectChanges, runGit, type GitRunner, type WorktreeChanges } from "./git.js";
export { parseReviewReply } from "./reply.js";
export { createMcpReporter, type ReviewReporter } from "./reporter.js";
export { CODEX_UNAVAILABLE_MESSAGE, runReview, type RunDeps } from "./run.js";
