import type { GitHubCheckRun, GitHubClient } from "./client.js";

/** design.md §9.2: the resume prompt keeps up to 200 lines per failing check. */
export const LOG_EXCERPT_MAX_LINES = 200;

/** Matches both the plural `/jobs/123` and the real singular `/job/123` (F1). */
const JOB_ID_IN_URL = /\/jobs?\/(\d+)/;

/**
 * The GitHub Actions job id behind a failing check run, or `undefined` when
 * it cannot be determined (a third-party check, or a shape this cannot
 * parse). A check run GitHub Actions created has its own `id` equal to the
 * job's id (design.md §11.2, F1) — `external_id` is a UUID Actions sets and
 * is never a usable job id, so it is not consulted here. The url match is a
 * defensive fallback for a response shape that somehow omits `id`.
 */
function jobIdFor(check: GitHubCheckRun): string | undefined {
  if (typeof check.id === "number" && Number.isFinite(check.id)) return String(check.id);
  for (const url of [check.detailsUrl, check.htmlUrl]) {
    if (!url) continue;
    const match = JOB_ID_IN_URL.exec(url);
    if (match) return match[1];
  }
  return undefined;
}

/** Keeps the tail: what matters for a failure is usually the last lines. */
export function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join("\n");
}

/**
 * The last `LOG_EXCERPT_MAX_LINES` lines of a failing check's job log
 * (design.md §11.2, C35). Empty for anything that is not a GitHub Actions
 * check run (`app_slug !== "github-actions"`), for a check whose job id
 * cannot be determined, or when the log fetch itself fails: a missing
 * excerpt must never fail the poll of the rest of the checks.
 */
export async function fetchLogExcerpt(
  client: GitHubClient,
  owner: string,
  repo: string,
  check: GitHubCheckRun,
): Promise<string> {
  if (check.appSlug !== "github-actions") return "";
  const jobId = jobIdFor(check);
  if (!jobId) return "";

  try {
    const log = await client.getJobLog(owner, repo, jobId);
    return tailLines(log, LOG_EXCERPT_MAX_LINES);
  } catch {
    return "";
  }
}
