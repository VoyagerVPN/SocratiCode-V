// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = path.join(process.env.SOCRATICODE_RUNTIME_DIR ?? path.join(root, ".cache", "runtime"), "diagnostics");
const port = Number(process.env.SOCRATICODE_MCP_PORT ?? 16335);
const recent = new Map();
let files = [];
try { files = await readdir(dir); } catch (error) { if (error.code !== "ENOENT") throw error; }
for (const name of files.filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().reverse()) {
  for (const line of (await readFile(path.join(dir, name), "utf8")).split("\n").reverse()) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.port !== port) continue;
    const type = (e.stage.startsWith("hook_") || e.stage.startsWith("http_")) ? "hook" : "search";
    const latest = recent.get(type) ?? { id: e.id, events: [] };
    if (e.id === latest.id) latest.events.unshift(e);
    recent.set(type, latest);
  }
  if (recent.size === 2 && [...recent.values()].every(item => item.events[0].stage.endsWith("_start"))) break;
}
for (const type of ["hook", "search"]) {
  console.log(type);
  const events = recent.get(type)?.events ?? [];
  if (!events.length) console.log("  Нет зарегистрированных событий");
  for (const { at, stage, ms, source, outcome, status, returned } of events) {
    console.log(" ", at, stage, ms + " ms", [source, outcome, status, returned].filter(v => v !== undefined).join(" "));
  }
}
