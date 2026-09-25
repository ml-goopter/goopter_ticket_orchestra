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

/** `tasks.jira_priority` is Postgres `int4`; nothing stored may exceed this. */
const INT4_MAX = 2_147_483_647;

/**
 * Sentinel `jira_priority` for a ticket with no priority or an id that is
 * not a valid Jira priority id (design.md §11.1, Q2): larger than any real
 * Jira priority id, so it always sorts after a real one, but still within
 * `int4` range so the insert never fails.
 */
export const MISSING_JIRA_PRIORITY = INT4_MAX;

/**
 * Parses a Jira priority `id` (design.md §11.1, Q2). Only a non-negative
 * integer that fits `int4` is a real priority; anything else — missing,
 * non-numeric, negative, fractional or out of range — sorts last.
 */
export function parseJiraPriority(id: unknown): number {
  if (typeof id !== "string" && typeof id !== "number") {
    return MISSING_JIRA_PRIORITY;
  }
  if (typeof id === "string" && id.trim() === "") {
    return MISSING_JIRA_PRIORITY;
  }
  const parsed = Number(id);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > INT4_MAX
  ) {
    return MISSING_JIRA_PRIORITY;
  }
  return parsed;
}

export interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Issues requested per search page. */
  pageSize?: number;
  /** Bound on every request; a slow Jira must not hang the poller forever. */
  timeoutMs?: number;
}

/** Default request timeout (design.md §11.1, F2 regression); injectable for tests. */
export const DEFAULT_JIRA_REQUEST_TIMEOUT_MS = 30_000;

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
  const timeoutMs = config.timeoutMs ?? DEFAULT_JIRA_REQUEST_TIMEOUT_MS;
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
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    async search(jql) {
      const issues: JiraSearchIssue[] = [];
      let nextPageToken: string | undefined;
      const seenPageTokens = new Set<string>();

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

        const next = body.nextPageToken ?? undefined;
        if (next) {
          if (seenPageTokens.has(next)) {
            throw new JiraApiError(
              0,
              `Jira search returned a repeated nextPageToken (${next}); aborting to avoid an infinite loop`,
            );
          }
          seenPageTokens.add(next);
        }
        nextPageToken = next;
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
  attrs?: { text?: string; url?: string; [key: string]: unknown };
}

/**
 * Renders inline content (text, hard breaks, marks, `mention`, `inlineCard`)
 * to a single line-preserving string. `mention` and `inlineCard` are leaf
 * nodes with no `content`, so without an explicit case they render as
 * nothing.
 */
function renderInline(nodes: AdfNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.text ?? "";
      if (node.type === "hardBreak") return "\n";
      if (node.type === "mention") return node.attrs?.text ?? "";
      if (node.type === "inlineCard") return node.attrs?.url ?? "";
      if (node.content) return renderInline(node.content);
      return "";
    })
    .join("");
}

/** Prefixes every line of `text` with `indent`. */
function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

/**
 * Renders a `taskList`'s `taskItem` children as `- [ ] text` / `- [x] text`
 * (design.md §9.2, Q3, F1 regression). `taskItem.content` is inline content
 * directly, unlike `listItem`, which wraps its text in a `paragraph`.
 */
function renderTaskList(items: AdfNode[], indent = ""): string {
  return items
    .map((item) => {
      const checked = item.attrs?.state === "DONE" ? "x" : " ";
      const text = renderInline(item.content ?? []);
      return `${indent}- [${checked}] ${text}`;
    })
    .join("\n");
}

/**
 * Renders `bulletList`/`orderedList` content, one line per `listItem`. A
 * `listItem` can hold, alongside its paragraph text, a nested
 * `bulletList`/`orderedList`/`taskList` (rendered as indented lines beneath
 * the parent item) and any other block child — a `codeBlock`, `blockquote`,
 * etc. — whose text must still reach the output (design.md §9.2, Q3, F1
 * regression), so it is rendered the same way a top-level block would be and
 * indented under the item.
 */
function renderList(
  items: AdfNode[],
  marker: (index: number) => string,
  indent = "",
): string {
  return items
    .map((item, index) => {
      const children = item.content ?? [];
      const text = children
        .filter((child) => child.type === "paragraph")
        .map((child) => renderInline(child.content ?? []))
        .filter((line) => line.length > 0)
        .join(" ");
      const lines = [`${indent}${marker(index)}${text}`];

      for (const child of children) {
        if (child.type === "paragraph") continue;
        if (child.type === "bulletList") {
          lines.push(
            renderList(child.content ?? [], () => "- ", `${indent}  `),
          );
        } else if (child.type === "orderedList") {
          lines.push(
            renderList(
              child.content ?? [],
              (childIndex) => `${childIndex + 1}. `,
              `${indent}  `,
            ),
          );
        } else if (child.type === "taskList") {
          lines.push(renderTaskList(child.content ?? [], `${indent}  `));
        } else {
          for (const block of renderBlocks([child])) {
            lines.push(indentLines(block, `${indent}  `));
          }
        }
      }

      return lines.join("\n");
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
      case "heading":
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
      case "taskList":
        blocks.push(renderTaskList(node.content ?? []));
        break;
      default: {
        // Unknown node (design.md §9.2, Q3, F1 regression): try its content
        // as nested blocks first (a blockquote's content is paragraphs);
        // if that yields nothing, the content is inline (e.g. leaf text
        // nodes with no wrapping paragraph), so render it as a single line
        // instead of silently dropping it.
        const content = node.content ?? [];
        const nested = renderBlocks(content);
        if (nested.length > 0) {
          blocks.push(...nested);
        } else {
          const inline = renderInline(content);
          if (inline.length > 0) blocks.push(inline);
        }
      }
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
