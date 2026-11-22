// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SEARCH_DEFAULT_LIMIT, SEARCH_MIN_SCORE } from "../constants.js";
import type { SearchResult } from "../types.js";
import { inlineLabel, pageFingerprint, pageResponseSize } from "./result-pages.js";

const searchEntrySchema = z.object({
  id: z.string(), rank: z.number().int().positive(), source: z.string(), file: z.string(),
  startLine: z.number().int(), endLine: z.number().int(), language: z.string(), score: z.number(), content: z.string(),
});
const fullSearchPageSchema = z.object({
  status: z.enum(["ok", "empty", "partial", "failed", "index_missing", "cursor_invalid", "cursor_stale", "budget_too_small"]),
  returned: z.number().int().nonnegative(), total: z.number().int().nonnegative().nullable(),
  totalScope: z.literal("ranked_window"), candidateLimit: z.number().int().positive().nullable(),
  filteredCount: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
  hasMore: z.boolean(), truncated: z.boolean(), truncationReason: z.literal("output_budget").nullable(),
  nextCursor: z.string().nullable(), snapshotAt: z.string().nullable(), expiresAt: z.string().nullable(),
  coverageKnown: z.boolean(), partial: z.boolean(), searchedSources: z.array(z.string()), failedSources: z.array(z.object({ path: z.string(), error: z.string() })),
  skippedSources: z.array(z.string()), incompleteSources: z.array(z.string()), warnings: z.array(z.string()),
  entries: z.array(searchEntrySchema),
});
export const searchPageSchema = fullSearchPageSchema.partial().extend({
  status: fullSearchPageSchema.shape.status, returned: fullSearchPageSchema.shape.returned,
  hasMore: z.boolean(), nextCursor: z.string().nullable(), partial: z.boolean(), coverageKnown: z.boolean(),
  entries: z.array(searchEntrySchema).optional(),
  minimumChars: z.number().int().positive().optional(),
});
export type SearchPage = z.infer<typeof fullSearchPageSchema>;
export interface SearchToolResponse { text: string; isError: boolean; structuredContent: z.infer<typeof searchPageSchema>; }
export interface SearchSelection {
  status: "ok" | "empty" | "partial" | "failed" | "index_missing";
  partial: boolean; searchedSources: string[]; failedSources: Array<{ path: string; error: string }>;
  skippedSources: string[]; incompleteSources: string[];
}
interface Snapshot {
  id: string; key: string; bytes: number; page: SearchPage; isError: boolean;
}
const snapshots = new Map<string, Snapshot>();
let retainedBytes = 0;
const TTL_MS = 5 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOTS = 64;
function requestKey(args: Record<string, unknown>): string {
  return pageFingerprint([args.projectPath, args.query, args.limit ?? SEARCH_DEFAULT_LIMIT,
    typeof args.fileFilter === "string" ? args.fileFilter.replaceAll("\\", "/") : null,
    args.languageFilter ?? null, args.minScore ?? SEARCH_MIN_SCORE,
    args.scope ?? (args.includeLinked === false ? "main" : "project")]);
}
function forget(id: string): void {
  const snapshot = snapshots.get(id);
  if (snapshot) { retainedBytes -= snapshot.bytes; snapshots.delete(id); }
}
function prune(): void {
  for (const [id, snapshot] of snapshots) {
    if (Date.parse(snapshot.page.expiresAt ?? "") <= Date.now()) forget(id);
  }
}
function cursor(snapshot: Snapshot, offset: number): string {
  const value = Buffer.alloc(53);
  value[0] = 3;
  Buffer.from(snapshot.key, "hex").copy(value, 1);
  Buffer.from(snapshot.id.replaceAll("-", ""), "hex").copy(value, 33);
  value.writeUInt32BE(offset, 49);
  return value.toString("base64url");
}
function failure(status: "cursor_invalid" | "cursor_stale" | "budget_too_small", text: string, minimumChars?: number): SearchToolResponse {
  return { text, isError: true, structuredContent: {
    status, returned: 0, hasMore: false, nextCursor: null, partial: true, coverageKnown: false, entries: [],
    ...(minimumChars === undefined ? {} : { minimumChars }),
  } };
}
type PrintedLine = { text: string; rank: number };

function codeBlock(content: string): string {
  let width = 3;
  for (const match of content.matchAll(/\u0060+/g)) width = Math.max(width, match[0].length + 1);
  const fence = "\u0060".repeat(width);
  return [fence, content, fence].join("\n");
}

function compactChunk(entry: SearchPage["entries"][number], seen: Map<number, PrintedLine>): string {
  const full = codeBlock(entry.content);
  const lines = entry.content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  // Старые снимки и разрезанные длинные строки могут иметь неполную разметку.
  if (lines.length !== entry.endLine - entry.startLine + 1) return full;
  const parts: string[] = [];
  let start = 0;
  while (start < lines.length) {
    const rankAt = (i: number) => {
      const previous = seen.get(entry.startLine + i);
      return previous?.text === lines[i] ? previous.rank : undefined;
    };
    const rank = rankAt(start);
    let end = start + 1;
    while (end < lines.length && rankAt(end) === rank) end++;
    if (rank === undefined) {
      parts.push(codeBlock(lines.slice(start, end).join("")));
      for (let i = start; i < end; i++) seen.set(entry.startLine + i, { text: lines[i], rank: entry.rank });
    } else {
      const range = start + 1 === end ? String(entry.startLine + start) : (entry.startLine + start) + "-" + (entry.startLine + end - 1);
      parts.push("L" + range + " = #" + rank);
    }
    start = end;
  }
  const compact = parts.join("\n");
  return compact.length < full.length ? compact : full;
}

function makePage(snapshot: Snapshot, offset: number, count: number, format: unknown, excerpt?: { start: number; lines: string[] }): SearchToolResponse {
  const total = snapshot.page.entries.length;
  const hasMore = offset + count < total;
  const status = snapshot.page.status;
  const summary = status === "failed" ? "Search failed: no selected source could be queried."
    : status === "index_missing" ? "No codebase index found. Index this project only when indexing is intended."
    : total === 0 ? "No results in the selected search window."
    : "Search: " + count + " of " + total + " selected matches";
  const page: SearchPage = { ...snapshot.page, returned: count, offset, hasMore, truncated: hasMore,
    truncationReason: hasMore ? "output_budget" : null,
    nextCursor: hasMore ? cursor(snapshot, offset + count) : null, entries: snapshot.page.entries.slice(offset, offset + count) };
  if (format === "json") return {
    text: summary + (total ? "; code in structuredContent.entries." : "")
      + (page.partial ? " Partial search: see source coverage." : "")
      + (page.warnings.length ? " Snapshot warning: see warnings." : "")
      + (hasMore ? " Continue with nextCursor and the same query, limit and filters." : ""),
    isError: snapshot.isError, structuredContent: page,
  };
  const lines = [summary + (page.partial ? ". Partial search: see source coverage." : "")];
  const printed = new Map<string, Map<number, PrintedLine>>();
  for (const entry of page.entries) {
    const sourceIndex = page.searchedSources.indexOf(entry.source);
    const source = page.searchedSources.length === 1 && sourceIndex === 0 ? ""
      : sourceIndex >= 0 ? "[" + (sourceIndex + 1) + "] " : "[" + inlineLabel(entry.source) + "] ";
    lines.push(entry.rank + ". " + source + inlineLabel(entry.file) + ":" + entry.startLine + "-" + entry.endLine
      + " " + inlineLabel(entry.language) + " score=" + entry.score);
    const key = JSON.stringify([entry.source, entry.file]);
    const seen = printed.get(key) ?? new Map<number, PrintedLine>();
    printed.set(key, seen);
    if (excerpt) {
      const first = entry.startLine + excerpt.start;
      lines.push(`excerpt L${first}-${first + excerpt.lines.length - 1}`, codeBlock(excerpt.lines.join("")));
    } else lines.push(compactChunk(entry, seen));
  }
  return { text: lines.join("\n"), isError: snapshot.isError, structuredContent: {
    status: page.status, returned: count, total, totalScope: page.totalScope, candidateLimit: page.candidateLimit,
    offset, hasMore, nextCursor: page.nextCursor, snapshotAt: page.snapshotAt,
    partial: page.partial, coverageKnown: page.coverageKnown, searchedSources: page.searchedSources,
    ...(hasMore ? { truncationReason: page.truncationReason, expiresAt: page.expiresAt } : {}),
    ...(page.filteredCount ? { filteredCount: page.filteredCount } : {}),
    ...(page.failedSources.length ? { failedSources: page.failedSources } : {}),
    ...(page.skippedSources.length ? { skippedSources: page.skippedSources } : {}),
    ...(page.incompleteSources.length ? { incompleteSources: page.incompleteSources } : {}),
    ...(page.warnings.length ? { warnings: page.warnings } : {}),
  } };
}
function fitSearchPage(snapshot: Snapshot, offset: number, maxChars: number, format: unknown, query: string): SearchToolResponse {
  const complete = makePage(snapshot, offset, snapshot.page.entries.length - offset, format);
  if (pageResponseSize(complete) <= maxChars) return complete;
  let low = snapshot.page.entries.length ? 1 : 0;
  let high = snapshot.page.entries.length - offset;
  let best: SearchToolResponse | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const result = makePage(snapshot, offset, count, format);
    if (pageResponseSize(result) <= maxChars) { best = result; low = count + 1; }
    else high = count - 1;
  }
  if (best) return best;
  const entry = snapshot.page.entries[offset];
  let minimum = Math.min(pageResponseSize(complete), pageResponseSize(makePage(snapshot, offset, entry ? 1 : 0, format)));
  if (entry && format !== "json") {
    const lines = entry.content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (lines.length === entry.endLine - entry.startLine + 1) {
      const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
      let anchor = 0;
      let bestScore = -1;
      for (const [i, line] of lines.entries()) {
        if (!line.trim()) continue;
        const normalized = line.toLowerCase();
        const score = terms.reduce((sum, term) => sum + Number(normalized.includes(term)), 0);
        if (score > bestScore) { anchor = i; bestScore = score; }
      }
      for (const radius of [3, 2, 1, 0]) {
        const start = Math.max(0, anchor - radius);
        const excerpt = { start, lines: lines.slice(start, anchor + radius + 1) };
        const preview = makePage(snapshot, offset, 1, format, excerpt);
        const size = pageResponseSize(preview);
        if (size <= maxChars) return preview;
        minimum = Math.min(minimum, size);
      }
    }
  }
  return failure("budget_too_small", `Code or source coverage exceeds maxChars. Retry with maxChars=${minimum}.`, minimum);
}
export function createSearchPage(
  args: Record<string, unknown>, results: SearchResult[], selection: SearchSelection, warnings: string[], filteredCount: number,
): SearchToolResponse {
  prune();
  const key = requestKey(args);
  const snapshot: Snapshot = { id: randomUUID(), key, bytes: 0, isError: selection.status === "failed" || selection.status === "index_missing",
    page: { ...selection, coverageKnown: true, returned: 0, total: results.length, totalScope: "ranked_window",
      candidateLimit: typeof args.limit === "number" ? args.limit : SEARCH_DEFAULT_LIMIT,
      filteredCount, offset: 0, hasMore: false, truncated: false, truncationReason: null, nextCursor: null,
      snapshotAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TTL_MS).toISOString(), warnings,
      entries: results.map((r, index) => ({ id: pageFingerprint([r.project ?? args.projectPath, r.relativePath.replaceAll("\\", "/"), r.startLine, r.endLine, r.content]),
        rank: index + 1, source: r.project ?? String(args.projectPath), file: r.relativePath.replaceAll("\\", "/"),
        startLine: r.startLine, endLine: r.endLine, language: r.language, score: r.score, content: r.content })),
    } };
  const response = fitSearchPage(snapshot, 0, typeof args.maxChars === "number" ? args.maxChars : 12000, args.format, String(args.query ?? ""));
  if (response.structuredContent.hasMore) {
    snapshot.bytes = Buffer.byteLength(JSON.stringify(snapshot));
    if (snapshot.bytes > MAX_BYTES) return failure("budget_too_small", "Search snapshot exceeds retention budget. Narrow filters or reduce limit.");
    while (snapshots.size >= MAX_SNAPSHOTS || retainedBytes + snapshot.bytes > MAX_BYTES) {
      const oldest = snapshots.keys().next().value;
      if (!oldest) break;
      forget(oldest);
    }
    snapshots.set(snapshot.id, snapshot); retainedBytes += snapshot.bytes;
  }
  return response;
}
export function continueSearchPage(args: Record<string, unknown>): SearchToolResponse {
  prune();
  const raw = args.cursor;
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{71}$/.test(raw)) return failure("cursor_invalid", "Invalid search cursor. Start without cursor.");
  const decoded = Buffer.from(raw, "base64url");
  if (decoded.length !== 53 || decoded[0] !== 3 || decoded.toString("base64url") !== raw || decoded.readUInt32BE(49) === 0) {
    return failure("cursor_invalid", "Invalid search cursor. Start without cursor.");
  }
  const hexId = decoded.subarray(33, 49).toString("hex");
  const value = { key: decoded.subarray(1, 33).toString("hex"), offset: decoded.readUInt32BE(49),
    id: [hexId.slice(0, 8), hexId.slice(8, 12), hexId.slice(12, 16), hexId.slice(16, 20), hexId.slice(20)].join("-") };
  if (value.key !== requestKey(args)) return failure("cursor_invalid", "Cursor belongs to a different project, query, limit or filters.");
  const snapshot = snapshots.get(value.id);
  if (!snapshot) return failure("cursor_stale", "Search snapshot expired, was evicted or the server restarted. Start without cursor.");
  if (value.offset >= snapshot.page.entries.length || value.key !== snapshot.key) return failure("cursor_invalid", "Cursor offset is outside this search window.");
  return fitSearchPage(snapshot, value.offset, typeof args.maxChars === "number" ? args.maxChars : 12000, args.format, String(args.query ?? ""));
}
