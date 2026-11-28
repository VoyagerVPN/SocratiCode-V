// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { z } from "zod";
import { SOCRATICODE_VERSION } from "../constants.js";

const symbolEntrySchema = z.object({
  kind: z.literal("symbol"), id: z.string(), name: z.string(), qualifiedName: z.string(),
  symbolKind: z.string(), file: z.string(), line: z.number().int(), endLine: z.number().int(),
});
const dependencyEntrySchema = z.object({ kind: z.enum(["import", "dependent", "module", "member"]), file: z.string(), relation: z.string().optional() });
export const pageEntrySchema = z.union([symbolEntrySchema, dependencyEntrySchema]);
export type PageEntry = z.infer<typeof pageEntrySchema>;
const fullPageResultSchema = z.object({
  status: z.enum(["ok", "empty", "cursor_invalid", "cursor_stale", "budget_too_small", "unavailable"]),
  returned: z.number().int().nonnegative(), total: z.number().int().nonnegative().nullable(),
  totalRelation: z.enum(["eq", "unknown"]), offset: z.number().int().nonnegative(),
  hasMore: z.boolean(), truncated: z.boolean(),
  truncationReason: z.enum(["page_limit", "output_budget"]).nullable(),
  nextCursor: z.string().nullable(), revision: z.string().nullable(),
  partial: z.boolean(), warnings: z.array(z.string()), entries: z.array(pageEntrySchema),
});
export const pageResultSchema = fullPageResultSchema.partial({
  totalRelation: true, truncated: true, truncationReason: true, revision: true, warnings: true, entries: true,
});
export type PageResult = z.infer<typeof pageResultSchema>;
export interface PageToolResponse { text: string; structuredContent: PageResult; isError: boolean; }
export interface RawPageToolResponse extends PageToolResponse {
  structuredContent: z.infer<typeof fullPageResultSchema>;
}
interface Presentation { format?: unknown; filePath?: unknown; }
export class PageCursorError extends Error {
  constructor(public readonly status: "cursor_invalid" | "cursor_stale", message: string) { super(message); }
}
export function pageFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function readPageOffset(cursor: unknown, key: string, revision: string): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{92}$/.test(cursor)) {
    throw new PageCursorError("cursor_invalid", "Invalid cursor. Start a new request without cursor.");
  }
  const value = Buffer.from(cursor, "base64url");
  if (value.length !== 69 || value[0] !== 2 || value.toString("base64url") !== cursor) {
    throw new PageCursorError("cursor_invalid", "Invalid cursor. Start a new request without cursor.");
  }
  if (value.subarray(1, 33).toString("hex") !== key) throw new PageCursorError("cursor_invalid", "Cursor belongs to a different project, tool or filter.");
  if (value.subarray(33, 65).toString("hex") !== revision) throw new PageCursorError("cursor_stale", "Graph revision changed. Start a new request without cursor.");
  return value.readUInt32BE(65);
}
export function encodePageCursor(key: string, revision: string, offset: number): string {
  // Два SHA-256 и offset сохраняются полностью; JSON-имена полей в курсоре не нужны.
  const value = Buffer.alloc(69);
  value[0] = 2;
  Buffer.from(key, "hex").copy(value, 1);
  Buffer.from(revision, "hex").copy(value, 33);
  value.writeUInt32BE(offset, 65);
  return value.toString("base64url");
}
export function createResultPage(
  label: string, key: string, revision: string, entries: PageEntry[], offset: number,
  total: number, warnings: string[] = [],
): RawPageToolResponse {
  if (offset > total || (offset === total && offset > 0)) {
    throw new PageCursorError("cursor_invalid", "Cursor offset is outside this result.");
  }
  const hasMore = offset + entries.length < total;
  return {
    text: label + ": " + entries.length + " of " + total + (hasMore ? ". More results: use nextCursor with the same filters." : ". Complete.") + (warnings.length ? " Snapshot warning: see structuredContent.warnings." : ""),
    isError: false,
    structuredContent: {
      status: total === 0 ? "empty" : "ok", returned: entries.length, total, totalRelation: "eq",
      offset, hasMore, truncated: hasMore, truncationReason: hasMore ? "page_limit" : null,
      nextCursor: hasMore ? encodePageCursor(key, revision, offset + entries.length) : null,
      revision, partial: warnings.length > 0, warnings, entries,
    },
  };
}
export function pageFailure(status: PageResult["status"], message: string): RawPageToolResponse {
  return { text: message, isError: true, structuredContent: {
    status, returned: 0, total: null, totalRelation: "unknown", offset: 0,
    hasMore: false, truncated: false, truncationReason: null, nextCursor: null,
    revision: null, partial: true, warnings: [], entries: [],
  } };
}

/** Бюджет всего result MCP, а не только текста или записей. JSON-RPC envelope не входит. */
export function pageResponseSize(response: { text: string; structuredContent: unknown; isError: boolean }): number {
  return JSON.stringify({ _meta: { "io.modelcontextprotocol/serverInfo": { name: "socraticode", version: process.env.SOCRATICODE_MCP_VERSION ?? SOCRATICODE_VERSION } }, content: [{ type: "text", text: response.text }], structuredContent: response.structuredContent, isError: response.isError }).length;
}

/** Не даём переводу строки в имени превратить одну запись в несколько. */
export function inlineLabel(value: string): string {
  return /[\r\n\t]/.test(value) ? JSON.stringify(value) : value;
}
function presentPage(response: RawPageToolResponse, presentation: Presentation): PageToolResponse {
  if (presentation.format === "json") return response;
  const page = response.structuredContent;
  const lines: string[] = [];
  if (response.isError || !page.entries.length) lines.push(response.text);
  else if (page.entries[0].kind !== "symbol") {
    lines.push(inlineLabel(String(presentation.filePath ?? "Dependencies")) + " [" + page.returned + "/" + page.total + "]");
    for (const kind of ["module", "import", "dependent", "member"] as const) {
      const entries = page.entries.filter((entry) => entry.kind === kind);
      if (!entries.length) continue;
      lines.push({ module: "Unreal module", import: "Imports →", dependent: "Dependents ←", member: "Module files" }[kind]);
      for (const entry of entries) lines.push("  " + inlineLabel(entry.file) + ("relation" in entry && entry.relation ? " [" + inlineLabel(entry.relation) + "]" : ""));
    }
  } else {
    lines.push("Symbols [" + page.returned + "/" + page.total + "]");
    const groups = new Map<string, Array<Extract<PageEntry, { kind: "symbol" }>>>();
    for (const entry of page.entries) {
      if (entry.kind !== "symbol") continue;
      const group = groups.get(entry.file);
      if (group) group.push(entry);
      else groups.set(entry.file, [entry]);
    }
    for (const [file, entries] of groups) {
      lines.push(inlineLabel(file));
      for (const entry of entries) {
      const prefix = file + "::";
      const id = entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : entry.id;
      lines.push("  " + inlineLabel(entry.symbolKind) + " " + inlineLabel(id)
        + " [" + entry.line + "-" + entry.endLine + "]"
        + (entry.id.startsWith(prefix) ? "" : " (id)")
        + (id.replace(/#\d+$/, "") === entry.qualifiedName ? "" : " name=" + inlineLabel(entry.qualifiedName))
        + (entry.qualifiedName === entry.name || entry.qualifiedName.endsWith("." + entry.name) ? "" : " shortName=" + inlineLabel(entry.name)));
      }
    }
  }
  return { text: lines.join("\n"), isError: response.isError, structuredContent: {
    status: page.status, returned: page.returned, total: page.total, offset: page.offset,
    hasMore: page.hasMore, nextCursor: page.nextCursor, partial: page.partial,
    ...(page.hasMore ? { truncationReason: page.truncationReason } : {}),
    ...(page.warnings.length ? { warnings: page.warnings } : {}),
  } };
}
export function fitResultPage(
  response: RawPageToolResponse, key: string, maxChars: number, presentation: Presentation = {},
): PageToolResponse {
  const complete = presentPage(response, presentation);
  if (pageResponseSize(complete) <= maxChars) return complete;
  const page = response.structuredContent;
  if (!response.isError && page.entries.length > 1 && page.revision) {
    let low = 1;
    let high = page.entries.length - 1;
    let best: PageToolResponse | undefined;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const raw = createResultPage("Results", key, page.revision, page.entries.slice(0, count), page.offset, page.total ?? 0, page.warnings);
      raw.structuredContent.truncationReason = "output_budget";
      const candidate = presentPage(raw, presentation);
      if (pageResponseSize(candidate) <= maxChars) { best = candidate; low = count + 1; }
      else high = count - 1;
    }
    if (best) return best;
  }
  // Курсор без единой записи не продвигается: вместо него возвращаем явный отказ.
  return presentPage(pageFailure("budget_too_small", "Response exceeds maxChars. Increase maxChars or narrow the file/query filter."), presentation);
}
