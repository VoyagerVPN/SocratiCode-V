// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
function runHook(file: string, cwd: string, env = process.env, args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (value: Buffer) => { stdout += value.toString(); });
    child.stderr.on("data", (value: Buffer) => { stderr += value.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}


async function stopOwnService(stateFile: string): Promise<void> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(stateFile, "utf8"));
    if (typeof value === "object" && value !== null && "pid" in value && typeof value.pid === "number") process.kill(value.pid);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code)))) throw error;
  }
}

it("starts and reuses the relocated plugin from an unrelated working directory", async () => {
  const cache = path.join(root, ".cache", "portable-plugin");
  await fs.mkdir(cache, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(cache, "folder with spaces-"));
  if (!path.resolve(fixture).startsWith(path.resolve(cache) + path.sep)) throw new Error("Unsafe fixture path");
  const plugin = path.join(fixture, "socraticode");
  const server = path.join(plugin, "server");
  const unrelated = path.join(fixture, "unrelated");
  await fs.mkdir(server, { recursive: true }); await fs.mkdir(unrelated);
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  let client: Client | undefined;
  try {
    await fs.cp(path.join(root, "plugins", "socraticode", "hooks"), path.join(plugin, "hooks"), { recursive: true });
    await fs.cp(path.join(root, "dist"), path.join(server, "dist"), { recursive: true });
    await fs.cp(path.join(root, "scripts"), path.join(server, "scripts"), { recursive: true });
    await fs.copyFile(path.join(root, "package.json"), path.join(server, "package.json"));
    await fs.symlink(path.join(root, "node_modules"), path.join(server, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(path.join(plugin, "runtime.json"), JSON.stringify({ version: "portable-hook-test", port, env: {
      QDRANT_MODE: "external", QDRANT_URL: "http://127.0.0.1:9", EMBEDDING_PROVIDER: "ollama",
      OLLAMA_MODE: "external", OLLAMA_URL: "http://127.0.0.1:9", SOCRATICODE_AUTO_RESUME: "off",
      SOCRATICODE_AUTO_CLEANUP: "off", SOCRATICODE_WATCHER: "off", SOCRATICODE_IDLE_STOP_TIMEOUT_MS: "off",
      SOCRATICODE_RUNTIME_DIR: ".cache/runtime", SOCRATICODE_CUDA_CACHE_PATH: ".cache/cuda-cache",
    } }));
    const hook = path.join(plugin, "hooks", "session-start.mjs");
    const outputs = await Promise.all(Array.from({ length: 5 }, () => runHook(hook, unrelated)));
    for (const output of outputs) expect(output, output.stderr).toEqual({ code: 0, stdout: "", stderr: "" });
    const traceDir = path.join(server, ".cache", "runtime", "diagnostics");
    const events = (await fs.readFile(path.join(traceDir, (await fs.readdir(traceDir))[0]), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event) => event.stage === "http_ready")).toHaveLength(5);
    expect(events.filter((event) => event.outcome === "started")).toHaveLength(1);
    expect(events.filter((event) => event.stage === "hook_start")).toHaveLength(5);
    client = new Client({ name: "portable-plugin-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp")));
    expect(client.getServerVersion()).toEqual({ name: "socraticode", version: "portable-hook-test" });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("codebase_index");
    const dryRun = await client.callTool({ name: "codebase_index", arguments: { projectPath: unrelated, dryRun: true } });
    expect(dryRun.isError).not.toBe(true);
    expect(await fs.readdir(unrelated)).toEqual([]);
    // Установленная копия Codex может не содержать зависимости сервера.
    const installed = path.join(fixture, "installed copy");
    await fs.mkdir(installed);
    await fs.cp(path.join(plugin, "hooks"), path.join(installed, "hooks"), { recursive: true });
    await fs.copyFile(path.join(plugin, "runtime.json"), path.join(installed, "runtime.json"));
    const receipt = path.join(fixture, "installation.json");
    await fs.copyFile(path.join(root, "plugins", "socraticode", "setup.mjs"), path.join(plugin, "setup.mjs"));
    const setup = await runHook(path.join(plugin, "setup.mjs"), unrelated, process.env, ["--installation-file", receipt]);
    expect(setup.code, setup.stderr).toBe(0);
    const copied = await runHook(path.join(installed, "hooks", "session-start.mjs"), unrelated, { ...process.env, SOCRATICODE_INSTALLATION_FILE: receipt });
    expect(copied, copied.stderr).toEqual({ code: 0, stdout: "", stderr: "" });
    expect((await client.listTools()).tools.length).toBeGreaterThan(20);
  } finally {
    await client?.close();
    // Завершаем только PID из собственного изолированного состояния запуска.
    await stopOwnService(path.join(server, ".cache", "runtime", "http-service-" + port + ".json"));
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 45_000);
