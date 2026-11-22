import http from "node:http";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type McpServerFactory } from "@modelcontextprotocol/server";

export interface McpHttpRuntime {
  url: string;
  close(): Promise<void>;
}

/** Общий stateless-сервер SDK для локальных MCP-клиентов без legacy-сессий. */
export async function startMcpHttp(factory: McpServerFactory, port: number): Promise<McpHttpRuntime> {
  const handler = createMcpHandler(factory, { legacy: "reject" });
  const handle = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = http.createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    void handle(request, response).catch((error: unknown) => {
      process.stderr.write(`MCP HTTP request failed: ${String(error)}\n`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    await handler.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP HTTP address unavailable");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close(): Promise<void> {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
