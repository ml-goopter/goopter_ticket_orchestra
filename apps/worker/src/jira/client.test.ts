import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  JiraApiError,
  MISSING_JIRA_PRIORITY,
  createJiraClient,
  parseJiraPriority,
  renderAdfToPlainText,
} from "./client.js";

/** Records every request the client makes and replies from a canned queue. */
interface RecordedRequest {
  method: string | undefined;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
}

interface FakeResponse {
  status: number;
  body?: unknown;
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** Starts a throwaway HTTP server on loopback and replies from `handler`. */
async function setUp(
  handler: (req: RecordedRequest) => FakeResponse,
): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const recorded: RecordedRequest = {
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
    };
    requests.push(recorded);
    const { status, body } = handler(recorded);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanup = () => new Promise((resolve) => server.close(() => resolve()));

  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

describe("createJiraClient.search (design.md §11.1, E1, C1)", () => {
  it("sends Basic auth and only the needed fields", async () => {
    const { baseUrl, requests } = await setUp(() => ({
      status: 200,
      body: { issues: [] },
    }));

    const client = createJiraClient({
      baseUrl,
      email: "bot@goopter.dev",
      apiToken: "secret-token",
    });

    await client.search("project = GOOP ORDER BY created ASC");

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.path).toBe("/rest/api/3/search/jql");
    expect(req.query.get("jql")).toBe("project = GOOP ORDER BY created ASC");
    expect(req.query.get("fields")).toBe("summary,priority,created");
    const expectedAuth = `Basic ${Buffer.from("bot@goopter.dev:secret-token").toString("base64")}`;
    expect(req.headers.authorization).toBe(expectedAuth);
  });

  it("pages through every nextPageToken until the last page", async () => {
    const pages: Record<string, FakeResponse> = {
      "": {
        status: 200,
        body: {
          issues: [
            { key: "GOOP-1", fields: { summary: "one", priority: { id: "1" }, created: "2026-01-01T00:00:00.000+0000" } },
          ],
          nextPageToken: "page-2",
        },
      },
      "page-2": {
        status: 200,
        body: {
          issues: [
            { key: "GOOP-2", fields: { summary: "two", priority: { id: "2" }, created: "2026-01-02T00:00:00.000+0000" } },
          ],
          nextPageToken: "page-3",
        },
      },
      "page-3": {
        status: 200,
        body: {
          issues: [
            { key: "GOOP-3", fields: { summary: "three", priority: null, created: "2026-01-03T00:00:00.000+0000" } },
          ],
        },
      },
    };

    const { baseUrl, requests } = await setUp((req) => {
      const token = req.query.get("nextPageToken") ?? "";
      return pages[token]!;
    });

    const client = createJiraClient({ baseUrl, email: "e", apiToken: "t" });
    const issues = await client.search("project = GOOP");

    expect(requests).toHaveLength(3);
    expect(issues.map((i) => i.key)).toEqual(["GOOP-1", "GOOP-2", "GOOP-3"]);
    expect(issues[0]!.priority).toBe(1);
    expect(issues[0]!.createdAt).toEqual(new Date("2026-01-01T00:00:00.000+0000"));
    expect(issues[2]!.priority).toBe(MISSING_JIRA_PRIORITY);
  });

  it("throws JiraApiError on a non-2xx status", async () => {
    const { baseUrl } = await setUp(() => ({ status: 503 }));
    const client = createJiraClient({ baseUrl, email: "e", apiToken: "t" });

    await expect(client.search("project = GOOP")).rejects.toThrow(JiraApiError);
  });
});

describe("createJiraClient.issueExists (design.md §11.1, E3)", () => {
  it("returns true on 200", async () => {
    const { baseUrl, requests } = await setUp(() => ({
      status: 200,
      body: { fields: { summary: "s" } },
    }));
    const client = createJiraClient({ baseUrl, email: "e", apiToken: "t" });

    await expect(client.issueExists("GOOP-1")).resolves.toBe(true);
    expect(requests[0]!.path).toBe("/rest/api/3/issue/GOOP-1");
  });

  it("returns false on 404", async () => {
    const { baseUrl } = await setUp(() => ({ status: 404 }));
    const client = createJiraClient({ baseUrl, email: "e", apiToken: "t" });

    await expect(client.issueExists("GOOP-1")).resolves.toBe(false);
  });

  it("throws JiraApiError on any other status", async () => {
    const { baseUrl } = await setUp(() => ({ status: 500 }));
    const client = createJiraClient({ baseUrl, email: "e", apiToken: "t" });

    await expect(client.issueExists("GOOP-1")).rejects.toThrow(JiraApiError);
  });
});

describe("createJiraClient.getIssue (design.md §9.2, Q3, C8)", () => {
  it("returns summary, plain-text description and comments matching TicketContext", async () => {
    const { baseUrl } = await setUp(() => ({
      status: 200,
      body: {
        fields: {
          summary: "Fix the thing",
          description: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Line one." }] },
              {
                type: "bulletList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item a" }] }] },
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item b" }] }] },
                ],
              },
              { type: "codeBlock", content: [{ type: "text", text: "const x = 1;" }] },
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "first" },
                  { type: "hardBreak" },
                  { type: "text", text: "second" },
                ],
              },
            ],
          },
          comment: {
            comments: [
              {
                author: { displayName: "Alice" },
                created: "2026-02-03T12:00:00.000+0000",
                body: {
                  type: "doc",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "A comment." }] }],
                },
              },
            ],
          },
        },
      },
    }));

    const client = createJiraClient({ baseUrl, email: "e", apiToken: "t" });
    const ticket = await client.getIssue("GOOP-1");

    expect(ticket.key).toBe("GOOP-1");
    expect(ticket.summary).toBe("Fix the thing");
    expect(ticket.description).toBe(
      "Line one.\n\n- item a\n- item b\n\nconst x = 1;\n\nfirst\nsecond",
    );
    expect(ticket.comments).toEqual([
      { author: "Alice", createdAt: "2026-02-03", body: "A comment." },
    ]);
  });

  it("defaults a missing comment author to Unknown and a missing description to empty", async () => {
    const { baseUrl } = await setUp(() => ({
      status: 200,
      body: {
        fields: {
          summary: "No description",
          comment: {
            comments: [
              {
                created: "2026-02-03T12:00:00.000+0000",
                body: { type: "doc", content: [] },
              },
            ],
          },
        },
      },
    }));

    const client = createJiraClient({ baseUrl, email: "e", apiToken: "t" });
    const ticket = await client.getIssue("GOOP-2");

    expect(ticket.description).toBe("");
    expect(ticket.comments[0]!.author).toBe("Unknown");
  });

  it("throws JiraApiError on a non-2xx status", async () => {
    const { baseUrl } = await setUp(() => ({ status: 500 }));
    const client = createJiraClient({ baseUrl, email: "e", apiToken: "t" });

    await expect(client.getIssue("GOOP-1")).rejects.toThrow(JiraApiError);
  });
});

describe("parseJiraPriority (design.md §11.1, Q2)", () => {
  it("parses a numeric string id", () => {
    expect(parseJiraPriority("3")).toBe(3);
  });

  it("sorts a missing or non-numeric priority after every real one", () => {
    expect(parseJiraPriority(undefined)).toBe(MISSING_JIRA_PRIORITY);
    expect(parseJiraPriority(null)).toBe(MISSING_JIRA_PRIORITY);
    expect(parseJiraPriority("none")).toBe(MISSING_JIRA_PRIORITY);
    expect(MISSING_JIRA_PRIORITY).toBeGreaterThan(parseJiraPriority("999999"));
  });
});

describe("renderAdfToPlainText (design.md §9.2, Q3, C8)", () => {
  it("renders undefined and non-doc input as empty string", () => {
    expect(renderAdfToPlainText(undefined)).toBe("");
    expect(renderAdfToPlainText(null)).toBe("");
    expect(renderAdfToPlainText("not a doc")).toBe("");
  });

  it("renders an ordered list with incrementing markers", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] },
          ],
        },
      ],
    };
    expect(renderAdfToPlainText(doc)).toBe("1. first\n2. second");
  });
});
