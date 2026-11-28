// SPDX-License-Identifier: AGPL-3.0-only
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const qdrantUrl = process.env.SOCRATICODE_TEST_QDRANT_URL;
const root = fileURLToPath(new URL("../../", import.meta.url));
const cache = path.join(root, ".cache", "reliable-responses");
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

interface Output {
  text: string;
  isError: boolean;
  structured: Record<string, unknown> | undefined;
}

function output(value: unknown): Output {
  if (!record(value) || !Array.isArray(value.content)) throw new Error("Invalid MCP output");
  return {
    text: value.content.map((item: unknown) => record(item) && typeof item.text === "string" ? item.text : "").join("\n"),
    isError: value.isError === true,
    structured: record(value.structuredContent) ? value.structuredContent : undefined,
  };
}

describe.skipIf(!qdrantUrl)("Reliable results through shared stateless MCP", () => {
  let fixture: string;
  let main: string;
  let source: string;
  let backend: http.Server;
  let modelMissing = false;
  let apiRequests = 0;
  let blockedEmbedding = false;
  let blockedCalls = 0;
  let releaseEmbedding: (() => void) | undefined;
  const failedQueries = new Set<string>();
  const children: ChildProcess[] = [];
  const clients: Client[] = [];
  let client: Client;
  let searchPeer: Client;

  async function createClient(model: string): Promise<Client> {
    const address = backend.address();
    if (!address || typeof address === "string") throw new Error("Missing test API address");
    const child = spawn(process.execPath, ["--require", path.join(root, "tests", "helpers", "scan-failure.cjs"), path.join(root, "dist", "launcher.js")], {
      cwd: fixture, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, QDRANT_MODE: "external", QDRANT_URL: `http://127.0.0.1:${address.port}`,
        EMBEDDING_PROVIDER: "ollama", OLLAMA_MODE: "external", OLLAMA_URL: `http://127.0.0.1:${address.port}`,
        EMBEDDING_BATCH_SIZE: "8", EMBEDDING_MODEL: model, EMBEDDING_DIMENSIONS: "768", EMBEDDING_CONTEXT_LENGTH: "2048",
        SOCRATICODE_MCP_TRANSPORT: "http", SOCRATICODE_MCP_PORT: "0", SOCRATICODE_IDLE_TIMEOUT_MS: "0",
        SOCRATICODE_WATCHER: "off", SOCRATICODE_AUTO_RESUME: "off", SOCRATICODE_AUTO_CLEANUP: "off",
        TEMP: cache, TMP: cache },
    });
    children.push(child);
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP startup timed out: ${errors}`)), 15_000);
      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let end = buffer.indexOf("\n");
        while (end >= 0) {
          const message: unknown = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (record(message) && message.type === "socraticode/http-ready" && typeof message.url === "string") {
            clearTimeout(timer); resolve(message.url);
          }
          end = buffer.indexOf("\n");
        }
      });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`MCP exited ${code}: ${errors}`)); });
    });
    const connected = new Client({ name: "reliable-results-test", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await connected.connect(new StreamableHTTPClientTransport(new URL(url)));
    clients.push(connected);
    if (!searchPeer) {
      searchPeer = new Client({ name: "search-continuation-peer", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await searchPeer.connect(new StreamableHTTPClientTransport(new URL(url)));
    }
    return connected;
  }

  async function call(name: string, args: Record<string, unknown> = {}, connection = client): Promise<Output> {
    return output(await connection.callTool({ name, arguments: { projectPath: main, ...(["codebase_search", "codebase_graph_query", "codebase_symbols"].includes(name) ? { format: "json" } : {}), ...args } }));
  }

  async function index(projectPath: string, connection: Client): Promise<void> {
    expect((await call("codebase_index", { projectPath }, connection)).isError).toBe(false);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const status = await call("codebase_status", { projectPath }, connection);
      if (status.text.includes("Last operation: Full index — completed") && !status.text.includes("in progress")) return;
      await delay(100);
    }
    throw new Error("Fixture indexing did not complete");
  }

  beforeAll(async () => {
    if (!qdrantUrl || new URL(qdrantUrl).port === "16333") throw new Error("An isolated test Qdrant is required");
    fs.mkdirSync(cache, { recursive: true });
    fixture = fs.mkdtempSync(path.join(cache, "case-"));
    main = path.join(fixture, "main"); source = path.join(fixture, "source");
    fs.mkdirSync(path.join(main, "src"), { recursive: true }); fs.mkdirSync(source);
    fs.writeFileSync(path.join(main, "src", "leaf.ts"), "export function isolatedLeaf(): string { return 'reliable_result_main'; }\n");
    fs.writeFileSync(path.join(source, "source.ts"), "export function sourceMarker(): string { return 'reliable_result_source'; }\n");
    fs.writeFileSync(path.join(main, "src", "fenced.ts"), 'export const fencedCode = "\u0060\u0060\u0060";\n// \u0060\u0060\u0060\u0060\n');
    fs.writeFileSync(path.join(main, "src", "long-symbols.ts"), Array.from({ length: 8 }, (_, i) => "export function compactBudgetFunction" + i + "(): void {}").join("\n"));
    fs.mkdirSync(path.join(main, "graph"));
    fs.writeFileSync(path.join(main, "graph", "dep.ts"), "export const first = 1; export const second = 2;\n");
    fs.writeFileSync(path.join(main, "graph", "use.ts"), "import { first } from './dep';\nimport { second } from './dep';\nexport const sum = first + second;\n");
    fs.writeFileSync(path.join(main, "graph", "hub.ts"), "import { first } from './dep';\nimport { sum } from './use';\nexport const hub = first + sum;\n");
    fs.writeFileSync(path.join(main, "src", "page.ts"), [
      "export function pageAlpha(): void {}", "export function pageBeta(): void {}",
      "export function pageDelta(): void {}", "export function pageEpsilon(): void {}",
      "export function pageGamma(): void {}",
    ].join("\n"));
    fs.writeFileSync(path.join(main, "src", "full-fit.ts"), ["// full_fit_needle", ...Array<string>(104).fill("// a")].join("\n"));
    fs.mkdirSync(path.join(main, "search-pages"));
    for (let index = 0; index < 8; index++) {
      fs.writeFileSync(path.join(main, "search-pages", `hit-${index}.ts`), `export const searchHit${index} = "search_paging_needle_${index} ${"known fixture code ".repeat(24)}";\n`);
    }
    fs.mkdirSync(path.join(main, "provenance"));
    fs.mkdirSync(path.join(main, "node_modules", "fixture-lib"), { recursive: true });
    fs.writeFileSync(path.join(main, "package.json"), JSON.stringify({ dependencies: { "fixture-lib": "1", "local-alias": "1", "local-package": "*" } }));
    fs.writeFileSync(path.join(main, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "local-alias": ["provenance/local.ts"] } } }));
    fs.writeFileSync(path.join(main, "node_modules", "fixture-lib", "index.ts"), "export function packageNoise(): void {}\n");
    fs.mkdirSync(path.join(main, "provenance", "workspace"));
    fs.writeFileSync(path.join(main, "provenance", "workspace", "package.json"), JSON.stringify({ name: "local-package" }));
    fs.writeFileSync(path.join(main, "provenance", "workspace", "lib.ts"), "export function workspacePing(): void {}\n");
    fs.writeFileSync(path.join(main, "provenance", "local.ts"), "export function ping(): void {}\n");
    fs.writeFileSync(path.join(main, "provenance", "probe.ts"), [
      "import { ping as externalPing } from 'fixture-lib';",
      "import * as ns from 'fixture-lib';",
      "import * as fs from 'node:fs';",
      "import { ping as localPing } from 'local-alias';",
      "import { workspacePing } from 'local-package';",
      "import { ping as missingPing } from './absent';",
      "export function coverageProbe(): void {",
      "  externalPing(); ns.ping(); fs.readFileSync('x'); localPing(); missingPing(); JSON.stringify({}); unknown.ping(); workspacePing();",
      "}",
      "export function shadowProbe(JSON: { stringify(): void }, ns: { ping(): void }): void { JSON.stringify(); ns.ping(); }",
    ].join("\n"));
    fs.writeFileSync(path.join(main, ".socraticode.json"), JSON.stringify({ linkedProjects: [source] }));
    backend = http.createServer((request, response) => {
      apiRequests++;
      void (async (): Promise<void> => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const rawBody = Buffer.concat(chunks);
        const body: unknown = chunks.length ? JSON.parse(rawBody.toString()) : {};
        response.setHeader("content-type", "application/json");
        if (!request.url?.startsWith("/api/")) {
          const collection = /^\/collections\/([^/]+)\/points\/query/.exec(request.url ?? "")?.[1];
          if (collection && failedQueries.has(collection)) {
            response.writeHead(503); response.end(JSON.stringify({ status: { error: "deliberate source search failure" } }));
            return;
          }
          const upstream = await fetch(new URL(request.url ?? "/", qdrantUrl), {
            method: request.method, headers: { "content-type": "application/json" },
            ...(rawBody.length ? { body: rawBody } : {}),
          });
          response.writeHead(upstream.status); response.end(Buffer.from(await upstream.arrayBuffer()));
        } else if (request.url === "/api/tags") {
          response.end(JSON.stringify({ models: ["nomic-embed-text", ...(modelMissing ? [] : ["test-source-model"])]
            .map((name) => ({ name, model: name })) }));
        } else if (request.url === "/api/pull") {
          modelMissing = false; response.end(JSON.stringify({ status: "success" }));
        } else if (request.url === "/api/embed") {
          const input = record(body) ? body.input : undefined;
          const texts = Array.isArray(input) ? input : [input];
          if (texts.some((text: unknown) => typeof text === "string" && text.includes("cancellation_fixture_marker"))) {
            blockedCalls++;
            if (blockedEmbedding) await new Promise<void>((resolve) => { releaseEmbedding = resolve; });
          }
          // Выборка для постраничной выдачи должна попадать в свои восемь файлов даже при равных текстовых оценках.
          const embeddings = texts.map((text: unknown) => {
            const pageFixture = typeof text === "string" && text.includes("search_paging_needle");
            return [pageFixture ? 0 : 1, pageFixture ? 1 : 0, ...Array<number>(766).fill(0)];
          });
          response.end(JSON.stringify({ embeddings }));
        } else {
          response.writeHead(404); response.end("{}");
        }
      })().catch((error: unknown) => { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); });
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    client = await createClient("nomic-embed-text");
    await index(main, client);
    const sourceClient = await createClient("test-source-model");
    await index(source, sourceClient);
  });

  afterAll(async () => {
    await Promise.allSettled([...clients, searchPeer].map((connection) => connection.close()));
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => child.kill(), 35_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.send("shutdown");
    })));
    backend?.closeAllConnections();
    if (backend) await new Promise<void>((resolve) => backend.close(() => resolve()));
    if (fixture && path.resolve(fixture).startsWith(path.resolve(cache) + path.sep)) fs.rmSync(fixture, { recursive: true, force: true });
  });



  it("preserves importer-specific aliases and explicit symbol limits over shared HTTP", async () => {
    const project = path.join(fixture, "backport");
    for (const app of ["crm", "site"]) {
      const directory = path.join(project, app);
      fs.mkdirSync(path.join(directory, "src"), { recursive: true });
      fs.writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }));
      fs.writeFileSync(path.join(directory, "src", "util.ts"), "export function repeatedBackportName(): string { return 'backport_http_marker'; }\n");
      fs.writeFileSync(path.join(directory, "src", "main.ts"), "import { repeatedBackportName } from '@/util'; export function entry() { return repeatedBackportName(); }\n");
    }
    await index(project, client);
    for (const app of ["crm", "site"]) {
      const graph = await call("codebase_graph_query", { projectPath: project, filePath: app + "/src/main.ts", format: "json" });
      expect(graph.isError, graph.text).toBe(false);
      expect(graph.structured?.entries).toContainEqual({ kind: "import", file: app + "/src/util.ts" });
    }
    const symbol = await call("codebase_symbol", { projectPath: project, name: "repeatedBackportName", limit: 1 });
    expect(symbol.text).toContain('Showing 1 of 2 definitions of "repeatedBackportName"');
    expect(symbol.text.match(/^Symbol: /gm)).toHaveLength(1);
    for (const name of ["codebase_impact", "codebase_flow"]) {
      const result = await call(name, { projectPath: project, target: "repeatedBackportName", entrypoint: "repeatedBackportName", limit: 1 });
      expect(result.isError, result.text).toBe(false);
      expect(result.text).toContain('Showing 1 of 2 candidates for "repeatedBackportName"');
    }
  });

  it("keeps filter guidance in compact HTTP responses without changing source coverage", async () => {
    const result = await call("codebase_search", { query: "reliable_result_main", scope: "main", fileFilter: "src/", minScore: 0 });
    expect(result.isError, result.text).toBe(false);
    const warnings = JSON.stringify(result.structured?.warnings);
    expect(warnings).toContain("fileFilter takes one file path exactly");
    expect(warnings).not.toContain("Make sure the project has been indexed");
    expect(result.structured).toMatchObject({ status: "empty", partial: false, returned: 0, searchedSources: [main] });
  });

  it("returns a compact dependency picture by default without duplicate JSON records", async () => {
    const raw = await client.callTool({ name: "codebase_graph_query", arguments: { projectPath: main, filePath: "graph/use.ts" } });
    const compact = output(raw);
    expect(compact.isError, compact.text).toBe(false);
    expect(compact.text).toContain("graph/use.ts");
    expect(compact.text).toContain("Imports →\n  graph/dep.ts");
    expect(compact.text).toContain("Dependents ←\n  graph/hub.ts");
    expect(compact.text).not.toContain("(→ imports, ← dependents)");
    expect(compact.text.match(/graph\/dep\.ts/g)).toHaveLength(1);
    expect(compact.structured).toMatchObject({ total: 2, returned: 2, hasMore: false, partial: false });
    expect(compact.structured).not.toHaveProperty("entries");
    expect(compact.structured).not.toHaveProperty("revision");
    const json = await call("codebase_graph_query", { filePath: "graph/use.ts", format: "json" });
    expect(json.structured?.entries).toEqual([{ kind: "import", file: "graph/dep.ts" }, { kind: "dependent", file: "graph/hub.ts" }]);
    expect(json.text).not.toContain("graph/dep.ts");
    expect(JSON.stringify(raw).length).toBeLessThan(JSON.stringify(json).length);
  });


  it("stops between embedding packets, permits dry-run while busy and reports cancellation separately from failure", async () => {
    const project = path.join(fixture, "cancel");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "work.ts"), Array.from({ length: 160 }, () => "// cancellation_fixture_marker " + "x".repeat(170)).join("\n"));
    blockedEmbedding = true;
    blockedCalls = 0;
    try {
      expect((await call("codebase_index", { projectPath: project })).isError).toBe(false);
      const deadline = Date.now() + 10000;
      while (blockedCalls === 0 && Date.now() < deadline) await delay(20);
      expect(blockedCalls).toBe(1);
      const preview = await call("codebase_index", { projectPath: project, dryRun: true });
      expect(JSON.parse(preview.text)).toMatchObject({ operation: "index_plan", allowed: true });
      const stop = await call("codebase_stop", { projectPath: project });
      expect(stop.text).toContain("Cancellation requested");
      blockedEmbedding = false;
      releaseEmbedding?.();
      let status: Output | undefined;
      const finishDeadline = Date.now() + 10000;
      while (Date.now() < finishDeadline) {
        status = await call("codebase_status", { projectPath: project });
        if (!status.text.includes("index in progress") && status.text.includes("cancelled")) break;
        await delay(30);
      }
      expect(status?.text).toContain("— cancelled");
      expect(status?.text).not.toContain("— FAILED");
      expect(blockedCalls).toBe(1);
    } finally { blockedEmbedding = false; releaseEmbedding?.(); }
    await index(project, client);
    expect((await call("codebase_status", { projectPath: project })).text).not.toContain("INDEX IS INCOMPLETE");
  });

  it("previews chunk and byte budgets without service access and rejects excessive work before embeddings", async () => {
    const project = path.join(fixture, "budget");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "heavy.ts"), Array.from({ length: 200 }, (_, i) => "// budget line " + i + " " + "x".repeat(80)).join("\n"));
    const before = apiRequests;
    const preview = await call("codebase_index", { projectPath: project, dryRun: true, maxChunks: 1 });
    expect(preview.isError, preview.text).toBe(false);
    const plan: unknown = JSON.parse(preview.text);
    expect(record(plan)).toBe(true);
    if (!record(plan)) return;
    expect(plan).toMatchObject({ operation: "index_plan", allowed: false, maxChunks: 1 });
    expect(Number(plan.chunks)).toBeGreaterThan(1);
    expect(Number(plan.bytes)).toBeGreaterThan(10000);
    expect(apiRequests).toBe(before);
    const denied = await call("codebase_index", { projectPath: project, maxChunks: 1 });
    expect(denied.isError, denied.text).toBe(true);
    expect(denied.text).toContain("Index limit exceeded");
    expect(apiRequests).toBe(before);
    const bytes = await call("codebase_index", { projectPath: project, dryRun: true, maxBytes: 1000 });
    expect(JSON.parse(bytes.text)).toMatchObject({ allowed: false, maxBytes: 1000 });
  });

  it("reports file read failures, preserves old searchable code and persists incomplete state across clients", async () => {
    const file = path.join(main, "src", "scan-failure.ts");
    const flag = path.join(main, "src", ".fail-scan");
    fs.writeFileSync(file, "export const scanFailureMarker = 'known_old_scan_value';\n");
    expect((await call("codebase_update")).isError).toBe(false);
    fs.writeFileSync(file, "export const scanFailureMarker = 'known_new_scan_value';\n");
    fs.writeFileSync(flag, "");
    try {
      const failed = await call("codebase_update");
      expect(failed.isError, failed.text).toBe(true);
      expect(failed.text).toContain("scan-failure.ts");
      expect(failed.text).toMatch(/read|EACCES/i);
      const status = await call("codebase_status", {}, clients[1]);
      expect(status.text).toContain("INDEX IS INCOMPLETE");
      expect(status.text).toContain("scan-failure.ts");
      const search = await call("codebase_search", { scope: "main", query: "known_old_scan_value", fileFilter: "src/scan-failure.ts", minScore: 0 });
      expect(search.structured).toMatchObject({ partial: true });
      expect(JSON.stringify(search.structured?.entries)).toContain("known_old_scan_value");
      expect(JSON.stringify(search.structured?.entries)).not.toContain("known_new_scan_value");
    } finally { fs.rmSync(flag, { force: true }); }
    expect((await call("codebase_update")).isError).toBe(false);
    const recovered = await call("codebase_search", { scope: "main", query: "known_new_scan_value", fileFilter: "src/scan-failure.ts", minScore: 0 });
    expect(recovered.structured).toMatchObject({ partial: false });
    expect(JSON.stringify(recovered.structured?.entries)).toContain("known_new_scan_value");
  });

  it("returns complete ranked code as compact text by default, once per match", async () => {
    const args = { projectPath: main, query: "search_paging_needle", scope: "main", limit: 8, minScore: 0, maxChars: 100000 };
    const compactRaw = await client.callTool({ name: "codebase_search", arguments: args });
    const compact = output(compactRaw);
    const json = await call("codebase_search", { ...args, format: "json" });
    const entries = json.structured?.entries;
    if (!Array.isArray(entries) || !entries.length) throw new Error("Missing full search window");
    expect(compact.isError, compact.text).toBe(false);
    expect(compact.structured).not.toHaveProperty("entries");
    expect(compact.structured).toMatchObject({ total: entries.length, returned: entries.length, partial: false, coverageKnown: true, totalScope: "ranked_window" });
    let last = -1;
    for (const entry of entries) {
      if (!record(entry) || typeof entry.content !== "string" || typeof entry.file !== "string") throw new Error("Invalid search match");
      const position = compact.text.indexOf(entry.content);
      expect(position).toBeGreaterThan(last);
      expect(compact.text.indexOf(entry.content, position + entry.content.length)).toBe(-1);
      expect(compact.text).toContain(entry.file);
      expect(compact.text).not.toContain(String(entry.id));
      last = position;
    }
    expect(JSON.stringify(compactRaw).length).toBeLessThan(JSON.stringify(json).length);
  });

  it("keeps compact graph pagination across clients and permits changing presentation", async () => {
    const args = { projectPath: main, filePath: "graph/hub.ts", limit: 1, maxChars: 1000 };
    const raw = await client.callTool({ name: "codebase_graph_query", arguments: args });
    const first = output(raw);
    expect(first.isError, first.text).toBe(false);
    expect(first.structured).toMatchObject({ returned: 1, total: 2, hasMore: true, offset: 0, truncationReason: "page_limit" });
    expect(first.text).toContain("Imports →\n  graph/dep.ts");
    expect(String(first.structured?.nextCursor).length).toBeLessThan(100);
    expect(JSON.stringify(raw).length).toBeLessThanOrEqual(1000);
    const second = await call("codebase_graph_query", { ...args, cursor: first.structured?.nextCursor, format: "json" }, clients[1]);
    expect(second.isError, second.text).toBe(false);
    expect(second.structured).toMatchObject({ offset: 1, returned: 1, hasMore: false, entries: [{ kind: "import", file: "graph/use.ts" }] });
  });

  it("groups compact symbols by file and preserves exact identifiers for drill-down", async () => {
    const raw = await client.callTool({ name: "codebase_symbols", arguments: { projectPath: main, file: "src/page.ts" } });
    const compact = output(raw);
    const json = await call("codebase_symbols", { file: "src/page.ts", format: "json" });
    const entries = json.structured?.entries;
    if (!Array.isArray(entries) || entries.length !== 5) throw new Error("Missing fixture symbols");
    expect(compact.isError, compact.text).toBe(false);
    expect(compact.structured).not.toHaveProperty("entries");
    expect(compact.text.match(/src\/page\.ts/g)).toHaveLength(1);
    for (const entry of entries) {
      if (!record(entry) || typeof entry.id !== "string") throw new Error("Missing symbol id");
      const suffix = entry.id.slice("src/page.ts::".length);
      expect(compact.text).toContain(suffix);
      expect("src/page.ts::" + suffix).toBe(entry.id);
      const detail = await call("codebase_symbol", { name: String(entry.qualifiedName), file: "src/page.ts" });
      const impact = await call("codebase_impact", { symbolId: "src/page.ts::" + suffix });
      expect(impact.isError, impact.text).toBe(false);
      expect(detail.isError, detail.text).toBe(false);
      expect(detail.text).toContain(String(entry.name));
    }
    expect(JSON.stringify(raw).length).toBeLessThan(JSON.stringify(json).length / 2);
  });


  it("pages compact code without splitting matches and can continue as JSON without new API requests", async () => {
    const args = { projectPath: main, query: "search_paging_needle", scope: "main", limit: 8, minScore: 0 };
    const full = await call("codebase_search", { ...args, format: "json", maxChars: 100000 });
    const entries = full.structured?.entries;
    if (!Array.isArray(entries) || !entries.length) throw new Error("Missing baseline matches");
    let raw = await client.callTool({ name: "codebase_search", arguments: { ...args, maxChars: 2000 } });
    let page = output(raw);
    expect(page.structured?.hasMore).toBe(true);
    expect(String(page.structured?.nextCursor).length).toBeLessThan(80);
    const before = apiRequests;
    const tail = await call("codebase_search", { ...args, cursor: page.structured?.nextCursor, format: "json", maxChars: 100000 }, searchPeer);
    const firstMatches = entries.filter((entry) => record(entry) && typeof entry.content === "string" && page.text.includes(entry.content))
      .sort((a, b) => page.text.indexOf(String(a.content)) - page.text.indexOf(String(b.content)));
    if (!Array.isArray(tail.structured?.entries)) throw new Error("Missing snapshot continuation");
    const snapshotIds = [...firstMatches, ...tail.structured.entries].map((entry) => record(entry) ? entry.id : null);
    expect(apiRequests).toBe(before);
    const seen: unknown[] = [];
    for (let index = 0; index < 12; index++) {
      expect(page.isError, page.text).toBe(false);
      expect(JSON.stringify(raw).length).toBeLessThanOrEqual(index === 1 ? 4000 : 2000);
      expect(page.structured?.offset).toBe(seen.length);
      const jsonEntries = page.structured?.entries;
      if (Array.isArray(jsonEntries)) seen.push(...jsonEntries.map((entry) => record(entry) ? entry.id : null));
      else {
        const matches = entries.filter((entry) => record(entry) && typeof entry.content === "string" && page.text.includes(entry.content))
          .sort((a, b) => page.text.indexOf(String(a.content)) - page.text.indexOf(String(b.content)));
        expect(matches).toHaveLength(Number(page.structured?.returned));
        for (const entry of matches) if (record(entry)) {
          expect(page.text).toContain(String(seen.length + 1) + ". ");
          expect(seen).not.toContain(entry.id);
          seen.push(entry.id);
        }
      }
      if (!page.structured?.hasMore) break;
      const nextIndex = index + 1;
      raw = await searchPeer.callTool({ name: "codebase_search", arguments: {
        ...args, cursor: page.structured.nextCursor, maxChars: nextIndex === 1 ? 4000 : 2000,
        ...(nextIndex === 1 ? { format: "json" } : {}),
      } });
      page = output(raw);
      expect(apiRequests).toBe(before);
    }
    expect(page.structured?.hasMore).toBe(false);
    expect(seen).toEqual(snapshotIds);
    expect([...seen].sort()).toEqual(entries.map((entry) => record(entry) ? entry.id : null).sort());
  });

  it("keeps failed-source coverage in the compact presentation", async () => {
    const catalog = await call("codebase_list_projects");
    const sources = catalog.structured?.sources;
    if (!Array.isArray(sources) || !record(sources[0]) || typeof sources[0].collection !== "string") throw new Error("Missing source");
    failedQueries.add(sources[0].collection);
    try {
      const raw = await client.callTool({ name: "codebase_search", arguments: {
        projectPath: main, query: "isolatedLeaf", scope: "project", minScore: 0, fileFilter: "src/leaf.ts",
      } });
      const result = output(raw);
      expect(result.isError, result.text).toBe(false);
      expect(result.text).toContain("reliable_result_main");
      expect(result.text).toContain("Partial search");
      expect(result.structured).not.toHaveProperty("entries");
      expect(result.structured).toMatchObject({ status: "partial", partial: true, coverageKnown: true,
        searchedSources: [main], failedSources: [{ path: source, error: expect.stringContaining("deliberate source search failure") }] });
    } finally { failedQueries.clear(); }
  });


  it("returns the project catalog once, without copying structured JSON into text", async () => {
    const result = await call("codebase_list_projects");
    expect(result.isError, result.text).toBe(false);
    expect(result.structured).toMatchObject({ scope: "project", project: { path: main } });
    expect(result.text).not.toContain(main);
    expect(result.text).not.toContain('"collection"');
    expect(result.text.split("\n")).toHaveLength(1);
    const all = await call("codebase_list_projects", { scope: "all", limit: 1 });
    expect(all.isError, all.text).toBe(false);
    expect(all.structured?.projects).toBeDefined();
    expect(all.text).not.toContain('"collection"');
  });


  it("preserves code containing Markdown fences in the compact search response", async () => {
    const args = { query: "fencedCode", fileFilter: "src/fenced.ts", scope: "main", minScore: 0 };
    const json = await call("codebase_search", { ...args, format: "json" });
    const entries = json.structured?.entries;
    if (!Array.isArray(entries) || !record(entries[0]) || typeof entries[0].content !== "string") throw new Error("Missing fenced code");
    const compact = output(await client.callTool({ name: "codebase_search", arguments: { projectPath: main, ...args } }));
    expect(compact.isError, compact.text).toBe(false);
    expect(compact.text).toContain(entries[0].content);
    expect(compact.text.split("\n").filter((line) => line === "\u0060\u0060\u0060\u0060\u0060")).toHaveLength(2);
  });

  it("fits whole compact symbol records into a 512-character result and advances", async () => {
    const raw = await client.callTool({ name: "codebase_symbols", arguments: { projectPath: main, file: "src/long-symbols.ts", maxChars: 512 } });
    const first = output(raw);
    expect(first.isError, first.text).toBe(false);
    expect(JSON.stringify(raw).length).toBeLessThanOrEqual(512);
    expect(first.structured).toMatchObject({ total: 8, hasMore: true, truncationReason: "output_budget" });
    expect(Number(first.structured?.returned)).toBeGreaterThan(0);
    const second = await call("codebase_symbols", { file: "src/long-symbols.ts", maxChars: 512, format: "compact", cursor: first.structured?.nextCursor }, clients[1]);
    expect(second.isError, second.text).toBe(false);
    expect(second.structured?.offset).toBe(first.structured?.returned);
  });

  it("pages the ranked search window under a whole-response budget without losing or repeating code", async () => {
    const args = { projectPath: main, query: "search_paging_needle", scope: "main", limit: 20, minScore: 0, format: "json" };
    const baseline = output(await client.callTool({ name: "codebase_search", arguments: { ...args, maxChars: 100000 } }));
    const raw = await client.callTool({ name: "codebase_search", arguments: { ...args, maxChars: 2500 } });
    const first = output(raw);
    expect(first.isError, first.text).toBe(false);
    expect(JSON.stringify(raw).length).toBeLessThanOrEqual(2500);
    expect(first.structured).toMatchObject({ hasMore: true, truncated: true, truncationReason: "output_budget", totalScope: "ranked_window" });
    const collected: unknown[] = [];
    let page = first;
    while (true) {
      const entries = page.structured?.entries;
      if (!Array.isArray(entries) || !entries.length) throw new Error("Search continuation made no progress");
      collected.push(...entries);
      for (const entry of entries) {
        if (!record(entry) || typeof entry.content !== "string") throw new Error("Missing code");
        expect(page.text).not.toContain(entry.content);
      }
      if (!page.structured?.hasMore) break;
      if (collected.length > 50) throw new Error("Non-advancing search cursor");
      const next = await searchPeer.callTool({ name: "codebase_search", arguments: { ...args, maxChars: 2500, cursor: page.structured.nextCursor } });
      expect(JSON.stringify(next).length).toBeLessThanOrEqual(2500);
      page = output(next);
      expect(page.isError, page.text).toBe(false);
    }
    const baselineEntries = baseline.structured?.entries;
    if (!Array.isArray(baselineEntries)) throw new Error("Missing complete search window");
    expect(collected.map((entry) => record(entry) ? entry.id : null).sort()).toEqual(baselineEntries.map((entry) => record(entry) ? entry.id : null).sort());
    expect(collected.map((entry) => record(entry) ? entry.rank : null)).toEqual(Array.from({ length: collected.length }, (_, index) => index + 1));
    expect(new Set(collected.map((entry) => record(entry) ? entry.id : undefined)).size).toBe(collected.length);
  });


  it("returns a bounded explicit error when code or coverage cannot fit instead of a non-advancing cursor", async () => {
    const raw = await client.callTool({ name: "codebase_search", arguments: {
      projectPath: main, query: "search_paging_needle", scope: "main", limit: 20, minScore: 0, maxChars: 512,
    } });
    const result = output(raw);
    expect(result.isError).toBe(true);
    expect(result.structured).toMatchObject({ status: "budget_too_small", returned: 0, entries: [], nextCursor: null });
    expect(JSON.stringify(raw).length).toBeLessThanOrEqual(512);
  });


  it("serves tool help without probing external services", async () => {
    const before = apiRequests;
    const help = await call("codebase_about");
    expect(help.isError, help.text).toBe(false);
    expect(help.text).toContain("codebase_search");
    expect(help.text).toContain("codebase_health");
    expect(apiRequests).toBe(before);
    expect(help.text).not.toContain("Infrastructure:");
  });


  it("returns a quiet empty artifact list and shows setup only on explicit help", async () => {
    const empty = await call("codebase_context");
    expect(empty.isError, empty.text).toBe(false);
    expect(empty.text).toContain("No context artifacts configured");
    expect(empty.text.split("\n").length).toBe(1);
    expect(empty.text).not.toContain('"artifacts"');
    const help = await call("codebase_context", { help: true });
    expect(help.isError, help.text).toBe(false);
    expect(help.text).toContain(".socraticodecontextartifacts.json");
    expect(help.text).toContain('"artifacts"');
  });


  it("reports the completed update and searchable changes without replaying progress history", async () => {
    fs.writeFileSync(path.join(main, "src", "quiet-update.ts"), "export function quietUpdateMarker(): string { return 'quiet_update_visible'; }\n");
    const result = await call("codebase_update");
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain("Updated project index:");
    expect(result.text).toContain("Added: 1");
    expect(result.text).toContain("Updated: 0");
    expect(result.text).toContain("Removed: 0");
    expect(result.text).not.toContain("Progress:");
    expect(result.text).not.toContain("generating embeddings");
    expect(result.text).not.toContain("checkpointed");
    const found = await call("codebase_search", { scope: "main", query: "quietUpdateMarker", fileFilter: "src/quiet-update.ts", minScore: 0 });
    expect(JSON.stringify(found.structured?.entries)).toContain("quiet_update_visible");
  });


  it("continues the same partial search snapshot without repeating external requests", async () => {
    const catalog = await call("codebase_list_projects");
    const sources = catalog.structured?.sources;
    if (!Array.isArray(sources) || !record(sources[0]) || typeof sources[0].collection !== "string") throw new Error("Missing source collection");
    failedQueries.add(sources[0].collection);
    try {
      const args = { query: "search_paging_needle", scope: "project", limit: 20, minScore: 0, maxChars: 4500 };
      const first = await call("codebase_search", args);
      expect(first.isError, first.text).toBe(false);
      expect(first.structured).toMatchObject({ status: "partial", partial: true, hasMore: true, coverageKnown: true });
      const before = apiRequests;
      const second = await call("codebase_search", { ...args, cursor: first.structured?.nextCursor }, searchPeer);
      expect(second.isError, second.text).toBe(false);
      expect(apiRequests).toBe(before);
      expect(second.structured?.failedSources).toEqual(first.structured?.failedSources);
      expect(second.structured?.searchedSources).toEqual(first.structured?.searchedSources);
      expect(second.structured?.snapshotAt).toEqual(first.structured?.snapshotAt);
      expect(second.structured?.status).toBe("partial");
    } finally { failedQueries.clear(); }
  });

  it("rejects changed search filters and a cursor whose snapshot is absent from another server", async () => {
    const args = { query: "search_paging_needle", scope: "main", limit: 20, minScore: 0, maxChars: 2500 };
    const first = await call("codebase_search", args);
    expect(first.structured?.hasMore).toBe(true);
    const changed = await call("codebase_search", { ...args, query: "other query", cursor: first.structured?.nextCursor }, searchPeer);
    expect(changed.isError).toBe(true);
    expect(changed.structured).toMatchObject({ status: "cursor_invalid", entries: [], nextCursor: null });
    const foreign = await call("codebase_search", { ...args, cursor: first.structured?.nextCursor }, clients[1]);
    expect(foreign.isError).toBe(true);
    expect(foreign.structured).toMatchObject({ status: "cursor_stale", entries: [], nextCursor: null });
  });


  it("uses the complete response when it fits even if a partial page plus cursor would be larger", async () => {
    const args = { format: "json", projectPath: main, query: "full_fit_needle", scope: "main", limit: 2, minScore: 0, fileFilter: "src/full-fit.ts" };
    const fullRaw = await client.callTool({ name: "codebase_search", arguments: { ...args, maxChars: 100000 } });
    const full = output(fullRaw);
    expect(full.structured?.returned).toBe(2);
    const bounded = output(await client.callTool({ name: "codebase_search", arguments: { ...args, maxChars: JSON.stringify(fullRaw).length } }));
    expect(bounded.isError, bounded.text).toBe(false);
    expect(bounded.structured).toMatchObject({ returned: 2, hasMore: false });
    const completeEntries = full.structured?.entries;
    const boundedEntries = bounded.structured?.entries;
    if (!Array.isArray(completeEntries) || !Array.isArray(boundedEntries)) throw new Error("Missing search code");
    expect(boundedEntries.map((entry) => record(entry) ? entry.id : null).sort()).toEqual(completeEntries.map((entry) => record(entry) ? entry.id : null).sort());
  });

  it("keeps a completed index completed when a later source search prepares another model", async () => {
    const previousOperation = (await call("codebase_status")).text.match(/^Last operation:.*$/m)?.[0];
    modelMissing = true;
    const searched = await call("codebase_search", { query: "source marker", scope: "sources", minScore: 0 });
    expect(searched.isError, searched.text).toBe(false);
    expect(JSON.stringify(searched.structured?.entries)).toContain("reliable_result_source");
    const status = await call("codebase_status");
    expect(previousOperation).toContain("— completed");
    expect(status.text).toContain(previousOperation ?? "Missing completed operation");
    expect(status.text).not.toContain("in progress");
    const restarted = await call("codebase_index", { dryRun: true });
    expect(restarted.text).toContain('"operation":"index_plan"');
  });

  it("finds the same indexed file with slash and backslash filters", async () => {
    for (const scope of ["main", "project"]) {
      const slash = await call("codebase_search", { query: "isolatedLeaf", scope, fileFilter: "src/leaf.ts", minScore: 0 });
      const backslash = await call("codebase_search", { query: "isolatedLeaf", scope, fileFilter: "src\\leaf.ts", minScore: 0 });
      for (const result of [slash, backslash]) {
        expect(result.isError, result.text).toBe(false);
        expect(result.structured?.status).toBe("ok");
        expect(JSON.stringify(result.structured?.entries)).toContain("reliable_result_main");
      }
      expect(slash.structured?.entries).toEqual(backslash.structured?.entries);
    }
  });

  it("reports exact symbol totals and continues from a different MCP client without duplicates", async () => {
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await call("codebase_symbols", { file: "src/page.ts", limit: 2, ...(cursor ? { cursor } : {}) }, clients[page % 2]);
      expect(result.isError, result.text).toBe(false);
      expect(result.structured).toMatchObject({ total: 5, returned: page < 2 ? 2 : 1, hasMore: page < 2, truncated: page < 2 });
      const entries = result.structured?.entries;
      if (!Array.isArray(entries)) throw new Error("Missing page entries");
      for (const entry of entries) {
        if (!record(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") throw new Error("Invalid symbol entry");
        collected.push(entry.name);
      }
      const next = result.structured?.nextCursor;
      if (page < 2) { expect(typeof next).toBe("string"); cursor = String(next); }
      else expect(next).toBeNull();
    }
    expect(collected).toEqual(["pageAlpha", "pageBeta", "pageDelta", "pageEpsilon", "pageGamma"]);
  });

  it("rejects cursors for a different filter without silently restarting", async () => {
    const first = await call("codebase_symbols", { file: "src/page.ts", limit: 2 });
    const result = await call("codebase_symbols", { query: "page", cursor: first.structured?.nextCursor });
    expect(result.isError).toBe(true);
    expect(result.structured).toMatchObject({ status: "cursor_invalid", entries: [], nextCursor: null });
  });

  it("keeps whole records within the entire MCP response budget and advances", async () => {
    const raw = await client.callTool({ name: "codebase_symbols", arguments: { format: "json", projectPath: main, file: "src/page.ts", maxChars: 1200 } });
    const first = output(raw);
    expect(first.isError, first.text).toBe(false);
    expect(JSON.stringify(raw).length, JSON.stringify(raw)).toBeLessThanOrEqual(1200);
    expect(first.structured).toMatchObject({ total: 5, hasMore: true, truncated: true, truncationReason: "output_budget" });
    const entries = first.structured?.entries;
    if (!Array.isArray(entries) || !entries.length) throw new Error("No progress under budget");
    const second = await call("codebase_symbols", { file: "src/page.ts", maxChars: 1200, cursor: first.structured?.nextCursor }, clients[1]);
    expect(second.isError, second.text).toBe(false);
    expect(second.structured?.offset).toBe(entries.length);
    for (const entry of entries) expect(record(entry) && typeof entry.id === "string" && entry.id.includes("page")).toBe(true);
  });

  it("reports an insufficient budget without issuing a non-advancing cursor", async () => {
    const raw = await client.callTool({ name: "codebase_symbols", arguments: { format: "json", projectPath: main, file: "src/page.ts", maxChars: 512 } });
    const result = output(raw);
    expect(result.isError).toBe(true);
    expect(result.structured).toMatchObject({ status: "budget_too_small", returned: 0, nextCursor: null, entries: [] });
    expect(JSON.stringify(raw).length).toBeLessThanOrEqual(512);
  });

  it("reports an empty file-filtered search without suggesting reindexing a ready project", async () => {
    const result = await call("codebase_search", { query: "leaf", scope: "main", fileFilter: "absent.ts", minScore: 0 });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("No results");
    expect(result.text).not.toContain("Make sure the project has been indexed");
    expect(result.structured).toMatchObject({ status: "empty", partial: false, searchedSources: [main], failedSources: [] });
  });

  it("preserves healthy matches and declares failed sources instead of claiming complete coverage", async () => {
    const catalog = await call("codebase_list_projects");
    const sources = catalog.structured?.sources;
    if (!Array.isArray(sources) || !record(sources[0]) || typeof sources[0].collection !== "string") throw new Error("Missing source collection");
    failedQueries.add(sources[0].collection);
    try {
      const result = await call("codebase_search", { query: "reliable result", scope: "project", minScore: 0, fileFilter: "src/leaf.ts" });
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.structured?.entries)).toContain("reliable_result_main");
      expect(result.text).toContain("Partial search");
      expect(result.structured).toMatchObject({ status: "partial", partial: true, searchedSources: [main],
        failedSources: [{ path: source, error: expect.stringContaining("deliberate source search failure") }] });
    } finally {
      failedQueries.clear();
    }
  });

  it("reports a query failure as an MCP error when every selected source fails", async () => {
    const catalog = await call("codebase_list_projects");
    const project = catalog.structured?.project;
    const sources = catalog.structured?.sources;
    if (!record(project) || typeof project.collection !== "string" || !Array.isArray(sources)
      || !record(sources[0]) || typeof sources[0].collection !== "string") throw new Error("Missing collections");
    failedQueries.add(project.collection); failedQueries.add(sources[0].collection);
    try {
      const result = await call("codebase_search", { query: "reliable result", minScore: 0 });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Search failed");
      expect(result.text).not.toContain("No results found");
      expect(result.structured).toMatchObject({ status: "failed", searchedSources: [], failedSources: expect.any(Array) });
      expect(result.structured?.failedSources).toHaveLength(2);
    } finally {
      failedQueries.clear();
    }
  });

  it("lists each dependency file once even when several imports connect the same files", async () => {
    const consumer = await call("codebase_graph_query", { filePath: "graph/use.ts" });
    const dependency = await call("codebase_graph_query", { filePath: "graph/dep.ts" });
    expect(consumer.isError, consumer.text).toBe(false);
    expect(dependency.isError, dependency.text).toBe(false);
    expect(consumer.structured).toMatchObject({ total: 2, returned: 2, entries: [{ kind: "import", file: "graph/dep.ts" }, { kind: "dependent", file: "graph/hub.ts" }] });
    expect(dependency.structured).toMatchObject({ total: 2, returned: 2, entries: [{ kind: "dependent", file: "graph/hub.ts" }, { kind: "dependent", file: "graph/use.ts" }] });
  });

  it("distinguishes a missing graph file from a known file with zero dependencies", async () => {
    const absent = await call("codebase_graph_query", { filePath: "absent.ts" });
    expect(absent.text).toContain("File not found in the indexed graph");
    expect(absent.text).not.toContain("codebase_graph_build");
    const leaf = await call("codebase_graph_query", { filePath: "src/leaf.ts" });
    expect(leaf.text).toContain("No resolved imports or dependents");
    expect(leaf.text).not.toContain("codebase_graph_build");
  });

  it("separates proven package/runtime edges, local failures and unknown receivers", async () => {
    const symbol = await call("codebase_symbol", { name: "coverageProbe", file: "provenance/probe.ts" });
    expect(symbol.text).toContain("→ ping [external");
    expect(symbol.text).toContain("→ workspacePing [unresolved");
    expect(symbol.text).not.toContain("→ workspacePing [external");
    expect(symbol.text).toContain("→ readFileSync [runtime");
    expect(symbol.text).toContain("→ stringify [runtime");
    expect(symbol.text).toContain("→ ping [unique");
    expect(symbol.text).toContain("→ ping [unresolved");
    const shadow = await call("codebase_symbol", { name: "shadowProbe", file: "provenance/probe.ts" });
    expect(shadow.text).not.toContain("[external");
    expect(shadow.text).not.toContain("[runtime");
    const status = await call("codebase_graph_status");
    expect(status.text).toContain("Import targets: project");
    expect(status.text).toContain("external");
    expect(status.text).not.toContain("Most imports did not resolve");
    expect(status.text).toMatch(/External package edges: [1-9]/);
    expect(status.text).toMatch(/Runtime\/engine edges: [1-9]/);
    expect(status.text).toMatch(/Unresolved project edges: [1-9]/);
    expect(status.text).toMatch(/Unknown target edges: [1-9]/);
  });

  it("keeps installed packages outside the file and symbol graphs", async () => {
    const noise = await call("codebase_symbols", { query: "packageNoise" });
    expect(noise.structured).toMatchObject({ status: "empty", total: 0 });
    const file = await call("codebase_graph_query", { filePath: "node_modules/fixture-lib/index.ts" });
    expect(file.isError).toBe(true);
    const probe = await call("codebase_graph_query", { filePath: "provenance/probe.ts" });
    expect(probe.structured).toMatchObject({ entries: [{ kind: "import", file: "provenance/local.ts" }] });
    expect(JSON.stringify(probe)).not.toContain("node_modules");
  });

  it("rejects impact requests without a target instead of reporting success", async () => {
    const result = await call("codebase_impact");
    expect(result.isError).toBe(true);
  });

  it("paginates unique file dependencies between clients and rejects changed snapshots", async () => {
    const first = await call("codebase_graph_query", { filePath: "graph/hub.ts", limit: 1 });
    expect(first.structured).toMatchObject({ total: 2, returned: 1, hasMore: true, entries: [{ kind: "import", file: "graph/dep.ts" }] });
    const second = await call("codebase_graph_query", { filePath: "graph/hub.ts", limit: 1, cursor: first.structured?.nextCursor }, clients[1]);
    expect(second.structured).toMatchObject({ total: 2, returned: 1, hasMore: false, entries: [{ kind: "import", file: "graph/use.ts" }] });
    const symbols = await call("codebase_symbols", { file: "src/page.ts", limit: 2 }, clients[1]);
    fs.appendFileSync(path.join(main, "src", "page.ts"), "\nexport function pageZeta(): void {}\n");
    fs.appendFileSync(path.join(main, "graph", "hub.ts"), "\nimport { pageAlpha } from '../src/page';\n");
    await call("codebase_graph_build");
    const deadline = Date.now() + 15_000;
    let rebuilt = false;
    while (Date.now() < deadline) {
      const status = await call("codebase_graph_status");
      if (!status.text.includes("in progress") && !status.text.includes("building")) {
        const fresh = await call("codebase_symbols", { file: "src/page.ts" });
        if (fresh.structured?.total === 6) { rebuilt = true; break; }
      }
      await delay(100);
    }
    expect(rebuilt).toBe(true);
    for (const [tool, args] of [
      ["codebase_symbols", { file: "src/page.ts", cursor: symbols.structured?.nextCursor }],
      ["codebase_graph_query", { filePath: "graph/hub.ts", cursor: first.structured?.nextCursor }],
    ] as const) {
      const stale = await call(tool, args, clients[1]);
      expect(stale.isError).toBe(true);
      expect(stale.structured).toMatchObject({ status: "cursor_stale", entries: [], nextCursor: null });
    }
  });

  it("limits zero-impact claims to resolved references in the graph", async () => {
    const result = await call("codebase_impact", { target: "isolatedLeaf" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("No other files with resolved callers or references");
    expect(result.text).not.toContain("nothing else depends");
  });
});
