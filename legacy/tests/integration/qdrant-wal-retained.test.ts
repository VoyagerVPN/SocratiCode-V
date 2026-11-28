import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const exec = promisify(execFile);
const container = "socrati-wal-regression-20261006";
const endpoint = "http://127.0.0.1:16338";
let created = false;
let deleteFileChunks: typeof import("../../src/services/qdrant.js").deleteFileChunks;

async function docker(args: string[]): Promise<void> {
  await exec("docker", args, { windowsHide: true, timeout: 45_000 });
}
async function ready(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${endpoint}/healthz`)).ok) return; } catch { /* Ждём готовности после холодного запуска. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Pinned Qdrant did not survive cold restart");
}
async function api(method: string, url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${endpoint}${url}`, {
    method, headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Qdrant ${method} ${url}: ${response.status} ${await response.text()}`);
  return response.json();
}
async function ids(collection: string): Promise<string[]> {
  const value = await api("POST", `/collections/${collection}/points/scroll`, { limit: 10_000, with_payload: false, with_vector: false });
  if (typeof value !== "object" || value === null || !("result" in value) || typeof value.result !== "object" || value.result === null || !("points" in value.result) || !Array.isArray(value.result.points)) throw new Error("Invalid Qdrant points response");
  return value.result.points.map((point: unknown) => {
    if (typeof point !== "object" || point === null || !("id" in point) || typeof point.id !== "string") throw new Error("Expected UUID point ID");
    return point.id;
  }).sort();
}

describe("retaining UUID chunks across a pinned Qdrant cold restart", () => {
  beforeAll(async () => {
    vi.stubEnv("QDRANT_URL", endpoint);
    vi.stubEnv("QDRANT_MODE", "external");
    vi.stubEnv("SOCRATICODE_IDLE_STOP_TIMEOUT_MS", "off");
    vi.resetModules();
    ({ deleteFileChunks } = await import("../../src/services/qdrant.js"));
    await docker(["run", "-d", "--name", container, "--label", "socraticode.test=wal-regression", "-p", "127.0.0.1:16338:6333", "--restart", "no", "qdrant/qdrant:v1.17.0"]);
    created = true;
    await ready();
  }, 45_000);
  afterAll(async () => {
    if (created) await docker(["rm", "-f", container]);
    vi.unstubAllEnvs();
  });
  it("keeps replacement chunks and another file readable after deleting obsolete UUID chunks and restarting", async () => {
    const collection = "wal_retained_chunks";
    const retained = "00000000-0000-0000-0000-000000000001";
    const obsolete = "00000000-0000-0000-0000-000000000002";
    const unrelated = "00000000-0000-0000-0000-000000000003";
    await api("PUT", `/collections/${collection}`, { vectors: { size: 3, distance: "Cosine" } });
    await api("PUT", `/collections/${collection}/points?wait=true`, { points: [
      { id: retained, vector: [1, 0, 0], payload: { relativePath: "target.ts" } },
      { id: obsolete, vector: [0, 1, 0], payload: { relativePath: "target.ts" } },
      { id: unrelated, vector: [0, 0, 1], payload: { relativePath: "other.ts" } },
    ] });
    await deleteFileChunks(collection, "target.ts", true, [retained]);
    expect(await ids(collection)).toEqual([retained, unrelated]);
    await docker(["stop", "--time", "30", container]);
    await docker(["start", container]);
    await ready();
    expect(await ids(collection)).toEqual([retained, unrelated]);
  }, 45_000);
  it("removes every obsolete chunk across scroll pages while preserving both early and late retained IDs", async () => {
    const collection = "wal_paginated_chunks";
    const points = Array.from({ length: 600 }, (_, index) => ({
      id: `00000000-0000-0000-0000-${(index + 1_000).toString(16).padStart(12, "0")}`,
      vector: [1, 0, 0], payload: { relativePath: "many.ts" },
    }));
    const retained = [points[0].id, points[599].id];
    const unrelated = "00000000-0000-0000-0000-000000000020";
    await api("PUT", `/collections/${collection}`, { vectors: { size: 3, distance: "Cosine" } });
    await api("PUT", `/collections/${collection}/points?wait=true`, { points: [
      ...points, { id: unrelated, vector: [0, 1, 0], payload: { relativePath: "other.ts" } },
    ] });
    await deleteFileChunks(collection, "many.ts", false, retained);
    expect(await ids(collection)).toEqual([unrelated, ...retained]);
    await docker(["stop", "--time", "30", container]);
    await docker(["start", container]);
    await ready();
    expect(await ids(collection)).toEqual([unrelated, ...retained]);
  }, 45_000);
});
