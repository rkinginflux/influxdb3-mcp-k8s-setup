#!/usr/bin/env node
/** Streamable HTTP entry point; src/index.ts remains the stdio entry point. */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server/index.js";

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = createHash("sha256").update(header.slice(7)).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(supplied, expected);
}

export function createMcpHttpServer(token: string) {
  if (token.length < 32)
    throw new Error("MCP_HTTP_TOKEN must be at least 32 characters");
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    if (
      req.url !== "/mcp" ||
      !["GET", "POST", "DELETE"].includes(req.method ?? "")
    ) {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req.headers.authorization, token)) {
      res
        .writeHead(401, {
          "www-authenticate": "Bearer",
          "cache-control": "no-store",
        })
        .end();
      return;
    }
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once("close", () => void server.close());
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("[MCP HTTP] Request failed:", error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const token = process.env.MCP_HTTP_TOKEN ?? "";
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const port = Number(process.env.MCP_HTTP_PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MCP_HTTP_PORT must be a valid TCP port");
  }
  createMcpHttpServer(token).listen(port, host, () => {
    console.error(`[MCP HTTP] Listening on ${host}:${port}`);
  });
}
