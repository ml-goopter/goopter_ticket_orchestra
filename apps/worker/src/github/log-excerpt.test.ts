import { describe, expect, it, vi } from "vitest";
import type { GitHubCheckRun, GitHubClient } from "./client.js";
import { fetchLogExcerpt, tailLines } from "./log-excerpt.js";

function fakeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getPullRequest: vi.fn(),
    listCheckRuns: vi.fn(),
    getJobLog: vi.fn(async () => ""),
    ...overrides,
  };
}

function checkRun(overrides: Partial<GitHubCheckRun> = {}): GitHubCheckRun {
  return {
    id: 1,
    name: "unit",
    status: "completed",
    conclusion: "failure",
    detailsUrl: null,
    htmlUrl: null,
    externalId: null,
    appSlug: "github-actions",
    ...overrides,
  };
}

describe("tailLines", () => {
  it("keeps only the last N lines", () => {
    const text = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
    expect(tailLines(text, 2)).toBe("line 3\nline 4");
  });
});

describe("fetchLogExcerpt (design.md §11.2, C35, F1)", () => {
  it("is empty for a non-github-actions check", async () => {
    const client = fakeClient();
    const text = await fetchLogExcerpt(
      client,
      "goopter",
      "repo",
      checkRun({ appSlug: "codecov", id: 42 }),
    );
    expect(text).toBe("");
    expect(client.getJobLog).not.toHaveBeenCalled();
  });

  it(
    "F1 regression: uses the check run's own numeric id as the job id for a " +
      "real-shaped GitHub Actions check run (UUID external_id, /job/ singular url)",
    async () => {
      const getJobLog = vi.fn(async () => "a\n".repeat(5) + "the failure line");
      const client = fakeClient({ getJobLog });
      const run = checkRun({
        id: 555,
        externalId: "b4b6b6b0-3e3a-4b0a-9b0a-5f5f5f5f5f5f",
        detailsUrl: "https://github.com/goopter/repo/actions/runs/1/job/555",
        htmlUrl: null,
        appSlug: "github-actions",
      });

      const text = await fetchLogExcerpt(client, "goopter", "repo", run);

      expect(getJobLog).toHaveBeenCalledWith("goopter", "repo", "555");
      expect(text).toContain("the failure line");
    },
  );

  it("falls back to a /job/ (singular) or /jobs/ url when id is somehow absent", async () => {
    const getJobLog = vi.fn(async () => "log text");
    const client = fakeClient({ getJobLog });
    const run = {
      ...checkRun({ appSlug: "github-actions" }),
      id: undefined as unknown as number,
      detailsUrl: "https://github.com/goopter/repo/actions/runs/1/job/777",
    };

    await fetchLogExcerpt(client, "goopter", "repo", run);

    expect(getJobLog).toHaveBeenCalledWith("goopter", "repo", "777");
  });

  it("is empty when the log fetch fails", async () => {
    const client = fakeClient({
      getJobLog: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const text = await fetchLogExcerpt(client, "goopter", "repo", checkRun());
    expect(text).toBe("");
  });
});
