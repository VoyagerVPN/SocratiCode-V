// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

type Fields = Record<string, string | number | boolean>;
const search = new AsyncLocalStorage<ReturnType<typeof startupTrace>>();
let cleaned = "";

export function startupTrace(runtimeDir: string | undefined, port: number, started = performance.now()) {
  const id = randomUUID();
  return (stage: string, fields: Fields = {}) => {
    if (!runtimeDir) return;
    try {
      const dir = path.join(runtimeDir, "diagnostics");
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      if (cleaned !== dir + day) {
        mkdirSync(dir, { recursive: true });
        const oldest = new Date(now.getTime() - 6 * 86400000).toISOString().slice(0, 10);
        for (const name of readdirSync(dir)) {
          if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < oldest) {
            try { unlinkSync(path.join(dir, name)); } catch { /* Другой хук мог уже удалить журнал. */ }
          }
        }
        cleaned = dir + day;
      }
      const event = { at: now.toISOString(), id, port, stage, ms: Math.round(performance.now() - started), ...fields };
      appendFileSync(path.join(dir, day + ".jsonl"), JSON.stringify(event) + "\n");
    } catch { /* Недоступный журнал не должен прерывать поиск или запуск. */ }
  };
}

export async function traceSearch<T extends { isError: boolean; structuredContent: { returned: number; status: string } }>(
  operation: () => Promise<T>,
): Promise<T> {
  const dir = process.env.SOCRATICODE_RUNTIME_DIR;
  if (!dir || process.env.SOCRATICODE_MCP_TRANSPORT !== "http") return operation();
  const emit = startupTrace(dir, Number(process.env.SOCRATICODE_MCP_PORT));
  emit("search_start");
  return search.run(emit, async () => {
    try {
      const result = await operation();
      emit("search_result", { status: result.structuredContent.status, returned: result.structuredContent.returned });
      return result;
    } catch (error) {
      emit("search_failed");
      throw error;
    }
  });
}

export function searchStage(stage: "qdrant_ready" | "embedding_provider_ready" | "query_embedded") {
  search.getStore()?.(stage);
}
