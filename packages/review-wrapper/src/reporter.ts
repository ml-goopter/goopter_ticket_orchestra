import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ReportReviewResultOutputSchema,
  ReportUsageOutputSchema,
  type ReportReviewResultInput,
  type ReportReviewResultOutput,
  type ReportUsageInput,
} from "@orchestra/core";
import { ReviewError } from "./errors.js";

/** The two agent-tools calls the wrapper makes (design.md §8, §9.7, §9.8). */
export interface ReviewReporter {
  /** Returns the new `usage_id`. */
  reportUsage(input: ReportUsageInput): Promise<string>;
  reportReviewResult(input: ReportReviewResultInput): Promise<ReportReviewResultOutput>;
  close(): Promise<void>;
}

/**
 * Reporter over MCP streamable HTTP to the worker's agent-tools server,
 * authenticated with the execution's bearer token.
 */
export function createMcpReporter(url: string, token: string): ReviewReporter {
  let client: Client | undefined;

  async function connected(): Promise<Client> {
    if (client) return client;
    const created = new Client({ name: "orchestra-review", version: "0.0.1" });
    try {
      await created.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
    } catch (error) {
      throw new ReviewError(`cannot connect to agent-tools at ${url}: ${text(error, token)}`);
    }
    client = created;
    return created;
  }

  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const mcp = await connected();
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await mcp.callTool({ name, arguments: args });
    } catch (error) {
      throw new ReviewError(`${name} failed: ${text(error, token)}`);
    }
    const body =
      (result.content as Array<{ type: string; text?: string }> | undefined)
        ?.map((part) => part.text ?? "")
        .join("") ?? "";
    if (result.isError) {
      throw new ReviewError(`${name} failed: ${body}`);
    }
    if (result.structuredContent !== undefined) return result.structuredContent;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new ReviewError(`${name} returned no structured result`);
    }
  }

  return {
    async reportUsage(input) {
      const output = ReportUsageOutputSchema.safeParse(await call("report_usage", input));
      if (!output.success) throw new ReviewError("report_usage returned no usage_id");
      return output.data.usage_id;
    },
    async reportReviewResult(input) {
      const output = ReportReviewResultOutputSchema.safeParse(
        await call("report_review_result", input),
      );
      if (!output.success) {
        throw new ReviewError("report_review_result returned an unexpected result");
      }
      return output.data;
    },
    async close() {
      await client?.close().catch(() => {});
    },
  };
}

/** Error text with the bearer token removed. */
function text(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return token === "" ? message : message.split(token).join("[redacted]");
}
