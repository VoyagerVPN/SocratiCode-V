// SPDX-License-Identifier: AGPL-3.0-only
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cache = path.join(root, ".cache", "managed-readiness");
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
// Подменяются только внешние границы: Docker CLI, HTTP-сервисы и часы процесса.
const boundaryPreload = String.raw`
const cp = require('node:child_process'), fs = require('node:fs'), util = require('node:util');
const original = cp.execFile, originalAsync = util.promisify(original), originalNow = Date.now;
Date.now = () => originalNow() + Number(fs.readFileSync(process.env.READINESS_CLOCK, 'utf8'));
cp.execFile = function (file, args, options, callback) {
  if (file === 'docker') throw new Error('Docker must use the fixture boundary');
  return original(file, args, { ...options, shell: false, windowsHide: true }, callback);
};
cp.execFile[util.promisify.custom] = async (file, args, options) => {
  if (file !== 'docker') return originalAsync(file, args, { ...options, shell: false, windowsHide: true });
  const response = await fetch(process.env.READINESS_BOUNDARY + '/fixture/docker', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return { stdout: result.stdout, stderr: '' };
};
require('node:module').syncBuiltinESMExports();
`;
describe("Managed readiness through five stateless MCP clients", () => {
  let fixture: string, clock: string, backend: http.Server, child: ChildProcess | undefined;
  let qdrantUp: boolean, ollamaUp: boolean, dockerFails: boolean, hangingHealth: boolean, modelPresent: boolean, pulls: number;
  const dockerCommands: string[][] = [];
  const clients: Client[] = [];
  const profile = {
    schemaVersion: 1, indexFormatVersion: 2, kind: "code", source: "fresh",
    queryPrefix: "Query: ", documentPrefix: "Document: ", documentIncludesPath: true,
    maxChunkChars: 2000, legacyUnverifiedFields: [], extensionLanguageMap: {}, maxFileBytes: 1048576,
    embedding: { provider: "ollama", model: "fixture-jina", dimensions: 768, contextLength: 2048, litellmSendDimensions: true },
  };
  beforeEach(async () => {
    fs.mkdirSync(cache, { recursive: true });
    fixture = fs.mkdtempSync(path.join(cache, "case-"));
    clock = path.join(fixture, "clock"); fs.writeFileSync(clock, "0");
    const preload = path.join(fixture, "boundary.cjs"); fs.writeFileSync(preload, boundaryPreload);
    qdrantUp = true; ollamaUp = true; dockerFails = false; hangingHealth = false;
    modelPresent = true; pulls = 0; dockerCommands.length = 0;
    backend = http.createServer((request, response) => {
      void (async (): Promise<void> => {
        const buffers: Buffer[] = [];
        for await (const buffer of request) buffers.push(Buffer.from(buffer));
        const body: unknown = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : {};
        response.setHeader("content-type", "application/json");
        const send = (result: unknown): void => { response.end(JSON.stringify({ result, status: "ok", time: 0.001 })); };
        if (request.url === "/fixture/docker") {
          const args = record(body) && Array.isArray(body.args) ? body.args.filter((item): item is string => typeof item === "string") : [];
          dockerCommands.push(args); await delay(40);
          if (dockerFails) { response.writeHead(500); response.end(JSON.stringify({ error: "fixture Docker unavailable" })); return; }
          let stdout = "";
          if (args[0] === "images") stdout = "qdrant/qdrant:v1.17.0\nollama/ollama:latest\n";
          else if (args[0] === "ps") {
            const name = args.includes("name=socraticode-qdrant") ? "socraticode-qdrant" : "socraticode-ollama";
            if (args.includes("-a") || (name === "socraticode-qdrant" ? qdrantUp : ollamaUp)) stdout = name;
          } else if (args[0] === "start") {
            if (args[1] === "socraticode-qdrant") { qdrantUp = true; hangingHealth = false; }
            else if (args[1] === "socraticode-ollama") ollamaUp = true;
            else throw new Error("Unexpected container");
          } else if (args[0] !== "info") throw new Error("Unexpected Docker mutation: " + args.join(" "));
          response.end(JSON.stringify({ stdout })); return;
        }
        if (request.url === "/readyz" || request.url === "/healthz") {
          if (hangingHealth) return;
          response.writeHead(qdrantUp ? 200 : 503); response.end("{}"); return;
        }
        if (request.url === "/api/tags") {
          response.writeHead(ollamaUp ? 200 : 503);
          response.end(JSON.stringify(ollamaUp ? { models: modelPresent ? [{ name: "fixture-jina", model: "fixture-jina" }] : [] } : { error: "fixture service stopped" })); return;
        }
        if (request.url === "/api/pull") {
          pulls++; modelPresent = true; response.end(JSON.stringify({ status: "success" })); return;
        }
        if (request.url === "/api/embed") {
          if (!ollamaUp) { response.writeHead(503); response.end(JSON.stringify({ error: "fixture service stopped" })); return; }
          response.end(JSON.stringify({ embeddings: [[1, ...Array<number>(767).fill(0)]] })); return;
        }
        if (!qdrantUp) { response.writeHead(503); response.end(JSON.stringify({ status: { error: "fixture service stopped" } })); return; }
        if (request.url?.endsWith("/points/query")) {
          send({ points: [{ id: 1, score: 0.8, payload: { filePath: path.join(fixture, "sample.ts"), relativePath: "sample.ts",
            content: "export const readinessMarker = 'healthy';", startLine: 1, endLine: 1, language: "typescript" } }] }); return;
        }
        if (request.url === "/collections/socraticode_metadata/points") {
          send([{ id: 1, payload: { effectiveIndexProfile: JSON.stringify(profile) } }]); return;
        }
        if (request.url?.startsWith("/collections/")) {
          send({ status: "green", points_count: 1, config: { params: { vectors: { dense: { size: 768, distance: "Cosine" } } } } }); return;
        }
        response.writeHead(404); response.end("{}");
      })().catch((error: unknown) => { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); });
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    const address = backend.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const url = "http://127.0.0.1:" + address.port;
    child = spawn(process.execPath, ["--require", path.join(root, "scripts", "windows-test-processes.cjs"), "--require", preload, path.join(root, "dist", "launcher.js")], {
      cwd: fixture, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, QDRANT_MODE: "managed", QDRANT_URL: "", QDRANT_HOST: "127.0.0.1", QDRANT_PORT: String(address.port),
        OLLAMA_MODE: "docker", OLLAMA_HOST: url, OLLAMA_URL: url, OLLAMA_PORT: String(address.port),
        EMBEDDING_PROVIDER: "ollama", EMBEDDING_MODEL: "fixture-jina", EMBEDDING_DIMENSIONS: "768",
        SOCRATICODE_WATCHER: "off", SOCRATICODE_AUTO_RESUME: "off", SOCRATICODE_AUTO_CLEANUP: "off",
        SOCRATICODE_IDLE_STOP_TIMEOUT_MS: "off", SOCRATICODE_IDLE_TIMEOUT_MS: "0",
        SOCRATICODE_MCP_TRANSPORT: "http", SOCRATICODE_MCP_PORT: "0",
        READINESS_CLOCK: clock, READINESS_BOUNDARY: url, TEMP: cache, TMP: cache },
    });
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    const mcpUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP startup timeout: " + errors)), 15_000);
      let buffer = "";
      child?.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let end = buffer.indexOf("\n");
        while (end >= 0) {
          const message: unknown = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (record(message) && message.type === "socraticode/http-ready" && typeof message.url === "string") { clearTimeout(timer); resolve(message.url); }
          end = buffer.indexOf("\n");
        }
      });
      child?.once("exit", (code) => { clearTimeout(timer); reject(new Error("MCP exited " + code + ": " + errors)); });
    });
    for (let index = 0; index < 5; index++) {
      const client = new Client({ name: "readiness-client-" + index, version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl))); clients.push(client);
    }
  });
  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    if (child && child.exitCode === null) {
      const processToStop = child;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => processToStop.kill(), 35_000);
        processToStop.once("exit", () => { clearTimeout(timer); resolve(); }); processToStop.send("shutdown");
      });
    }
    child = undefined;
    backend?.closeAllConnections();
    if (backend) await new Promise<void>((resolve) => backend.close(() => resolve()));
    if (fixture && path.resolve(fixture).startsWith(path.resolve(cache) + path.sep)) fs.rmSync(fixture, { recursive: true, force: true });
  });
  async function searches(): Promise<void> {
    const results = await Promise.all(clients.map((client) => client.callTool({ name: "codebase_search",
      arguments: { projectPath: fixture, query: "readinessMarker", scope: "main", minScore: 0 } })));
    for (const result of results) {
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.content.map((item) => item.type === "text" ? item.text : "").join("\n")).toContain("readinessMarker");
    }
  }
  it("serves five fresh searches on healthy services without Docker CLI, including after readiness expiry", async () => {
    await searches(); fs.writeFileSync(clock, "61000"); await searches(); expect(dockerCommands).toEqual([]);
  });
  it("resumes each stopped service once for five concurrent searches", async () => {
    qdrantUp = false; ollamaUp = false;
    await searches();
    expect(dockerCommands.filter((args) => args[0] === "start" && args[1] === "socraticode-qdrant")).toHaveLength(1);
    expect(dockerCommands.filter((args) => args[0] === "start" && args[1] === "socraticode-ollama")).toHaveLength(1);
  });
  it("recovers services lost inside the readiness TTL without waiting for expiry", async () => {
    await searches();
    qdrantUp = false; ollamaUp = false;
    await searches();
    expect(dockerCommands.filter((args) => args[0] === "start" && args[1] === "socraticode-qdrant")).toHaveLength(1);
    expect(dockerCommands.filter((args) => args[0] === "start" && args[1] === "socraticode-ollama")).toHaveLength(1);
  });
  it("reports failed restoration to all clients and permits the next attempt", async () => {
    qdrantUp = false; dockerFails = true;
    const results = await Promise.all(clients.map((client) => client.callTool({ name: "codebase_search",
      arguments: { projectPath: fixture, query: "readinessMarker", scope: "main", minScore: 0 } })));
    expect(results.every((result) => result.isError === true)).toBe(true);
    expect(dockerCommands.filter((args) => args[0] === "info")).toHaveLength(1);
    dockerFails = false; await searches();
    expect(dockerCommands.filter((args) => args[0] === "start" && args[1] === "socraticode-qdrant")).toHaveLength(1);
  });
  it("allows a new embedding readiness attempt after Ollama restoration failed", async () => {
    ollamaUp = false; dockerFails = true;
    const results = await Promise.all(clients.map((client) => client.callTool({ name: "codebase_search",
      arguments: { projectPath: fixture, query: "readinessMarker", scope: "main", minScore: 0 } })));
    expect(results.every((result) => result.isError === true)).toBe(true);
    dockerFails = false; await searches();
    expect(dockerCommands.filter((args) => args[0] === "start" && args[1] === "socraticode-ollama")).toHaveLength(1);
  });
  it("bounds a hanging HTTP readiness probe before restoring the stopped service", async () => {
    qdrantUp = false; hangingHealth = true;
    const started = performance.now();
    await searches();
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(dockerCommands.filter((args) => args[0] === "start" && args[1] === "socraticode-qdrant")).toHaveLength(1);
  });
  it("fetches a missing selected model once without treating the healthy service as stopped", async () => {
    modelPresent = false;
    await searches();
    expect(pulls).toBe(1);
    expect(dockerCommands).toEqual([]);
  });

});
