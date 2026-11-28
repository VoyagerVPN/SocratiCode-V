import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

export async function captureCatalog(node, launcher, cwd, env) {
  const child = spawn(node, [launcher], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "inherit", "ipc"], env: {
    ...env, SCV_LAUNCHER: "", SOCRATICODE_MCP_TRANSPORT: "http", SOCRATICODE_MCP_PORT: "0",
    SOCRATICODE_RUNTIME_DIR: cwd, SOCRATICODE_LOCAL_CLEANUP: "off", SOCRATICODE_AUTO_RESUME: "off", SOCRATICODE_WATCHER: "off",
    QDRANT_MODE: "external", QDRANT_URL: "http://127.0.0.1:1", OLLAMA_MODE: "external", OLLAMA_URL: "http://127.0.0.1:1",
  } });
  const exited = once(child, "exit");
  exited.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const listen = async () => {
    for await (const line of lines) {
      if (line.startsWith('{"type":"socraticode/http-ready"')) return JSON.parse(line).url;
    }
    throw new Error("Сервер завершился до публикации каталога MCP");
  };
  try {
    const url = await Promise.race([listen(), delay(15_000, undefined, { ref: false }).then(() => { throw new Error("Тайм-аут публикации каталога MCP"); })]);
    const catalog = {};
    const protocolVersion = "2026-07-28";
    let id = 0;
    for (const method of ["server/discover", "tools/list"]) {
      const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5000),
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Method": method, "MCP-Protocol-Version": protocolVersion },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { _meta: {
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
          "io.modelcontextprotocol/clientInfo": { name: "scv-build", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        } } }),
      });
      const raw = await response.text();
      const message = JSON.parse(raw.startsWith("{") ? raw : raw.split("\n").find(line => line.startsWith("data: "))?.slice(6));
      if (!response.ok || !message.result) throw new Error(`Ошибка ${method}: ${raw}`);
      catalog[method] = message.result;
    }
    return { ...catalog, ping: {} };
  } finally {
    lines.close();
    child.stdout.resume();
    if (child.connected) child.send("shutdown", () => {});
    const result = await Promise.race([exited, delay(12_000, null, { ref: false })]);
    if (!result) { child.kill(); await exited; }
  }
}
