// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * MCP logging at the protocol level (#178).
 *
 * The logger forwards every line as `notifications/message` once the server is
 * hosted, and stops writing to stderr. The SDK delivers those notifications
 * only when the server declares the `logging` capability, so without it every
 * log line was dropped. These tests start the real server over stdio and speak
 * JSON-RPC to it, the way an MCP host does.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: { level?: string; logger?: string; data?: unknown };
  result?: { capabilities?: Record<string, unknown> } & Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** Nothing listens here, so external Qdrant readiness fails without touching a real server. */
const UNREACHABLE = "http://127.0.0.1:9";

let child: ChildProcessWithoutNullStreams | undefined;
let workDir = "";

beforeEach(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-logging-protocol-"));
});

afterEach(async () => {
  child?.kill("SIGKILL");
  child = undefined;
  await fsp.rm(workDir, { recursive: true, force: true });
});

/** Изолированное окружение: проверки протокола не обращаются к рабочим контейнерам. */
function serverEnv(logFile: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(QDRANT_|OLLAMA_|EMBEDDING_|SOCRATICODE_)/.test(key)) env[key] = value;
  }
  Object.assign(env, {
    QDRANT_MODE: "external",
    QDRANT_URL: UNREACHABLE,
    OLLAMA_MODE: "external",
    OLLAMA_URL: UNREACHABLE,
    SOCRATICODE_AUTO_RESUME: "off",
    SOCRATICODE_WATCHER: "off",
    SOCRATICODE_LOG_LEVEL: "info",
    SOCRATICODE_LOG_FILE: logFile,
  });
  return env;
}

/** Start the server from source over stdio, isolated from the caller's configuration. */
function startServer(logFile: string) {
  const proc = spawn(process.execPath, ["--import", "tsx", path.resolve("src/index.ts")], {
    cwd: path.resolve("."),
    env: serverEnv(logFile),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child = proc;

  const received: RpcMessage[] = [];
  let stderr = "";
  let exited: Error | undefined;
  const waiters = new Map<number, { resolve: (msg: RpcMessage) => void; reject: (err: Error) => void }>();
  const exitCode = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));

  let buffer = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line) continue;
      const msg = JSON.parse(line) as RpcMessage;
      received.push(msg);
      if (typeof msg.id === "number") {
        waiters.get(msg.id)?.resolve(msg);
        waiters.delete(msg.id);
      }
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  // A server that fails to start fails the test at once, with its stderr,
  // instead of leaving every request waiting out the test timeout.
  proc.on("close", (code, signal) => {
    exited = new Error(`server exited (code ${code}, signal ${signal}); stderr:\n${stderr}`);
    for (const waiter of waiters.values()) waiter.reject(exited);
    waiters.clear();
  });
  proc.stdin.on("error", () => {
    // EPIPE after the server has gone; the close handler reports why.
  });

  let nextId = 1;
  const request = (method: string, params: unknown): Promise<RpcMessage> =>
    new Promise((resolve, reject) => {
      if (exited) return reject(exited);
      const id = nextId++;
      waiters.set(id, { resolve, reject });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method: string): void => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  };
  const logNotifications = (containing: string): RpcMessage[] =>
    received.filter((m) => m.method === "notifications/message" && String(m.params?.data).includes(containing));

  const initialize = async (protocolVersion = "2024-11-05"): Promise<RpcMessage> => {
    const init = await request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "logging-protocol-test", version: "1.0.0" },
    });
    notify("notifications/initialized");
    return init;
  };

  return {
    proc,
    request,
    initialize,
    logNotifications,
    exitCode,
    stderr: () => stderr,
    exited: () => exited,
  };
}

async function waitFor(check: () => boolean, timeoutMs: number, failed: () => Error | undefined): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    const failure = failed();
    if (failure) throw failure;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((done) => setTimeout(done, 25));
  }
}

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe("MCP logging over stdio", () => {
  it("connects a modern SDK client and preserves tool schemas", async () => {
    const client = new Client(
      { name: "sdk-v2-protocol-test", version: "1.0.0" },
      {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.resolve("src/index.ts")],
      cwd: path.resolve("."),
      env: serverEnv(path.join(workDir, "sdk-v2.log")),
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      transport.stderr?.resume();
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getServerVersion()?.name).toBe("socraticode");
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(26);
      const catalog = listed.tools.find((tool) => tool.name === "codebase_list_projects");
      expect(catalog?.inputSchema.properties?.scope).toMatchObject({ default: "project", enum: ["project", "all"] });
      expect(catalog?.outputSchema).toMatchObject({ type: "object" });
      const about = await client.callTool({ name: "codebase_about", arguments: {} });
      expect(about.isError).not.toBe(true);
      expect(about.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: expect.stringContaining("SocratiCode") }),
        ]),
      );
    } finally {
      await client.close();
    }
  });

  it("serves MCP 2026-07-28 discovery and tools without initialize", async () => {
    const server = startServer(path.join(workDir, "modern.log"));
    const _meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "modern-protocol-test",
        version: "1.0.0",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const discover = await server.request("server/discover", { _meta });
    expect(discover.error).toBeUndefined();
    expect(discover.result).toMatchObject({
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
    });

    const listed = await server.request("tools/list", { _meta });
    expect(listed.error).toBeUndefined();
    expect(listed.result?.tools).toHaveLength(26);
    expect(listed.result?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "codebase_search" }),
        expect.objectContaining({
          name: "codebase_list_projects",
          outputSchema: expect.any(Object),
        }),
      ]),
    );

    const about = await server.request("tools/call", {
      _meta,
      name: "codebase_about",
      arguments: {},
    });
    expect(about.error).toBeUndefined();
    expect(about.result).toMatchObject({
      content: [
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("SocratiCode"),
        }),
      ],
    });
    server.proc.stdin.end();
    expect(await server.exitCode).toBe(0);
  });

  it("rejects legacy initialize even after a modern discovery probe", async () => {
    const server = startServer(path.join(workDir, "fallback.log"));
    const discover = await server.request("server/discover", {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": {
          name: "fallback-protocol-test",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    });
    expect(discover.error).toBeUndefined();
    const init = await server.initialize("2025-11-25");
    expect(init.error).toMatchObject({ code: -32022, data: { supported: ["2026-07-28"] } });
  });

  it("reports unsupported modern versions and accepts a corrected opening", async () => {
    const server = startServer(path.join(workDir, "unsupported.log"));
    const _meta = {
      "io.modelcontextprotocol/protocolVersion": "2099-01-01",
      "io.modelcontextprotocol/clientInfo": {
        name: "version-protocol-test",
        version: "1.0.0",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const rejected = await server.request("server/discover", { _meta });
    expect(rejected.error).toMatchObject({
      code: -32022,
      data: {
        supported: ["2026-07-28"],
        requested: "2099-01-01",
      },
    });
    _meta["io.modelcontextprotocol/protocolVersion"] = "2026-07-28";
    const discover = await server.request("server/discover", { _meta });
    expect(discover.error).toBeUndefined();
    expect(discover.result?.supportedVersions).toEqual(["2026-07-28"]);
  });

  it("delivers request logs when the modern client opts in", async () => {
    const logFile = path.join(workDir, "server.log");
    const server = startServer(logFile);

    const _meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "request-logs-test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/logLevel": "info",
    };
    const discover = await server.request("server/discover", { _meta });
    expect(discover.error).toBeUndefined();

    // A post-initialization log with a known text: codebase_index reports it is
    // checking the external Qdrant before that check fails. The call itself is
    // left to fail on its own; only the log line matters here.
    const marker = `Checking external Qdrant at ${UNREACHABLE}...`;
    server
      .request("tools/call", {
        _meta,
        name: "codebase_index",
        arguments: { projectPath: workDir },
      })
      .catch(() => {});

    await waitFor(() => server.logNotifications(marker).length > 0, 60_000, server.exited);
    // Give a duplicate, if there were one, time to arrive.
    await new Promise((done) => setTimeout(done, 300));

    const matches = server.logNotifications(marker);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.params).toMatchObject({
      level: "info",
      logger: "socraticode",
    });
    // Forwarding does not also write the line to stderr, and the log file still gets it.
    expect(server.stderr()).not.toContain(marker);
    expect(occurrences(await fsp.readFile(logFile, "utf8"), marker)).toBe(1);
  });

  it("does not send request logs without the modern logLevel envelope", async () => {
    const logFile = path.join(workDir, "no-request-logs.log");
    const server = startServer(logFile);
    const _meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "no-request-logs-test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const marker = `Checking external Qdrant at ${UNREACHABLE}...`;
    server.request("tools/call", { _meta, name: "codebase_index", arguments: { projectPath: workDir } }).catch(() => {});
    await waitFor(() => existsSync(logFile) && readFileSync(logFile, "utf8").includes(marker), 60_000, server.exited);
    expect(server.logNotifications(marker)).toHaveLength(0);
  });

  it("still shuts down gracefully when the host has already closed its end of stdout", async () => {
    // Shutdown logs, and that log now goes to stdout. With the host gone the
    // write fails with EPIPE, which must not end the process mid-shutdown.
    const logFile = path.join(workDir, "server.log");
    const server = startServer(logFile);
    const discover = await server.request("server/discover", { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "shutdown-test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } });
    expect(discover.error).toBeUndefined();

    server.proc.stdout.destroy();
    server.proc.stdin.end();

    expect(await server.exitCode).toBe(0);
    const log = await fsp.readFile(logFile, "utf8");
    expect(log).toContain("Graceful shutdown complete");
    expect(log).not.toContain("Uncaught exception");
  });
});


describe("shared HTTP project scope", () => {
  it("requires a project path before indexing or reading the project catalog", async () => {
    const proc = spawn(process.execPath, ["--import", "tsx", path.resolve("src/index.ts")], {
      env: { ...serverEnv(path.join(workDir, "http.log")), SOCRATICODE_MCP_TRANSPORT: "http", SOCRATICODE_MCP_PORT: "0" },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    child = proc;
    proc.stderr.resume();
    const url = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      proc.once("error", reject);
      proc.once("exit", () => reject(new Error("HTTP server exited before readiness")));
      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        if (!buffer.includes("\n")) return;
        const value: unknown = JSON.parse(buffer.split("\n")[0]);
        if (typeof value === "object" && value !== null && "url" in value && typeof value.url === "string") resolve(value.url);
      });
    });
    const client = new Client({ name: "scope-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === "codebase_index")?.inputSchema.required).toContain("projectPath");
      expect(await client.callTool({ name: "codebase_index", arguments: {} })).toHaveProperty("isError", true);
      const catalog = await client.callTool({ name: "codebase_list_projects", arguments: {} });
      expect(catalog.isError).toBe(true);
      expect(JSON.stringify(catalog)).toContain("projectPath is required");
    } finally { await client.close(); }
  });
});
