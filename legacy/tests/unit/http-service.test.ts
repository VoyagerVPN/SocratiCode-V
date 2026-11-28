import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureHttpService, parseHttpServiceProfile } from "../../src/services/http-service.js";
import { type McpHttpRuntime, startMcpHttp } from "../../src/services/mcp-http.js";

let runtime: McpHttpRuntime | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; });

describe("local HTTP service manager", () => {
  it("validates the machine profile before starting a process", () => {
    expect(parseHttpServiceProfile({ version: "local-test", port: 16335, env: { SOCRATICODE_AUTO_RESUME: "off" } })).toEqual({
      version: "local-test", port: 16335, env: { SOCRATICODE_AUTO_RESUME: "off" },
    });
    for (const port of [0, -1, 65536, "16335", 1.5]) {
      expect(() => parseHttpServiceProfile({ version: "local-test", port, env: {} })).toThrow("Invalid local HTTP service profile");
    }
    expect(() => parseHttpServiceProfile({ version: "local-test", port: 16335, env: { invalid: 5 } })).toThrow("must be a string");
  });

  it("reuses the verified service for five simultaneous callers", async () => {
    runtime = await startMcpHttp(() => new McpServer({ name: "socraticode", version: "local-test" }), 0);
    const profile = { version: "local-test", port: Number(new URL(runtime.url).port), env: {} };
    await Promise.all(Array.from({ length: 5 }, () => ensureHttpService(profile)));
    expect(await fetch(runtime.url, { method: "GET" })).toHaveProperty("status", 405);
  });


  it.each(["socraticode", "foreign-server"])("verifies %s after one reset discovery connection", async (name) => {
    runtime = await startMcpHttp(() => new McpServer({ name, version: "local-reset-test" }), 0);
    const upstream = runtime.url;
    let reset = true;
    const proxy = http.createServer((request, response) => {
      if (reset) { reset = false; request.socket.destroy(); return; }
      void (async (): Promise<void> => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await fetch(upstream, { method: "POST", headers: {
          "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          "Mcp-Method": "server/discover", "MCP-Protocol-Version": "2026-07-28",
        }, body: Buffer.concat(chunks) });
        response.writeHead(result.status, { "Content-Type": "application/json" });
        response.end(await result.text());
      })().catch(() => response.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy port");
    try {
      const profile = { version: "local-reset-test", port: address.port, env: {} };
      if (name === "socraticode") await ensureHttpService(profile);
      else await expect(ensureHttpService(profile)).rejects.toThrow("existing processes were not stopped");
      expect(await fetch(upstream, { method: "GET" })).toHaveProperty("status", 405);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("refuses a foreign service on the configured port", async () => {
    runtime = await startMcpHttp(() => new McpServer({ name: "foreign-server", version: "local-test" }), 0);
    await expect(ensureHttpService({ version: "local-test", port: Number(new URL(runtime.url).port), env: {} })).rejects.toThrow("existing processes were not stopped");
    expect(await fetch(runtime.url, { method: "GET" })).toHaveProperty("status", 405);
  });
});


describe("eight concurrent session starts", () => {
  it("starts one isolated HTTP process and reuses it for eight warm callers", async () => {
    const reserved = await startMcpHttp(() => new McpServer({ name: "port-reservation", version: "1" }), 0);
    const port = Number(new URL(reserved.url).port);
    await reserved.close();
    const profile = { version: "hook-test", port, env: {
      QDRANT_MODE: "external", QDRANT_URL: "http://127.0.0.1:9",
      OLLAMA_MODE: "external", OLLAMA_URL: "http://127.0.0.1:9",
      SOCRATICODE_AUTO_RESUME: "off", SOCRATICODE_AUTO_CLEANUP: "off",
      SOCRATICODE_WATCHER: "off", SOCRATICODE_IDLE_STOP_TIMEOUT_MS: "off",
    } };
    let pid: number | undefined;
    try {
      await Promise.all(Array.from({ length: 8 }, () => ensureHttpService(profile)));
      const value: unknown = JSON.parse(await readFile(path.resolve(`.cache/runtime/http-service-${port}.json`), "utf8"));
      if (typeof value !== "object" || value === null || !("pid" in value) || typeof value.pid !== "number") throw new Error("Missing managed service PID");
      pid = value.pid;
      // Успешный запуск сохраняет подтверждённую готовность, а не только PID.
      expect(value).toHaveProperty("verifiedAt");
      await Promise.all(Array.from({ length: 8 }, () => ensureHttpService(profile)));
      expect(await fetch(`http://127.0.0.1:${port}/mcp`, { method: "GET" })).toHaveProperty("status", 405);
      const unchanged: unknown = JSON.parse(await readFile(path.resolve(`.cache/runtime/http-service-${port}.json`), "utf8"));
      expect(unchanged).toEqual(value);
      process.kill(pid);
      // Уже остановленный PID не должен повторно завершаться в finally и скрывать исходную ошибку.
      pid = undefined;
      await vi.waitFor(() => expect(() => process.kill(value.pid, 0)).toThrow(), { timeout: 5_000 });
      await Promise.all(Array.from({ length: 8 }, () => ensureHttpService(profile)));
      const restarted: unknown = JSON.parse(await readFile(path.resolve(`.cache/runtime/http-service-${port}.json`), "utf8"));
      if (typeof restarted !== "object" || restarted === null || !("pid" in restarted) || typeof restarted.pid !== "number") throw new Error("Missing restarted service PID");
      pid = restarted.pid;
      expect(pid).not.toBe(value.pid);
      expect(await fetch(`http://127.0.0.1:${port}/mcp`, { method: "GET" })).toHaveProperty("status", 405);
    } finally {
      if (pid) process.kill(pid);
    }
  });
});
