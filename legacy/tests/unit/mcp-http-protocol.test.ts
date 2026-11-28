import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type McpHttpRuntime, startMcpHttp } from "../../src/services/mcp-http.js";

let runtime: McpHttpRuntime;
let instances = 0;
const _meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "http-protocol-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

beforeEach(async () => {
  instances = 0;
  runtime = await startMcpHttp(() => {
    const instance = ++instances;
    const server = new McpServer({ name: "http-protocol-fixture", version: "1" });
    server.registerTool("echo", { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { content: [{ type: "text", text: `${instance}:${text}` }] };
    });
    return server;
  }, 0);
});

afterEach(async () => { await runtime?.close(); });

async function post(method: string, params: Record<string, unknown>, id = 1): Promise<Response> {
  return fetch(runtime.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      ...(params._meta ? { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method,
        ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
      } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

describe("modern stateless HTTP", () => {
  it("discovers without initialize and creates a fresh server for each request", async () => {
    const discover = await post("server/discover", { _meta });
    expect(discover.status, await discover.clone().text()).toBe(200);
    expect(discover.headers.get("mcp-session-id")).toBeNull();
    expect(await discover.json()).toMatchObject({ result: { supportedVersions: ["2026-07-28"] } });
    const listed = await post("tools/list", { _meta });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ result: { tools: [expect.objectContaining({ name: "echo" })] } });
    expect(instances).toBe(2);
  });

  it("rejects legacy initialize without falling back", async () => {
    const rejected = await post("initialize", {
      protocolVersion: "2025-11-25", clientInfo: { name: "obsolete-test", version: "1" }, capabilities: {},
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: -32022, data: { supported: ["2026-07-28"] } } });
    expect(instances).toBe(0);
  });

  it("serves five simultaneous requests without a session or shared server instance", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      post("tools/call", { _meta, name: "echo", arguments: { text: `agent-${index}` } }, index + 1)));
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBeNull();
      expect(await response.json()).toMatchObject({ id: index + 1, result: {
        content: [expect.objectContaining({ text: expect.stringContaining(`:agent-${index}`) })],
      } });
    }
    expect(instances).toBe(5);
  });

  it("rejects a foreign browser origin before running the factory", async () => {
    const response = await fetch(runtime.url, { method: "POST", headers: { Origin: "https://example.org" } });
    expect(response.status).toBe(403);
    expect(instances).toBe(0);
  });
});
