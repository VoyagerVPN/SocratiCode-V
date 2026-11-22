import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";

interface ClientLease { pid: number; active: number; }
interface IdleState { lastActivity: number; clients: Record<string, ClientLease>; supervisorPid?: number; generation: number; }

export interface IdleLifecycleOptions {
  runtimeDir: string;
  idleMs?: number;
  now?: () => number;
  stop: () => Promise<void>;
  supervisor?: boolean;
  onResume?: () => void;
}

function readState(file: string): IdleState {
  if (!fs.existsSync(file)) return { lastActivity: Date.now(), clients: {}, generation: 0 };
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof value !== "object" || value === null || !("lastActivity" in value) ||
      typeof value.lastActivity !== "number" || !("clients" in value) ||
      typeof value.clients !== "object" || value.clients === null) throw new Error("Invalid idle runtime state");
  const clients: Record<string, ClientLease> = {};
  for (const [key, client] of Object.entries(value.clients)) {
    if (typeof client !== "object" || client === null || !("pid" in client) || typeof client.pid !== "number" ||
        !("active" in client) || typeof client.active !== "number") throw new Error("Invalid idle client lease");
    clients[key] = { pid: client.pid, active: client.active };
  }
  return { lastActivity: value.lastActivity, clients,
    generation: "generation" in value && typeof value.generation === "number" ? value.generation : 0,
    supervisorPid: "supervisorPid" in value && typeof value.supervisorPid === "number" ? value.supervisorPid : undefined };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"; }
}

export class IdleLifecycle {
  private readonly id = randomUUID();
  private readonly file: string;
  private readonly now: () => number;
  private readonly idleMs: number;
  private generation = 0;
  constructor(private readonly options: IdleLifecycleOptions) {
    this.file = path.join(options.runtimeDir, "idle-state.json");
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 600_000;
    fs.mkdirSync(options.runtimeDir, { recursive: true });
  }

  private async transaction<T>(action: (state: IdleState) => Promise<T>): Promise<T> {
    const release = await lockfile.lock(this.file, {
      realpath: false, stale: 60_000, update: 5_000,
      retries: { retries: 3_600, factor: 1.1, minTimeout: 10, maxTimeout: 50 },
    });
    try {
      const state = readState(this.file);
      for (const [id, lease] of Object.entries(state.clients)) {
        if (!isAlive(lease.pid)) {
          delete state.clients[id];
          if (lease.active > 0) state.lastActivity = this.now();
        }
      }
      try { return await action(state); }
      finally {
        const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(state));
        fs.renameSync(temp, this.file);
      }
    } finally { await release(); }
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    const generation = await this.transaction(async (state) => {
      const lease = state.clients[this.id] ?? { pid: process.pid, active: 0 };
      lease.active++;
      state.clients[this.id] = lease;
      state.lastActivity = this.now();
      if (this.options.supervisor !== false && (!state.supervisorPid || !isAlive(state.supervisorPid))) {
        // Отдельный процесс этого же модуля переживает закрытие всех MCP-клиентов.
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--socraticode-idle-supervisor"], {
          env: { ...process.env, SOCRATICODE_RUNTIME_DIR: this.options.runtimeDir,
            SOCRATICODE_IDLE_STOP_TIMEOUT_MS: String(this.idleMs) },
          detached: true, windowsHide: true, stdio: "ignore",
        });
        child.on("error", (error) => process.stderr.write(`Idle supervisor: ${error.message}\n`));
        child.unref();
        state.supervisorPid = child.pid;
      }
      return state.generation;
    });
    try {
      if (generation !== this.generation) {
        this.options.onResume?.();
        this.generation = generation;
      }
      return await operation();
    }
    finally {
      await this.transaction(async (state) => {
        const lease = state.clients[this.id];
        if (lease) lease.active = Math.max(0, lease.active - 1);
        state.lastActivity = this.now();
      });
    }
  }

  public async close(): Promise<void> {
    await this.transaction(async (state) => {
      const lease = state.clients[this.id];
      if (lease?.active) throw new Error("Cannot close idle lifecycle during active operations");
      delete state.clients[this.id];
    });
  }

  public async stopIfIdle(): Promise<boolean> {
    return this.transaction(async (state) => {
      if (Object.values(state.clients).some((client) => client.active > 0)) return false;
      if (this.now() - state.lastActivity < this.idleMs) return false;
      // Даже частично успешная остановка делает кеш ready других процессов недействительным.
      state.generation++;
      await this.options.stop();
      state.lastActivity = this.now();
      return true;
    });
  }
}

const execFileAsync = promisify(execFile);
async function stopManagedContainers(): Promise<void> {
  const names: string[] = [];
  if (process.env.QDRANT_MODE !== "external") names.push("socraticode-qdrant");
  if ((process.env.EMBEDDING_PROVIDER ?? "ollama") === "ollama" && process.env.OLLAMA_MODE !== "external" && process.env.OLLAMA_MODE !== "local") {
    names.push("socraticode-ollama");
  }
  if (names.length > 0) await execFileAsync("docker", ["info", "--format", "{{json .ServerVersion}}"], { windowsHide: true, timeout: 10_000 });
  for (const name of names) {
    let running: string;
    try { running = (await execFileAsync("docker", ["inspect", "--format", "{{.State.Running}}", name], { windowsHide: true, timeout: 10_000 })).stdout.trim(); }
    catch (error) {
      if (error instanceof Error && /No such (object|container)/i.test(error.message)) continue;
      throw error;
    }
    if (running === "true") await execFileAsync("docker", ["stop", "--time", "30", name], { windowsHide: true, timeout: 45_000 });
  }
}

function defaultLifecycle(): IdleLifecycle {
  const timeout = Number(process.env.SOCRATICODE_IDLE_STOP_TIMEOUT_MS ?? "600000");
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("SOCRATICODE_IDLE_STOP_TIMEOUT_MS must be positive or off");
  return new IdleLifecycle({
    runtimeDir: process.env.SOCRATICODE_RUNTIME_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.cache/runtime"),
    idleMs: timeout, stop: stopManagedContainers, onResume: () => resumeHandler?.(),
  });
}

let singleton: IdleLifecycle | undefined;
let resumeHandler: (() => void) | undefined;
export function setIdleResumeHandler(handler: () => void): void {
  resumeHandler = handler;
}
export async function runWithIdleActivity<T>(operation: () => Promise<T>): Promise<T> {
  if (process.env.SOCRATICODE_IDLE_STOP_TIMEOUT_MS === "off" ||
    (process.env.SOCRATICODE_IDLE_STOP_TIMEOUT_MS === undefined && process.env.QDRANT_MODE === "external" && process.env.OLLAMA_MODE === "external")) return operation();
  singleton ??= defaultLifecycle();
  return singleton.run(operation);
}

export async function closeIdleLifecycle(): Promise<void> {
  await singleton?.close();
  singleton = undefined;
}

async function supervise(): Promise<void> {
  const lifecycle = defaultLifecycle();
  const interval = Math.max(50, Math.min(15_000, Number(process.env.SOCRATICODE_IDLE_STOP_TIMEOUT_MS ?? "600000") / 4));
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    try { if (await lifecycle.stopIfIdle()) return; }
    catch (error) { process.stderr.write(`Idle supervisor: ${String(error)}\n`); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--socraticode-idle-supervisor") {
  await supervise();
}
