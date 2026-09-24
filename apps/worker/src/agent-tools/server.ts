import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { agentTools } from "@orchestra/core";
import type { Db } from "@orchestra/db";
import type { Logger } from "../logger.js";
import { invokeTool, type ErasedToolDefinition, type InvokeDeps } from "./invoke.js";
import type { ExecutionRegistry } from "./registry.js";
import { resolveToken } from "./tokens.js";
import { TOOL_DEFINITIONS } from "./tools/index.js";

/**
 * The agent-tools MCP server (design.md §8): one streamable HTTP endpoint
 * per worker, bound to loopback, shared by every live execution and by the
 * `orchestra-review` wrapper.
 *
 * Stateless mode: every POST is authenticated on its own bearer token and
 * served by a fresh `McpServer` + transport pair bound to that token, so a
 * token revoked mid-session fails on its very next request. Unknown and
 * revoked tokens are turned away with HTTP 401 before any MCP handling;
 * per-tool state and role checks happen in `invokeTool`.
 */

export const AGENT_TOOLS_PATH = "/mcp";
export const DEFAULT_AGENT_TOOLS_HOST = "127.0.0.1";
/** Largest request body accepted. A full `SpecContent` is a few KB. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface AgentToolsServerOptions {
  db: Db;
  registry: ExecutionRegistry;
  logger: Logger;
  now?: () => Date;
}

export interface AgentToolsServer {
  /** Resolves once listening. Port 0 picks an ephemeral port. */
  start(port: number, host?: string): Promise<void>;
  /** Stops accepting connections and resolves once the socket is closed. */
  stop(): Promise<void>;
  /** `http://host:port/mcp`. Throws before `start` has resolved. */
  readonly url: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** `Authorization: Bearer <token>` -> token, else null. */
export function parseBearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

function sendRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, -32600, "Request body too large");
    }
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, -32700, "Parse error: body is not valid JSON");
  }
}

/** One `McpServer` whose eight tools act on behalf of `bearer`. */
function buildMcpServer(bearer: string, deps: InvokeDeps): McpServer {
  const mcp = new McpServer({ name: "orchestra-agent-tools", version: "1.0.0" });
  for (const def of TOOL_DEFINITIONS) {
    const schemas = agentTools[def.name];
    const erased = def as unknown as ErasedToolDefinition;
    // The core zod schemas are both the advertised JSON schema and the
    // validator: the SDK rejects input that fails `schemas.input` before
    // the callback runs, and output that fails `schemas.output` after.
    mcp.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: schemas.input,
        outputSchema: schemas.output,
      },
      (args: unknown) => invokeTool(erased, args, bearer, deps),
    );
  }
  return mcp;
}

export function createAgentToolsServer(
  options: AgentToolsServerOptions,
): AgentToolsServer {
  const deps: InvokeDeps = {
    db: options.db,
    registry: options.registry,
    logger: options.logger,
    now: options.now ?? (() => new Date()),
  };
  const { logger } = options;
  let server: http.Server | undefined;
  let address: AddressInfo | undefined;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== AGENT_TOOLS_PATH) {
      throw new HttpError(404, -32601, "Not found");
    }
    // Stateless: no SSE stream to GET and no session to DELETE.
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      throw new HttpError(405, -32000, "Method not allowed");
    }

    const bearer = parseBearer(req.headers.authorization);
    if (!bearer || !(await resolveToken(deps.db, bearer))) {
      res.setHeader("www-authenticate", 'Bearer realm="orchestra-agent-tools"');
      throw new HttpError(401, -32001, "UNAUTHORIZED: missing, unknown, or revoked token");
    }

    const body = await readJsonBody(req);
    const mcp = buildMcpServer(bearer, deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        sendRpcError(res, err.status, err.rpcCode, err.message);
        return;
      }
      // Never log request headers: they carry the bearer token.
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "agent-tools request failed",
      );
      sendRpcError(res, 500, -32603, "Internal error");
    });
  };

  return {
    async start(port, host = DEFAULT_AGENT_TOOLS_HOST) {
      if (server) throw new Error("agent-tools server already started");
      const created = http.createServer(onRequest);
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(port, host, () => {
          created.off("error", reject);
          resolve();
        });
      });
      server = created;
      address = created.address() as AddressInfo;
      logger.info({ url: this.url }, "agent-tools server listening");
    },

    async stop() {
      const current = server;
      if (!current) return;
      server = undefined;
      address = undefined;
      await new Promise<void>((resolve, reject) => {
        current.close((err) => (err ? reject(err) : resolve()));
        current.closeIdleConnections();
      });
    },

    get url() {
      if (!address) throw new Error("agent-tools server is not listening");
      const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
      return `http://${host}:${address.port}${AGENT_TOOLS_PATH}`;
    },
  };
}
