/**
 * GitHub REST client (design.md §11.2). Covers exactly what the poller
 * needs: a pull request's state, its check runs, and a failing Actions job's
 * log for the resume prompt's excerpt.
 */

/** Thrown for any non-2xx, non-404 response. Callers decide what a 404 means. */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly rateLimited: boolean;

  constructor(status: number, message: string, rateLimited = false) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

export interface GitHubPullRequest {
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  headSha: string;
}

export interface GitHubCheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | "stale"
    | null;
  detailsUrl: string | null;
  /** The Actions app's own job id, when present, as a string. */
  externalId: string | null;
  htmlUrl: string | null;
  /** `github-actions` for a run created by Actions; anything else for a third-party check. */
  appSlug: string | null;
}

export interface GitHubClientConfig {
  token: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface GitHubClient {
  getPullRequest(owner: string, repo: string, number: number): Promise<GitHubPullRequest>;
  listCheckRuns(owner: string, repo: string, sha: string): Promise<GitHubCheckRun[]>;
  /** The Actions job log's text, following the redirect to blob storage. */
  getJobLog(owner: string, repo: string, jobId: string): Promise<string>;
}

/** Bound on every request; a slow or hanging GitHub must not stall the poller forever. */
export const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_BASE_URL = "https://api.github.com";
const CHECK_RUNS_PAGE_SIZE = 100;

interface CheckRunsApiResponse {
  total_count: number;
  check_runs: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    details_url: string | null;
    html_url: string | null;
    external_id: string | null;
    app: { slug: string | null } | null;
  }>;
}

interface PullRequestApiResponse {
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  head: { sha: string };
}

/** Rate limiting per GitHub's docs: 429 outright, or 403 with the remaining-quota header at 0. */
function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  return res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
}

export function createGitHubClient(config: GitHubClientConfig): GitHubClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_GITHUB_REQUEST_TIMEOUT_MS;

  async function request(path: string, params?: Record<string, string>): Promise<Response> {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value);
    }
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return res;
    if (!res.ok) {
      throw new GitHubApiError(
        res.status,
        `GitHub request to ${path} failed with status ${res.status}`,
        isRateLimited(res),
      );
    }
    return res;
  }

  return {
    async getPullRequest(owner, repo, number) {
      const res = await request(`/repos/${owner}/${repo}/pulls/${number}`);
      if (res.status === 404) {
        throw new GitHubApiError(404, `pull request ${owner}/${repo}#${number} not found`);
      }
      const body = (await res.json()) as PullRequestApiResponse;
      return {
        state: body.state,
        merged: body.merged,
        mergedAt: body.merged_at,
        headSha: body.head.sha,
      };
    },

    async listCheckRuns(owner, repo, sha) {
      const runs: GitHubCheckRun[] = [];
      let page = 1;
      for (;;) {
        const res = await request(`/repos/${owner}/${repo}/commits/${sha}/check-runs`, {
          per_page: String(CHECK_RUNS_PAGE_SIZE),
          page: String(page),
        });
        if (res.status === 404) {
          throw new GitHubApiError(404, `commit ${owner}/${repo}@${sha} not found`);
        }
        const body = (await res.json()) as CheckRunsApiResponse;
        for (const run of body.check_runs) {
          runs.push({
            name: run.name,
            status: run.status,
            conclusion: run.conclusion as GitHubCheckRun["conclusion"],
            detailsUrl: run.details_url,
            htmlUrl: run.html_url,
            externalId: run.external_id,
            appSlug: run.app?.slug ?? null,
          });
        }
        if (runs.length >= body.total_count || body.check_runs.length === 0) break;
        page += 1;
      }
      return runs;
    },

    async getJobLog(owner, repo, jobId) {
      const res = await request(`/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`);
      if (res.status === 404) {
        throw new GitHubApiError(404, `job log ${owner}/${repo}#${jobId} not found`);
      }
      return res.text();
    },
  };
}

/**
 * Parses `owner/repo` out of a repository's `git_url` (design.md §4.2), the
 * https and ssh forms, with or without a trailing `.git`:
 *
 * - `https://github.com/owner/repo(.git)?`
 * - `ssh://git@github.com/owner/repo(.git)?`
 * - `git@github.com:owner/repo(.git)?` (the scp-like form)
 */
export function parseRepositoryGitUrl(gitUrl: string): { owner: string; repo: string } {
  const patterns = [
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(gitUrl);
    if (match) {
      return { owner: match[1]!, repo: match[2]! };
    }
  }
  throw new Error(`cannot parse owner/repo from git url: ${gitUrl}`);
}
