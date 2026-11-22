// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from "node:async_hooks";

export interface IndexBudget { maxFiles: number; maxChunks: number; maxBytes: number; }
const requestBudget = new AsyncLocalStorage<IndexBudget>();
/** Лимиты операции отделены от профиля векторов: изменение лимита не требует переиндексации. */
export function readIndexBudget(args: Record<string, unknown> = {}): IndexBudget {
  const limit = (name: string, env: string, fallback: number): number => {
    const value = Number(args[name] ?? process.env[env] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Cannot index: " + name + " must be a positive integer");
    return value;
  };
  return { maxFiles: limit("maxFiles", "SOCRATICODE_INDEX_MAX_FILES", 2000),
    maxChunks: limit("maxChunks", "SOCRATICODE_INDEX_MAX_CHUNKS", 20000),
    maxBytes: limit("maxBytes", "SOCRATICODE_INDEX_MAX_BYTES", 32 * 1024 * 1024) };
}
export function withIndexBudget<T>(budget: IndexBudget, operation: () => Promise<T>): Promise<T> {
  return requestBudget.run(budget, operation);
}
export function assertIndexBudget(files: number, chunks: number, bytes: number): void {
  const budget = requestBudget.getStore() ?? readIndexBudget();
  if (files > budget.maxFiles || chunks > budget.maxChunks || bytes > budget.maxBytes) {
    throw new Error("Index limit exceeded: " + files + " files, " + chunks + " chunks, " + bytes
      + " UTF-8 chunk bytes; limits " + budget.maxFiles + "/" + budget.maxChunks + "/" + budget.maxBytes
      + ". Narrow the source or ignore generated files; raise the explicit budget only for intended work.");
  }
}
