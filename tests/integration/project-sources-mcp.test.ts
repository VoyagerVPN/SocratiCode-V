// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const qdrantUrl = process.env.SOCRATICODE_TEST_QDRANT_URL;
const cacheRoot = fileURLToPath(new URL("../../.cache/project-sources-tests/", import.meta.url));

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe.skipIf(!qdrantUrl)("Project sources through the MCP contract", () => {
  let root: string;
  let main: string;
  let client: Client;
  let clientEnv: Record<string, string>;
  const indexedRoots = new Set<string>();

  async function connect(name: string): Promise<Client> {
    const connected = new Client({ name, version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../../dist/launcher.js", import.meta.url))],
      cwd: main, env: clientEnv, stderr: "pipe",
    });
    await connected.connect(transport);
    transport.stderr?.resume();
    return connected;
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name, arguments: args }, { timeout: 120_000 });
    if (!record(result)) throw new Error("Invalid MCP result");
    return result;
  }

  function text(result: Record<string, unknown>): string {
    return Array.isArray(result.content)
      ? result.content.map((part: unknown) => record(part) && typeof part.text === "string" ? part.text : "").join("\n")
      : "";
  }

  function structured(result: Record<string, unknown>): Record<string, unknown> {
    expect(result.isError).not.toBe(true);
    expect(record(result.structuredContent)).toBe(true);
    if (!record(result.structuredContent)) throw new Error(text(result));
    return result.structuredContent;
  }

  async function index(projectPath: string, extra: Record<string, unknown> = {}): Promise<string> {
    indexedRoots.add(projectPath);
    const started = await call("codebase_index", { projectPath, ...extra });
    expect(started.isError).not.toBe(true);
    const initial = text(started);
    if (!initial.includes("started in the background")) return initial;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = text(await call("codebase_status", { projectPath }));
      if (/FAILED|Infrastructure setup failed/.test(status)) throw new Error(status);
      if (/Status: green/.test(status) && !/in progress|INCOMPLETE|ACTIVELY INDEXING/.test(status)) return initial;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Index did not finish: ${projectPath}`);
  }

  beforeAll(async () => {
    // Рабочий Qdrant запрещён: все индексы этого теста живут в отдельном контейнере.
    if (!qdrantUrl || new URL(qdrantUrl).port === "16333") throw new Error("Isolated Qdrant required");
    fs.mkdirSync(cacheRoot, { recursive: true });
    root = fs.mkdtempSync(path.join(cacheRoot, "workspace-"));
    main = path.join(root, "game");
    fs.mkdirSync(path.join(main, "src"), { recursive: true });
    fs.mkdirSync(path.join(main, ".temp", "unindexed-candidate"), { recursive: true });
    fs.mkdirSync(path.join(main, "nested-repository", ".git"), { recursive: true });
    fs.writeFileSync(path.join(main, "src", "game.ts"), "export const primaryGameMarker = 'main_source';\n");
    const plugin: unknown = JSON.parse(fs.readFileSync(new URL("../../plugins/socraticode/runtime.json", import.meta.url), "utf8"));
    if (!record(plugin) || !record(plugin.env)) throw new Error("Missing local model profile");
    const configured = Object.fromEntries(Object.entries(plugin.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    clientEnv = {
      ...configured,
      QDRANT_MODE: "external", QDRANT_URL: qdrantUrl,
      OLLAMA_MODE: "external", OLLAMA_URL: "http://127.0.0.1:11435",
      SOCRATICODE_AUTO_RESUME: "off", SOCRATICODE_AUTO_CLEANUP: "off", SOCRATICODE_WATCHER: "off",
      SOCRATICODE_IDLE_STOP_TIMEOUT_MS: "off",
      TEMP: cacheRoot, TMP: cacheRoot,
    };
    client = await connect("project-sources-test");
  });

  afterAll(async () => {
    if (client) for (const projectPath of indexedRoots) await call("codebase_remove", { projectPath });
    await client?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("defaults to the current project without discovering or indexing candidate repositories", async () => {
    const result = await call("codebase_list_projects");
    const catalog = structured(result);
    expect(catalog.scope).toBe("project");
    expect(catalog.project).toMatchObject({ path: main, index: "missing" });
    expect(catalog.sources).toEqual([]);
    expect(text(result)).not.toContain("unindexed-candidate");
  });

  it("indexes an external source and connects it to its parent in one call", async () => {
    const source = path.join(root, "downloaded-mod");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "mod.ts"), "export function inspirationMarker(): string { return 'external_mod_source'; }\n");
    fs.writeFileSync(path.join(main, ".socraticode.json"), JSON.stringify({ pythonRoots: ["src"], customSetting: "keep" }));
    await index(source, { parentPath: main });
    const catalog = structured(await call("codebase_list_projects", { projectPath: main }));
    expect(catalog.sources).toEqual([expect.objectContaining({ path: source, index: "available", association: "explicit" })]);
    const config: unknown = JSON.parse(fs.readFileSync(path.join(main, ".socraticode.json"), "utf8"));
    expect(config).toMatchObject({ pythonRoots: ["src"], customSetting: "keep" });
  });

  it("searches main plus sources by default and respects explicit main and sources scopes", async () => {
    await index(main);
    const args = { projectPath: main, query: "реализация функций игры и мода", limit: 50, minScore: 0 };
    const combined = text(await call("codebase_search", args));
    expect(combined).toContain("main_source");
    expect(combined).toContain("external_mod_source");
    const primary = text(await call("codebase_search", { ...args, scope: "main" }));
    expect(primary).toContain("main_source");
    expect(primary).not.toContain("external_mod_source");
    const sources = text(await call("codebase_search", { ...args, scope: "sources" }));
    expect(sources).toContain("external_mod_source");
    expect(sources).not.toContain("main_source");
  });

  it("uses an existing nested index as a source while leaving unindexed candidates alone", async () => {
    const source = path.join(main, ".temp", "indexed-mod");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "nested.ts"), "export const nestedSourceMarker = 'nested_mod_source';\n");
    await index(source);
    const catalog = structured(await call("codebase_list_projects", { projectPath: main }));
    expect(catalog.sources).toContainEqual(expect.objectContaining({ path: source, association: "nested", index: "available" }));
    expect(text(await call("codebase_list_projects", { projectPath: main }))).not.toContain("unindexed-candidate");
    const result = text(await call("codebase_search", { projectPath: main, scope: "sources", query: "код мода", minScore: 0, limit: 50 }));
    expect(result).toContain("nested_mod_source");
    expect(result).not.toContain("main_source");
  });

  it("previews and refuses a large index without attaching it or creating an index", async () => {
    const source = path.join(root, "large-source");
    fs.mkdirSync(source, { recursive: true });
    for (let file = 0; file < 3; file++) fs.writeFileSync(path.join(source, `file${file}.ts`), `export const value${file} = ${file};\n`);
    const preview = await call("codebase_index", { projectPath: source, parentPath: main, dryRun: true, maxFiles: 1 });
    expect(text(preview)).toContain('"files":3');
    const refused = await call("codebase_index", { projectPath: source, parentPath: main, maxFiles: 1 });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("Index limit exceeded");
    const catalog = structured(await call("codebase_list_projects", { projectPath: main }));
    expect(text(await call("codebase_list_projects", { projectPath: source }))).toContain('"index":"missing"');
    expect(catalog.sources).not.toContainEqual(expect.objectContaining({ path: source }));
  });

  it("attaches an existing source without rebuilding it and exposes missing declared sources", async () => {
    const source = path.join(root, "downloaded-mod");
    const before = structured(await call("codebase_list_projects", { projectPath: source })).project;
    const reply = await call("codebase_index", { projectPath: source, parentPath: main });
    expect(text(reply)).toContain("Source connected; existing index retained");
    expect(structured(await call("codebase_list_projects", { projectPath: source })).project).toEqual(before);
    const configPath = path.join(main, ".socraticode.json");
    const config: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!record(config) || !Array.isArray(config.linkedProjects)) throw new Error("Missing source config");
    config.linkedProjects.push("../removed-source");
    fs.writeFileSync(configPath, JSON.stringify(config));
    const catalog = structured(await call("codebase_list_projects", { projectPath: main }));
    expect(catalog.sources).toContainEqual(expect.objectContaining({ path: path.join(root, "removed-source"), index: "missing" }));
  });

  it("provides a paginated inventory only when all scope is explicit", async () => {
    const tools = await client.listTools();
    const listing = tools.tools.find((tool) => tool.name === "codebase_list_projects");
    expect(listing?.outputSchema).toBeDefined();
    expect(listing?.annotations?.readOnlyHint).toBe(true);
    const page = structured(await call("codebase_list_projects", { scope: "all", limit: 1 }));
    expect(page.projects).toHaveLength(1);
    expect(typeof page.nextCursor).toBe("string");
    const next = structured(await call("codebase_list_projects", { scope: "all", limit: 1, cursor: page.nextCursor }));
    expect(next.projects).not.toEqual(page.projects);
    const scoped = structured(await call("codebase_list_projects", { projectPath: main }));
    expect(scoped.projects).toBeUndefined();
  });

  it("preserves both attachments made by separate MCP clients", async () => {
    const parent = path.join(root, "another-game");
    fs.mkdirSync(parent);
    const sources = [path.join(root, "downloaded-mod"), path.join(main, ".temp", "indexed-mod")];
    const other = await connect("second-source-client");
    try {
      const replies = await Promise.all([
        call("codebase_index", { projectPath: sources[0], parentPath: parent }),
        other.callTool({ name: "codebase_index", arguments: { projectPath: sources[1], parentPath: parent } }),
      ]);
      for (const reply of replies) expect(reply.isError).not.toBe(true);
      const catalog = structured(await call("codebase_list_projects", { projectPath: parent }));
      expect(catalog.sources).toHaveLength(2);
      expect(catalog.project).toMatchObject({ index: "missing" });
      const configPath = path.join(parent, ".socraticode.json");
      fs.writeFileSync(configPath, "{invalid JSON");
      const refused = await call("codebase_index", { projectPath: sources[0], parentPath: parent });
      expect(refused.isError).toBe(true);
      expect(fs.readFileSync(configPath, "utf8")).toBe("{invalid JSON");
    } finally { await other.close(); }
  });

  it.skipIf(!process.env.SOCRATICODE_LARGE_JS_FIXTURE)("builds a graph for the large JS source that previously crashed the native parser", async () => {
    const fixture = process.env.SOCRATICODE_LARGE_JS_FIXTURE;
    if (!fixture) throw new Error("Large JS fixture required");
    const project = path.join(root, "parser-project");
    fs.mkdirSync(project);
    fs.copyFileSync(fixture, path.join(project, "large-script.js"));
    indexedRoots.add(project);
    await call("codebase_graph_build", { projectPath: project });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = text(await call("codebase_graph_status", { projectPath: project }));
      if (status.includes("Symbols:") && !status.includes("in progress")) {
        expect(status).not.toContain("FAILED");
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Large-source graph did not finish");
  });
});
