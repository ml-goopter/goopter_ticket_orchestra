import type { TicketComment, TicketContext } from "@orchestra/prompts";

/**
 * Jira Cloud REST v3 client (design.md §11.1, E1, E3, Q3). The legacy
 * `/rest/api/3/search` endpoint is removed; search always goes through the
 * enhanced `/rest/api/3/search/jql`, paged with `nextPageToken`.
 */

/** Thrown for any non-2xx, non-404 response. Callers decide what a 404 means. */
export class JiraApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
  }
}

/** A search result row, already parsed (design.md §11.1, Q2). */
export interface JiraSearchIssue {
  key: string;
  summary: string;
  /** Priority `id` parsed as an integer; see `parseJiraPriority` for the sentinel. */
  priority: number;
  createdAt: Date;
}

/**
 * Sentinel `jira_priority` for a ticket with no priority or a non-numeric
 * `id` (design.md §11.1, Q2): larger than any real Jira priority id, so it
 * always sorts after a real one.
 */
export const MISSING_JIRA_PRIORITY = Number.MAX_SAFE_INTEGER;

/** Parses a Jira priority `id` (design.md §11.1, Q2). Missing or non-numeric sorts last. */
export function parseJiraPriority(id: unknown): number {
  if (typeof id !== "string" && typeof id !== "number") {
    return MISSING_JIRA_PRIORITY;
  }
  const parsed = Number(id);
  return Number.isFinite(parsed) ? parsed : MISSING_JIRA_PRIORITY;
}

export interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Issues requested per search page. */
  pageSize?: number;
}

export interface JiraClient {
  /** Pages through every result of `jql`, in order (design.md §11.1, E1). */
  search(jql: string): Promise<JiraSearchIssue[]>;
  /** True on 200, false on 404. Throws `JiraApiError` on any other status. */
  issueExists(key: string): Promise<boolean>;
  /** Full ticket content, ADF fields rendered to plain text (design.md §9.2, Q3). */
  getIssue(key: string): Promise<TicketContext>;
}

const SEARCH_FIELDS = "summary,priority,created";
const EXISTS_FIELDS = "summary";
const ISSUE_FIELDS = "summary,description,comment";
const DEFAULT_PAGE_SIZE = 100;

interface JiraSearchApiIssue {
  key: string;
  fields: {
    summary: string;
    priority?: { id?: string | number | null } | null;
    created: string;
  };
}

interface JiraSearchApiResponse {
  issues?: JiraSearchApiIssue[];
  nextPageToken?: string | null;
}

interface JiraIssueApiResponse {
  fields: {
    summary: string;
    description?: unknown;
    comment?: {
      comments?: Array<{
        author?: { displayName?: string | null } | null;
        created: string;
        body?: unknown;
      }>;
    };
  };
}

/** `2026-01-15T10:30:00.000+0000` -> `2026-01-15`, matching `TicketComment.createdAt`. */
function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

export function createJiraClient(config: JiraClientConfig): JiraClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  const authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;

  async function request(
    path: string,
    params: Record<string, string>,
  ): Promise<Response> {
    const url = new URL(path, config.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return fetchImpl(url, {
      headers: { Authorization: authHeader, Accept: "application/json" },
    });
  }

  return {
    async search(jql) {
      const issues: JiraSearchIssue[] = [];
      let nextPageToken: string | undefined;

      do {
        const params: Record<string, string> = {
          jql,
          fields: SEARCH_FIELDS,
          maxResults: String(pageSize),
        };
        if (nextPageToken) params.nextPageToken = nextPageToken;

        const res = await request("/rest/api/3/search/jql", params);
        if (!res.ok) {
          throw new JiraApiError(
            res.status,
            `Jira search failed with status ${res.status}`,
          );
        }

        const body = (await res.json()) as JiraSearchApiResponse;
        for (const issue of body.issues ?? []) {
          issues.push({
            key: issue.key,
            summary: issue.fields.summary,
            priority: parseJiraPriority(issue.fields.priority?.id),
            createdAt: new Date(issue.fields.created),
          });
        }

        nextPageToken = body.nextPageToken ?? undefined;
      } while (nextPageToken);

      return issues;
    },

    async issueExists(key) {
      const res = await request(
        `/rest/api/3/issue/${encodeURIComponent(key)}`,
        { fields: EXISTS_FIELDS },
      );
      if (res.status === 404) return false;
      if (!res.ok) {
        throw new JiraApiError(
          res.status,
          `Jira issue lookup for ${key} failed with status ${res.status}`,
        );
      }
      return true;
    },

    async getIssue(key) {
      const res = await request(
        `/rest/api/3/issue/${encodeURIComponent(key)}`,
        { fields: ISSUE_FIELDS },
      );
      if (!res.ok) {
        throw new JiraApiError(
          res.status,
          `Jira issue fetch for ${key} failed with status ${res.status}`,
        );
      }

      const body = (await res.json()) as JiraIssueApiResponse;
      const comments: TicketComment[] = (body.fields.comment?.comments ?? []).map(
        (comment) => ({
          author: comment.author?.displayName ?? "Unknown",
          createdAt: toDateOnly(comment.created),
          body: renderAdfToPlainText(comment.body),
        }),
      );

      const ticket: TicketContext = {
        key,
        summary: body.fields.summary,
        description: renderAdfToPlainText(body.fields.description),
        comments,
      };
      return ticket;
    },
  };
}

/**
 * Atlassian Document Format node, trimmed to the shapes this renderer
 * understands (design.md §9.2, Q3): paragraphs, lists, code blocks and hard
 * breaks render as readable plain text; anything else is walked for nested
 * content and otherwise ignored.
 */
interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
}

/** Renders inline content (text, hard breaks, marks) to a single line-preserving string. */
function renderInline(nodes: AdfNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.text ?? "";
      if (node.type === "hardBreak") return "\n";
      if (node.content) return renderInline(node.content);
      return "";
    })
    .join("");
}

/** Renders `bulletList`/`orderedList` content, one line per `listItem`. */
function renderList(items: AdfNode[], marker: (index: number) => string): string {
  return items
    .map((item, index) => {
      const text = (item.content ?? [])
        .map((child) =>
          child.type === "paragraph" ? renderInline(child.content ?? []) : "",
        )
        .filter((line) => line.length > 0)
        .join(" ");
      return `${marker(index)}${text}`;
    })
    .join("\n");
}

/** Renders top-level document blocks, each separated by a blank line. */
function renderBlocks(nodes: AdfNode[]): string[] {
  const blocks: string[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        blocks.push(renderInline(node.content ?? []));
        break;
      case "codeBlock":
        blocks.push(renderInline(node.content ?? []));
        break;
      case "bulletList":
        blocks.push(renderList(node.content ?? [], () => "- "));
        break;
      case "orderedList":
        blocks.push(
          renderList(node.content ?? [], (index) => `${index + 1}. `),
        );
        break;
      default:
        if (node.content) blocks.push(...renderBlocks(node.content));
    }
  }

  return blocks;
}

/**
 * Renders an Atlassian Document Format document (Jira's `description` and
 * comment `body` fields) to readable plain text (design.md §9.2, Q3).
 * Unrecognised or missing input renders as an empty string rather than
 * throwing, since a ticket with no description is normal.
 */
export function renderAdfToPlainText(doc: unknown): string {
  if (!doc || typeof doc !== "object" || !("content" in doc)) return "";
  const node = doc as AdfNode;
  return renderBlocks(node.content ?? [])
    .join("\n\n")
    .trim();
}
