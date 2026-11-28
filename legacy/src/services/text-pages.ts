// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pageFingerprint } from "./result-pages.js";

export const textPageInputs = {
  maxChars: z.number().int().min(512).max(100000).optional().describe("Maximum text characters per page (default 12000)."),
  cursor: z.string().max(100).optional().describe("Continue with structuredContent.nextCursor and the same project and filters within five minutes."),
};

type Page = {
  content: [{ type: "text"; text: string }];
  structuredContent?: { offset: number; totalChars: number; nextCursor: string | null };
  isError?: boolean;
}
interface Snapshot { key: string; text: string; bytes: number; expires: number }
const snapshots = new Map<string, Snapshot>();
const capacity = 8 * 1024 * 1024;
function error(text: string): Page { return { isError: true, content: [{ type: "text", text }] }; }

export async function readTextPage(tool: string, args: Record<string, unknown>, load: () => Promise<string>): Promise<Page> {
  const { cursor, maxChars, ...filters } = args;
  const limit = typeof maxChars === "number" ? maxChars : 12000;
  const key = pageFingerprint([tool, Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))]);
  const now = Date.now();

  for (const [id, snapshot] of snapshots) {
    if (snapshot.expires <= now) snapshots.delete(id);

  }
  let id: string;
  let text: string;
  let offset = 0;
  if (cursor !== undefined) {
    const match = typeof cursor === "string" && /^([a-f0-9-]{36})\.([1-9]\d*)$/.exec(cursor);
    if (!match) return error("Invalid continuation. Repeat the original request without cursor.");
    id = match[1];
    const snapshot = snapshots.get(id);
    offset = Number(match[2]);
    if (!snapshot || snapshot.key !== key || offset >= snapshot.text.length)
      return error("Continuation expired or filters changed. Repeat the original request without cursor.");
    text = snapshot.text;
  } else {
    text = await load();
    if (text.length <= limit) return { content: [{ type: "text", text }] };
    const bytes = Buffer.byteLength(text);
    if (bytes > capacity) return error("Result exceeds the snapshot capacity. Narrow the query, artifact or graph depth.");
    let retained = Array.from(snapshots.values()).reduce((sum, item) => sum + item.bytes, 0);
    for (const [oldId, snapshot] of snapshots) {
      if (retained + bytes <= capacity && snapshots.size < 64) break;
      retained -= snapshot.bytes;
      snapshots.delete(oldId);
    }
    id = randomUUID();
    snapshots.set(id, { key, text, bytes, expires: Date.now() + 300000 });
  }
  let end = Math.min(offset + limit, text.length);
  if (end < text.length) {
    const newline = text.lastIndexOf("\n", end - 1);
    if (newline >= offset) end = newline + 1;
    else if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
  }
  return { content: [{ type: "text", text: text.slice(offset, end) }],
    structuredContent: { offset, totalChars: text.length, nextCursor: end < text.length ? id + "." + end : null } };
}
