import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";

export interface HttpServiceProfile {
  version: string;
  port: number;
  env: Record<string, string>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHttpServiceProfile(value: unknown): HttpServiceProfile {
  if (!record(value) || typeof value.version !== "string" || !Number.isInteger(value.port) ||
    typeof value.port !== "number" || value.port < 1 || value.port > 65535 || !record(value.env)) {
    throw new Error("Invalid local HTTP service profile");
  }
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.env)) {
    if (typeof entry !== "string") throw new Error(`HTTP profile environment value must be a string: ${key}`);
    env[key] = entry;
  }
  return { version: value.version, port: value.port, env };
}

export async function readHttpServiceProfile(profileFile = new URL("../../plugins/socraticode/runtime.json", import.meta.url)): Promise<HttpServiceProfile> {
  const value: unknown = JSON.parse(await fs.readFile(profileFile, "utf8"));
  const profile = parseHttpServiceProfile(value);
  // Относительные кеши привязаны к серверу, а не к cwd первого чата.
  const root = fileURLToPath(new URL("../../", import.meta.url));
  for (const key of ["SOCRATICODE_RUNTIME_DIR", "SOCRATICODE_CUDA_CACHE_PATH"]) {
    if (profile.env[key]) profile.env[key] = path.resolve(root, profile.env[key]);
  }
  return profile;
}

async function probe(profile: HttpServiceProfile, retryReset = true): Promise<boolean> {
  const url = `http://127.0.0.1:${profile.port}/mcp`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST", signal: AbortSignal.timeout(2_000),
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "Mcp-Method": "server/discover", "MCP-Protocol-Version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "socraticode-service-manager", version: profile.version },
        "io.modelcontextprotocol/clientCapabilities": {},
      } } }),
    });
  } catch (error) {
    if (error instanceof TypeError && error.cause instanceof Error && "code" in error.cause) {
      if (error.cause.code === "ECONNREFUSED") return false;
      // Старое keep-alive соединение может сброситься после остановки сервера.
      // Сброс не доказывает свободный порт: повторно проверяем ответ и его идентичность.
      if (retryReset && ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(String(error.cause.code))) return probe(profile, false);
    }
    throw error;
  }
  const value: unknown = await response.json();
  const result = record(value) && record(value.result) ? value.result : undefined;
  const meta = result && record(result._meta) ? result._meta : undefined;
  const info = meta && record(meta["io.modelcontextprotocol/serverInfo"]) ? meta["io.modelcontextprotocol/serverInfo"] : undefined;
  if (!response.ok || !record(info) || info.name !== "socraticode" || info.version !== profile.version) {
    throw new Error(`Port ${profile.port} does not serve SocratiCode ${profile.version}; existing processes were not stopped`);
  }
  return true;
}

interface ServiceState {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
  verifiedAt?: number;
}

async function saveServiceState(file: string, state: ServiceState): Promise<void> {
  // Параллельные хуки читают только целый JSON, даже во время обновления кеша.
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state));
  await fs.rename(temporary, file);
}

async function serviceState(file: string, profile: HttpServiceProfile): Promise<ServiceState | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!record(value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0 || value.port !== profile.port || value.version !== profile.version || typeof value.startedAt !== "string") return undefined;
    return { pid: value.pid, port: profile.port, version: profile.version, startedAt: value.startedAt,
      verifiedAt: typeof value.verifiedAt === "number" ? value.verifiedAt : undefined };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function recentlyReady(file: string, profile: HttpServiceProfile): Promise<boolean> {
  const state = await serviceState(file, profile);
  if (!state?.verifiedAt || Date.now() - state.verifiedAt < 0 || Date.now() - state.verifiedAt > 15_000) return false;
  try { process.kill(state.pid, 0); return true; } catch { return false; }
}

/** Восемь чатов делят запуск и подтверждение готовности; модель и индексы хук не трогает. */
export async function ensureHttpService(profile: HttpServiceProfile): Promise<"cached" | "discovered" | "started"> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const runtimeDir = path.join(root, ".cache", "runtime");
  const stateFile = path.join(runtimeDir, `http-service-${profile.port}.json`);
  if (await recentlyReady(stateFile, profile)) return "cached";
  await fs.mkdir(runtimeDir, { recursive: true });
  const lockPath = path.join(runtimeDir, `http-start-${profile.port}`);
  await fs.writeFile(lockPath, "", { flag: "a" });
  const release = await lockfile.lock(lockPath, { stale: 40_000, update: 5_000, retries: { retries: 350, factor: 1, minTimeout: 100, maxTimeout: 100 } });
  try {
    if (await recentlyReady(stateFile, profile)) return "cached";
    if (await probe(profile)) {
      const state = await serviceState(stateFile, profile);
      if (state) await saveServiceState(stateFile, { ...state, verifiedAt: Date.now() });
      return "discovered";
    }
    const output = openSync(path.join(runtimeDir, `http-${profile.port}-stdout.log`), "a");
    let errors: number | undefined;
    let pid: number | undefined;
    try {
      errors = openSync(path.join(runtimeDir, `http-${profile.port}-stderr.log`), "a");
      const args = [...(process.platform === "win32"
        ? ["--require", path.join(root, "scripts", "windows-test-processes.cjs")] : []), path.join(root, "dist", "launcher.js")];
      const child = spawn(process.execPath, args, {
        cwd: root, detached: true, windowsHide: true, stdio: ["ignore", output, errors],
        env: { ...process.env, ...profile.env, SOCRATICODE_MCP_TRANSPORT: "http", SOCRATICODE_MCP_PORT: String(profile.port), SOCRATICODE_MCP_VERSION: profile.version },
      });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      pid = child.pid;
      child.unref();
    } finally {
      closeSync(output);
      if (errors !== undefined) closeSync(errors);
    }
    if (!pid) throw new Error("SocratiCode HTTP process did not provide a PID");
    const state: ServiceState = { pid, port: profile.port, version: profile.version, startedAt: new Date().toISOString() };
    await saveServiceState(stateFile, state);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { throw new Error(`SocratiCode HTTP process exited before readiness; see http-${profile.port}-stderr.log`); }
      if (await probe(profile)) {
        await saveServiceState(stateFile, { ...state, verifiedAt: Date.now() });
        return "started";
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("SocratiCode HTTP service did not become ready within 25 seconds");
  } finally {
    await release();
  }
}
