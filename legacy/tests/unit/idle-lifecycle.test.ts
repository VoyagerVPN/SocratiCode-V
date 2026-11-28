import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdleLifecycle } from "../../src/services/idle-lifecycle.js";

const directories: string[] = [];
function directory(): string {
  const root = path.resolve(".cache/test-tmp");
  fs.mkdirSync(root, { recursive: true });
  const result = fs.mkdtempSync(path.join(root, "idle-"));
  directories.push(result);
  return result;
}
afterEach(() => {
  for (const root of directories.splice(0)) {
    if (!root.startsWith(`${path.resolve(".cache/test-tmp")}${path.sep}`)) throw new Error("Test cleanup escaped project cache");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("shared container idle lifecycle", () => {
  it("one idle client cannot stop containers during another client's operation", async () => {
    let now = 0;
    const stop = vi.fn(async (): Promise<void> => {});
    const options = { runtimeDir: directory(), idleMs: 100, now: () => now, stop, supervisor: false };
    const first = new IdleLifecycle(options);
    const second = new IdleLifecycle(options);
    let finish: (() => void) | undefined;
    const operation = second.run(() => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeDefined());
    now = 1_000;
    expect(await first.stopIfIdle()).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    finish?.();
    await operation;
    now = 1_099;
    expect(await first.stopIfIdle()).toBe(false);
    now = 1_100;
    expect(await first.stopIfIdle()).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("releases failed operations and waits for container stop before admitting a new operation", async () => {
    let now = 0;
    let finishStop: (() => void) | undefined;
    const lifecycle = new IdleLifecycle({ runtimeDir: directory(), idleMs: 100, now: () => now,
      stop: () => new Promise<void>((resolve) => { finishStop = resolve; }), supervisor: false });
    await expect(lifecycle.run(async () => { throw new Error("failed request"); })).rejects.toThrow("failed request");
    now = 100;
    const stopping = lifecycle.stopIfIdle();
    await vi.waitFor(() => expect(finishStop).toBeDefined());
    const operation = vi.fn(async (): Promise<void> => {});
    const request = lifecycle.run(operation);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(operation).not.toHaveBeenCalled();
    finishStop?.();
    expect(await stopping).toBe(true);
    await request;
    expect(operation).toHaveBeenCalledOnce();
  });
  it("recovers a crashed client's busy lease without stopping immediately after the crash", async () => {
    let now = 1_000;
    const runtimeDir = directory();
    fs.writeFileSync(path.join(runtimeDir, "idle-state.json"), JSON.stringify({
      lastActivity: 0, clients: { crashed: { pid: 2147483647, active: 1 } },
    }));
    const stop = vi.fn(async (): Promise<void> => {});
    const lifecycle = new IdleLifecycle({ runtimeDir, idleMs: 100, now: () => now, stop, supervisor: false });
    expect(await lifecycle.stopIfIdle()).toBe(false);
    now = 1_100;
    expect(await lifecycle.stopIfIdle()).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });
  it("invalidates each client's readiness after the shared containers were stopped", async () => {
    let now = 0;
    const onResume = vi.fn();
    const options = { runtimeDir: directory(), idleMs: 100, now: () => now,
      stop: async (): Promise<void> => {}, supervisor: false, onResume };
    const first = new IdleLifecycle(options);
    const second = new IdleLifecycle(options);
    await second.run(async () => {});
    now = 100;
    await first.stopIfIdle();
    await second.run(async () => {});
    expect(onResume).toHaveBeenCalledOnce();
    await second.run(async () => {});
    expect(onResume).toHaveBeenCalledOnce();
  });
});
