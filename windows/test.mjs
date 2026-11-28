import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const repository = path.resolve(import.meta.dirname, "..");
const bin = path.join(repository, "runtime/bin");
const exe = path.join(bin, "SocratiCodeV.exe");
await access(exe);
const labProfile = JSON.parse(await readFile(path.join(bin, "profile.json"), "utf8"));
for (const key of ["node", "backend", "qdrant", "ollama", "models", "cache", "data", "catalog"]) {
  const relative = path.relative(repository, labProfile[key]);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), labProfile[key]);
  assert(![".lab", "legacy"].includes(relative.split(path.sep)[0]), labProfile[key]);
}
const cache = path.join(repository, ".cache/scv-windows");
await mkdir(cache, { recursive: true });
const root = await mkdtemp(path.join(cache, "test-"));
const projectPath = path.join(root, "new-project");
await mkdir(projectPath);
const profile = path.join(root, "profile.json");
const ports = { mcpPort: 28365, qdrantPort: 28333, qdrantGrpcPort: 28334, ollamaPort: 23435 };
await writeFile(profile, JSON.stringify({ ...labProfile, ...ports, data: path.join(root, "data"), tray: false }));

function start(mode) {
  const child = spawn(exe, [mode, "--profile", profile], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
  const exit = once(child, "exit");
  exit.catch(() => {});
  return { child, exit };
}

function requestClient() {
  const client = start("--mcp");
  const lines = createInterface({ input: client.child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  return { ...client, async request(method, params = {}) {
    const _meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "scv-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
    await new Promise((resolve, reject) => client.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta } })}\n`, error => error ? reject(error) : resolve()));
    const line = await Promise.race([lines.next(), client.exit.then(() => { throw new Error("SCV MCP завершился"); })]);
    const wire = JSON.parse(line.value);
    assert.equal(wire.id, id);
    assert(!wire.error, JSON.stringify(wire));
    return wire.result;
  } };
}

const listening = (port, route) => fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(400) })
  .then(() => true, () => false);
async function sessionStart(cwd) {
  const hook = start("--session-start");
  hook.child.stdin.end(JSON.stringify({ cwd, source: "startup" }));
  const [code] = await hook.exit;
  assert.equal(code, 0);
}
async function until(label, predicate, limit = 120_000) {
  const start = performance.now();
  while (performance.now() - start < limit) {
    if (await predicate()) return Math.round(performance.now() - start);
    await delay(250);
  }
  throw new Error(`Тайм-аут ${label}`);
}
const a = requestClient();
const b = requestClient();
try {
  await sessionStart(projectPath);
  assert(!await listening(ports.mcpPort, "/mcp"), "Хук разбудил пустой проект");
  for (const client of [a, b]) {
    const catalog = await client.request("tools/list");
    assert(catalog.tools.some(tool => tool.name === "codebase_setup"));
  }
  assert(!await listening(ports.mcpPort, "/mcp"));
  assert(!await listening(ports.qdrantPort, "/readyz"));
  assert(!await listening(ports.ollamaPort, "/api/version"));
  const inspect = (client, location) => client.request("tools/call", { name: "codebase_setup", arguments: { projectPath: location, action: "inspect" } });
  const responses = await Promise.all([inspect(a, projectPath), inspect(b, path.join(root, "missing"))]);
  assert.deepEqual(responses.map(reply => JSON.parse(reply.content[0].text).status), ["index_missing", "directory_missing"]);
  assert(await listening(ports.mcpPort, "/mcp"));
  assert(await listening(ports.qdrantPort, "/readyz"));
  assert(!await listening(ports.ollamaPort, "/api/version"));
  assert.deepEqual(await readdir(projectPath), []);
  console.log("Два клиента: обнаружение без сервера, общий запуск по первому вызову, Ollama спит, проект не изменён");

  const call = (name, args = {}) => a.request("tools/call", { name, arguments: { projectPath, ...args } });
  const text = reply => reply.content.map(item => item.text ?? "").join("\n");
  await writeFile(path.join(projectPath, "symbols.ts"), "export function forestCanopyCheck() { return 1; }\n");
  await writeFile(path.join(projectPath, "main.ts"), "import { forestCanopyCheck } from './symbols.js';\nexport const marker = forestCanopyCheck();\n");
  const denied = await call("codebase_index");
  assert.match(text(denied), /\.socraticodeignore/i);
  assert(!await listening(ports.ollamaPort, "/api/version"));
  await call("codebase_setup", { action: "save" });
  const preview = JSON.parse(text(await call("codebase_setup", { action: "preview" })));
  assert.deepEqual(preview.files.sort(), ["main.ts", "symbols.ts"]);
  const index = await call("codebase_index");
  assert.match(text(index), /Indexing started/i);
  const search = async (query, mode) => (await call("codebase_search", { query, mode, scope: "main", format: "json", minScore: 0 })).structuredContent?.entries ?? [];
  const elapsed = await until("индекс и watcher", async () => {
    const status = text(await call("codebase_status"));
    return /Status: green/.test(status) && /File watcher: active/.test(status) &&
      (await search("forestCanopyCheck", "exact")).some(hit => hit.file === "symbols.ts");
  });
  const ps = await fetch(`http://127.0.0.1:${ports.ollamaPort}/api/ps`).then(response => response.json());
  assert(ps.models.some(model => model.size_vram > 0));
  assert((await search("forest canopy check", "hybrid")).some(hit => hit.file === "symbols.ts"));
  assert.match(text(await call("codebase_graph_query", { filePath: "main.ts" })), /symbols\.ts/);
  await writeFile(path.join(projectPath, "symbols.ts"), "export function forestCanopyCheck() { return 1; }\nexport const watcherUpdate = 2;\n");
  const update = await until("обновление watcher", async () => (await search("watcherUpdate", "exact")).some(hit => hit.file === "symbols.ts"), 30_000);
  console.log(JSON.stringify({ firstIndexMs: elapsed, watcherMs: update, gpu: true, exact: true, hybrid: true, graph: true }));
} finally {
  const stop = start("--stop");
  stop.child.stdin.end();
  await stop.exit;
  for (const client of [a, b]) {
    client.child.stdin.end();
    await client.exit;
  }
}
for (let attempt = 0; attempt < 120; attempt++) {
  if (!await listening(ports.mcpPort, "/mcp") && !await listening(ports.qdrantPort, "/readyz") && !await listening(ports.ollamaPort, "/api/version")) break;
  await delay(100);
}
assert(!await listening(ports.mcpPort, "/mcp"));
assert(!await listening(ports.qdrantPort, "/readyz"));
assert(!await listening(ports.ollamaPort, "/api/version"));
console.log("После выхода сервер и хранилище остановлены");

try {
  await sessionStart(projectPath);
  assert(await listening(ports.mcpPort, "/mcp"));
  assert(!await listening(ports.ollamaPort, "/api/version"));
  console.log("Хук прогрел только настроенный проект, Ollama не запустилась");
} finally {
  const stop = start("--stop");
  stop.child.stdin.end();
  await stop.exit;
  await until("остановка после хука", async () => !await listening(ports.mcpPort, "/mcp") && !await listening(ports.qdrantPort, "/readyz"), 14_000);
}
