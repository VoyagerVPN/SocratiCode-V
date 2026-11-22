import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const children: ChildProcess[] = [];
const directories: string[] = [];
const supervisors: number[] = [];
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const pid of supervisors.splice(0)) {
    if (alive(pid)) process.kill(pid);
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const root of directories.splice(0)) {
    if (!root.startsWith(`${path.resolve(".cache/test-tmp")}${path.sep}`)) throw new Error("Test cleanup escaped project cache");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("idle coordinator across native client processes", () => {
  it("keeps a busy fifth client safe and supervises shutdown after every client crashes or closes", async () => {
    fs.mkdirSync(path.resolve(".cache/test-tmp"), { recursive: true });
    const runtimeDir = fs.mkdtempSync(path.resolve(".cache/test-tmp/native-idle-"));
    directories.push(runtimeDir);
    const clients = Array.from({ length: 5 }, () => {
      const child = fork(path.resolve("tests/helpers/idle-client.mjs"), [], {
        env: { ...process.env, QDRANT_MODE: "external", OLLAMA_MODE: "external",
          SOCRATICODE_RUNTIME_DIR: runtimeDir, SOCRATICODE_IDLE_STOP_TIMEOUT_MS: "250" },
        windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      child.stderr?.resume();
      return child;
    });
    await Promise.all(clients.map((child) => new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Client exited before ready: ${code}`)));
    })));
    const value: unknown = JSON.parse(fs.readFileSync(path.join(runtimeDir, "idle-state.json"), "utf8"));
    if (typeof value !== "object" || value === null || !("supervisorPid" in value) || typeof value.supervisorPid !== "number") {
      throw new Error("No supervisor registered");
    }
    const pid = value.supervisorPid;
    supervisors.push(pid);
    await Promise.all(clients.slice(0, 4).map((child) => new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.send("finish");
    })));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(alive(pid)).toBe(true);
    clients[4].kill();
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
  }, 15_000);
});
