import { describe, expect, it, vi } from "vitest";
import {
  GitHubApiError,
  createGitHubClient,
  parseRepositoryGitUrl,
} from "./client.js";

describe("parseRepositoryGitUrl (design.md §11.2, AC9)", () => {
  it("parses https with a .git suffix", () => {
    expect(parseRepositoryGitUrl("https://github.com/goopter/repo.git")).toEqual({
      owner: "goopter",
      repo: "repo",
    });
  });

  it("parses https without a .git suffix", () => {
    expect(parseRepositoryGitUrl("https://github.com/goopter/repo")).toEqual({
      owner: "goopter",
      repo: "repo",
    });
  });

  it("parses the ssh:// form with a .git suffix", () => {
    expect(parseRepositoryGitUrl("ssh://git@github.com/goopter/repo.git")).toEqual({
      owner: "goopter",
      repo: "repo",
    });
  });

  it("parses the ssh:// form without a .git suffix", () => {
    expect(parseRepositoryGitUrl("ssh://git@github.com/goopter/repo")).toEqual({
      owner: "goopter",
      repo: "repo",
    });
  });

  it("parses the scp-like form (git@host:owner/repo.git)", () => {
    expect(parseRepositoryGitUrl("git@github.com:goopter/repo.git")).toEqual({
      owner: "goopter",
      repo: "repo",
    });
  });

  it("parses the scp-like form without a .git suffix", () => {
    expect(parseRepositoryGitUrl("git@github.com:goopter/repo")).toEqual({
      owner: "goopter",
      repo: "repo",
    });
  });

  it("throws for a url it cannot parse", () => {
    expect(() => parseRepositoryGitUrl("not-a-url")).toThrow();
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("createGitHubClient (design.md §11.2)", () => {
  it("getPullRequest parses state, merged, merged_at and the head sha", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        state: "open",
        merged: false,
        merged_at: null,
        head: { sha: "abc123" },
      }),
    );
    const client = createGitHubClient({ token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });

    const pr = await client.getPullRequest("goopter", "repo", 7);

    expect(pr).toEqual({ state: "open", merged: false, mergedAt: null, headSha: "abc123" });
    const [url, opts] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/goopter/repo/pulls/7");
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: "Bearer t" });
  });

  it("getPullRequest throws GitHubApiError(404) for a missing pull request", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));
    const client = createGitHubClient({ token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.getPullRequest("goopter", "repo", 7)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws a non-rate-limited GitHubApiError for a plain 500", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const client = createGitHubClient({ token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });

    const err = await client.getPullRequest("goopter", "repo", 7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(500);
    expect((err as GitHubApiError).rateLimited).toBe(false);
  });

  it("surfaces a 429 as a rate-limited GitHubApiError", async () => {
    const fetchImpl = vi.fn(async () => new Response("slow down", { status: 429 }));
    const client = createGitHubClient({ token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });

    const err = await client.getPullRequest("goopter", "repo", 7).catch((e: unknown) => e);
    expect((err as GitHubApiError).rateLimited).toBe(true);
  });

  it("surfaces a 403 with x-ratelimit-remaining: 0 as rate-limited", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("forbidden", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
    );
    const client = createGitHubClient({ token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });

    const err = await client.getPullRequest("goopter", "repo", 7).catch((e: unknown) => e);
    expect((err as GitHubApiError).rateLimited).toBe(true);
  });

  it("a plain 403 (no rate-limit header) is not rate-limited", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const client = createGitHubClient({ token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });

    const err = await client.getPullRequest("goopter", "repo", 7).catch((e: unknown) => e);
    expect((err as GitHubApiError).rateLimited).toBe(false);
  });

  it("listCheckRuns pages through every check run", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      name: `check-${i}`,
      status: "completed",
      conclusion: "success",
      details_url: null,
      html_url: `https://github.com/goopter/repo/runs/${i}`,
      external_id: null,
      app: { slug: "github-actions" },
    }));
    const page2 = [
      {
        name: "check-100",
        status: "completed",
        conclusion: "failure",
        details_url: "https://github.com/goopter/repo/actions/runs/1/jobs/999",
        html_url: null,
        external_id: "999",
        app: { slug: "github-actions" },
      },
    ];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = new URL(url);
      const page = u.searchParams.get("page");
      if (page === "2") {
        return jsonResponse({ total_count: 101, check_runs: page2 });
      }
      return jsonResponse({ total_count: 101, check_runs: page1 });
    });
    const client = createGitHubClient({ token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });

    const runs = await client.listCheckRuns("goopter", "repo", "abc123");

    expect(runs).toHaveLength(101);
    expect(runs[100]).toEqual({
      name: "check-100",
      status: "completed",
      conclusion: "failure",
      detailsUrl: "https://github.com/goopter/repo/actions/runs/1/jobs/999",
      htmlUrl: null,
      externalId: "999",
      appSlug: "github-actions",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("getJobLog returns the response body text", async () => {
    const fetchImpl = vi.fn(async () => new Response("line1\nline2\n"));
    const client = createGitHubClient({ token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });

    const text = await client.getJobLog("goopter", "repo", "999");

    expect(text).toBe("line1\nline2\n");
  });
});
