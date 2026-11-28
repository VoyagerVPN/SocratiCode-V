// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const qdrantUrl = process.env.SOCRATICODE_TEST_QDRANT_URL;
const ollamaUrl = process.env.SOCRATICODE_TEST_OLLAMA_URL;
const model = process.env.SOCRATICODE_TEST_EMBEDDING_MODEL ?? "nomic-embed-text";
const queryPrefix = process.env.SOCRATICODE_TEST_QUERY_PREFIX ?? "search_query: ";
const documentPrefix = process.env.SOCRATICODE_TEST_DOCUMENT_PREFIX ?? "search_document: ";
const cacheRoot = fileURLToPath(new URL("../../.cache/index-availability/", import.meta.url));
type GateMode = "open" | "hold" | "fail";
interface ToolOutput { text: string; isError: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toolOutput(value: unknown): ToolOutput {
  if (!isRecord(value) || !Array.isArray(value.content)) throw new Error("Invalid MCP tool result");
  return {
    text: value.content.map((part: unknown) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("\n"),
    isError: value.isError === true,
  };
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe.skipIf(!qdrantUrl || !ollamaUrl)("Search availability through the shipped MCP server", () => {
  let client: Client;
  let proxy: http.Server;
  let qdrantProxy: http.Server;
  let fixture: string;
  let source: string;
  let documentMode: GateMode = "open";
  let held: (() => void) | undefined;
  let release: (() => void) | undefined;
  let failWrites = false;
  let clientEnv: Record<string, string>;

  async function createClient(name: string): Promise<Client> {
    const connected = new Client({ name, version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await connected.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../../dist/launcher.js", import.meta.url))],
      cwd: fixture,
      stderr: "pipe",
      env: clientEnv,
    }));
    return connected;
  }

  async function forwardQdrant(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (failWrites && request.method === "PUT" && /^\/collections\/codebase_[^/]+\/points(?:\?|$)/.test(request.url ?? "")) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: { error: "deliberate test index write failure" } }));
      return;
    }
    const upstream = await fetch(new URL(request.url ?? "/", qdrantUrl), {
      method: request.method,
      headers: { "content-type": "application/json" },
      ...(body.length > 0 ? { body } : {}),
    });
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  }

  async function forward(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (request.url === "/api/embed") {
      const parsed: unknown = JSON.parse(body.toString("utf8"));
      const input = isRecord(parsed) ? parsed.input : undefined;
      const documents = typeof input === "string" ? [input] : Array.isArray(input) ? input : [];
      if (documents.some((text: unknown) => typeof text === "string" && text.startsWith(documentPrefix))) {
        if (documentMode === "hold") {
          await new Promise<void>((resolve) => { release = resolve; held?.(); });
        }
        if (documentMode === "fail") {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "deliberate test embedding failure" }));
          return;
        }
      }
    }
    const upstream = await fetch(new URL(request.url ?? "/", ollamaUrl), {
      method: request.method,
      headers: { "content-type": "application/json" },
      ...(body.length > 0 ? { body } : {}),
    });
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutput> {
    return toolOutput(await client.callTool({ name, arguments: { projectPath: fixture, ...args } }));
  }

  async function search(): Promise<string> {
    const result = await call("codebase_search", { query: "availability pilot marker", fileFilter: "availability.ts", limit: 50, minScore: 0 });
    if (result.isError) throw new Error(result.text);
    return result.text;
  }

  beforeAll(async () => {
    // Требуем отдельный тестовый Qdrant: рабочие коллекции этим тестом не затрагиваются.
    if (!qdrantUrl || new URL(qdrantUrl).port === "16333") throw new Error("An isolated Qdrant URL is required");
    fs.mkdirSync(cacheRoot, { recursive: true });
    fixture = fs.mkdtempSync(path.join(cacheRoot, "project-"));
    source = path.join(fixture, "availability.ts");
    fs.writeFileSync(path.join(fixture, ".socraticodeignore"), ".git/\n.cache/\nnode_modules/\ndist/\n");
    fs.writeFileSync(source, "export function availabilityPilotMarker(): string { return 'previous_successful_version'; }\n");
    proxy = http.createServer((request, response) => {
      void forward(request, response).catch((error: unknown) => {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy address");
    qdrantProxy = http.createServer((request, response) => {
      void forwardQdrant(request, response).catch((error: unknown) => {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      });
    });
    await new Promise<void>((resolve) => qdrantProxy.listen(0, "127.0.0.1", resolve));
    const qdrantAddress = qdrantProxy.address();
    if (!qdrantAddress || typeof qdrantAddress === "string") throw new Error("Missing Qdrant proxy address");
    clientEnv = {
        QDRANT_MODE: "external", QDRANT_URL: `http://127.0.0.1:${qdrantAddress.port}`,
        EMBEDDING_PROVIDER: "ollama", OLLAMA_MODE: "external",
        OLLAMA_URL: `http://127.0.0.1:${address.port}`,
        EMBEDDING_MODEL: model, EMBEDDING_DIMENSIONS: "768",
        EMBEDDING_CONTEXT_LENGTH: "2048", EMBEDDING_BATCH_SIZE: "8",
        EMBEDDING_QUERY_PREFIX: queryPrefix, EMBEDDING_DOCUMENT_PREFIX: documentPrefix,
        // Второе соединение позволяет искать, пока внешний провайдер держит обработку документа.
        OLLAMA_MAX_CONNECTIONS: "2",
        SOCRATICODE_WATCHER: "off", SOCRATICODE_AUTO_RESUME: "off",
        SOCRATICODE_AUTO_CLEANUP: "off",
        TEMP: cacheRoot, TMP: cacheRoot,
    };
    client = await createClient("index-availability-test");
    expect((await call("codebase_index")).isError).toBe(false);
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      const status = await call("codebase_status");
      if (status.text.includes("Last operation: Full index — completed") && !status.text.includes("in progress")) { ready = true; break; }
      await delay(200);
    }
    expect(ready).toBe(true);
    expect(await search()).toContain("previous_successful_version");
  });

  afterAll(async () => {
    documentMode = "open"; failWrites = false; release?.();
    if (client) {
      await call("codebase_remove");
      await client.close();
    }
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    }
    if (qdrantProxy) {
      qdrantProxy.closeAllConnections();
      await new Promise<void>((resolve, reject) => qdrantProxy.close((error) => error ? reject(error) : resolve()));
    }
    if (fixture) {
      const absolute = path.resolve(fixture);
      if (!absolute.startsWith(path.resolve(cacheRoot) + path.sep)) throw new Error("Fixture containment failed");
      fs.rmSync(absolute, { recursive: true, force: true });
    }
  });

  it("keeps the previous searchable version while replacement embeddings are pending and after they fail", async () => {
    documentMode = "hold";
    const pending = new Promise<void>((resolve) => { held = resolve; });
    fs.writeFileSync(source, "export function availabilityPilotMarker(): string { return 'replacement_version'; }\n");
    const updating = call("codebase_update");
    try {
      await Promise.race([pending, delay(20_000).then(() => { throw new Error("Document request was not observed"); })]);
      expect(await search()).toContain("previous_successful_version");
    } finally {
      documentMode = "fail"; release?.();
      const result = await updating;
      expect(result.isError).toBe(true);
    }
    documentMode = "open";
    expect(await search()).toContain("previous_successful_version");
  });

  it("keeps the previous searchable version when Qdrant rejects the replacement write", async () => {
    fs.writeFileSync(source, "export function availabilityPilotMarker(): string { return 'write_failure_version'; }\n");
    failWrites = true;
    try {
      const result = await call("codebase_update");
      expect(result.isError).toBe(true);
    } finally {
      failWrites = false;
    }
    expect(await search()).toContain("previous_successful_version");
  });

  it("keeps the previous searchable version during a resumed full index that fails to embed", async () => {
    documentMode = "hold";
    const pending = new Promise<void>((resolve) => { held = resolve; });
    expect((await call("codebase_index")).isError).toBe(false);
    try {
      await Promise.race([pending, delay(20_000).then(() => { throw new Error("Document request was not observed"); })]);
      expect(await search()).toContain("previous_successful_version");
    } finally {
      documentMode = "fail"; release?.();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const status = await call("codebase_status");
        if (!status.text.includes("in progress")) break;
        await delay(200);
      }
    }
    documentMode = "open";
    expect(await search()).toContain("previous_successful_version");
  });

  it("replaces a longer file and removes obsolete fragments after a successful write", async () => {
    const comments = Array.from({ length: 200 }, (_, index) => `// obsolete_fragment_marker_${index}\n`).join("");
    fs.writeFileSync(source, `export function availabilityPilotMarker(): string { return 'expanded_version'; }\n${comments}`);
    expect((await call("codebase_update")).isError).toBe(false);
    expect(await search()).toContain("obsolete_fragment_marker_");
    fs.writeFileSync(source, "export function availabilityPilotMarker(): string { return 'replacement_success'; }\n");
    expect((await call("codebase_update")).isError).toBe(false);
    const result = await search();
    expect(result).toContain("replacement_success");
    expect(result).not.toContain("obsolete_fragment_marker_");
  });

  it("removes an emptied file when the same batch also contains new searchable content", async () => {
    fs.writeFileSync(source, "");
    fs.writeFileSync(path.join(fixture, "second.ts"), "export function secondAvailabilityPilot(): string { return 'second_success'; }\n");
    expect((await call("codebase_update")).isError).toBe(false);
    expect(await search()).toContain("No results found");
    const second = await call("codebase_search", { query: "second availability pilot", fileFilter: "second.ts", minScore: 0 });
    expect(second.text).toContain("second_success");
  });

  it("removes a deleted file from search results", async () => {
    fs.unlinkSync(path.join(fixture, "second.ts"));
    expect((await call("codebase_update")).isError).toBe(false);
    const result = await call("codebase_search", { query: "second availability pilot", fileFilter: "second.ts", minScore: 0 });
    expect(result.text).toContain("No results found");
  });

  it("reports a competing process update as skipped rather than successfully updated", async () => {
    const competing = await createClient("competing-index-update-test");
    documentMode = "hold";
    const pending = new Promise<void>((resolve) => { held = resolve; });
    fs.writeFileSync(source, "export function availabilityPilotMarker(): string { return 'concurrent_update_success'; }\n");
    const updating = call("codebase_update");
    try {
      await Promise.race([pending, delay(20_000).then(() => { throw new Error("Document request was not observed"); })]);
      const result = toolOutput(await competing.callTool({ name: "codebase_update", arguments: { projectPath: fixture } }));
      expect(result.isError).toBe(false);
      expect(result.text).toContain("Index update skipped:");
      expect(result.text).not.toContain("Updated project index:");
    } finally {
      documentMode = "open"; release?.();
      await updating;
      await competing.close();
    }
    expect(await search()).toContain("concurrent_update_success");
  });
});
