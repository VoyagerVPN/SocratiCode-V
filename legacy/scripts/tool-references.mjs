// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const exploration = new Set(["search", "symbols", "symbol", "flow", "impact", "graph_query", "graph_stats",
  "graph_circular", "graph_visualize", "context", "context_search"]);
const root = fileURLToPath(new URL("../", import.meta.url));

function describe(tool) {
  const branches = tool.inputSchema.anyOf ?? tool.inputSchema.oneOf ?? [tool.inputSchema];
  const params = new Map(branches.flatMap((branch) => Object.entries(branch.properties ?? {})));
  const lines = ["## " + tool.name, "", tool.description, ""];
  if (params.size) {
    lines.push("| Параметр | Обязательность | Значение |", "|---|---|---|");
    for (const [name, field] of params) {
      const count = branches.filter((branch) => branch.required?.includes(name)).length;
      const allowed = field.enum?.join(", ") ?? field.const;
      const details = [field.description, allowed, field.minimum != null ? "min " + field.minimum : "",
        field.maximum != null ? "max " + field.maximum : ""].filter(Boolean).join(" · ").replaceAll("|", "\\|").replaceAll("\n", " ");
      lines.push("| " + name + " | " + (count === branches.length ? "да" : count ? "в части вариантов" : "нет") + " | " + details + " |");
    }
    if (branches.length > 1) lines.push("", "Варианты обязательных полей: " + branches.map(b => (b.required ?? []).join(" + ") || "∅").join(" / "));
    lines.push("");
  }
  return lines.join("\n");
}

export async function verifyToolReferences(pluginRoot, write = false) {
  // Схемы предоставляет временный loopback-сервер. Индексы и контейнеры ему не нужны.
  const previous = process.env.SOCRATICODE_MCP_TRANSPORT;
  process.env.SOCRATICODE_MCP_TRANSPORT = "http";
  const { createServer } = await import("../dist/index.js");
  const { startMcpHttp } = await import("../dist/services/mcp-http.js");
  const http = await startMcpHttp(createServer, 0);
  const client = new Client({ name: "skill-reference", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
    const tools = (await client.listTools()).tools;
    for (const skill of ["exploration", "management"]) {
      const selected = tools.filter(tool => exploration.has(tool.name.replace(/^codebase_/, "")) === (skill === "exploration"));
      const doc = ["# SocratiCode HTTP · " + skill, "", "Справочник получен из tools/list командой node scripts/tool-references.mjs --write.", "",
        ...selected.map(describe)].join("\n").trimEnd() + "\n";
      const dest = path.join(pluginRoot, "skills", "codebase-" + skill, "references", "tool-reference.md");
      if (write) await writeFile(dest, doc);
      else if ((await readFile(dest, "utf8")).replaceAll("\r\n", "\n") !== doc)
        throw new Error("Tool reference differs from server schema: " + dest);
    }
  } finally {
    await client.close();
    await http.close();
    if (previous === undefined) delete process.env.SOCRATICODE_MCP_TRANSPORT;
    else process.env.SOCRATICODE_MCP_TRANSPORT = previous;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await verifyToolReferences(path.join(root, "plugins/socraticode"), process.argv.includes("--write"));
}
