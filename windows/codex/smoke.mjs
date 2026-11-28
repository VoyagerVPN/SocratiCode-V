import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const pkg = path.resolve(import.meta.dirname, "../..");
const cache = path.resolve(pkg, ".cache/scv-windows/codex");
const codex = process.argv[2] ?? "codex.exe";
const pluginId = "socraticode-v@socraticode-v-local";

const plugin = path.join(pkg, "plugins/socraticode-v");
const overlay = JSON.parse(await readFile(path.join(plugin, ".codex-plugin/plugin.json"), "utf8"));
const exe = path.join(pkg, "runtime/bin/SocratiCodeV.exe");
assert.equal(overlay.name, "socraticode-v");
const png = await readFile(path.join(plugin, "assets/scv.png"));
assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[25]], [1024, 1024, 6]);

await mkdir(cache, { recursive: true });
const probe = await mkdtemp(path.join(cache, "probe-"));
const fixture = path.join(probe, "new-project");
await mkdir(fixture);
const runtimeProfile = {
  ...JSON.parse(await readFile(path.join(pkg, "runtime/bin/profile.json"), "utf8")),
  mcpPort: 29365, qdrantPort: 29333, qdrantGrpcPort: 29334, ollamaPort: 24435,
};
const profilePath = path.join(probe, "profile.json");
await writeFile(profilePath, JSON.stringify({ ...runtimeProfile, data: path.join(probe, "data"), tray: false }));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    /^(Path|SystemRoot|SystemDrive|LOCALAPPDATA|APPDATA|USERPROFILE|ProgramData|ProgramFiles|ComSpec|PATHEXT|WINDIR)$/i.test(key)
  ))),
  CODEX_HOME: path.join(probe, "codex-home"),
  TEMP: probe,
  TMP: probe,
  SCV_PROFILE: profilePath,
};
await mkdir(env.CODEX_HOME);
const model = createServer((request, response) => {
  request.resume();
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.flushHeaders();
  const timer = setTimeout(() => response.end("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_lab\",\"status\":\"completed\",\"output\":[]}}\n\n"), 12_000);
  response.on("close", () => clearTimeout(timer));
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
model.unref();
await writeFile(path.join(env.CODEX_HOME, "config.toml"),
  `model = "fixture-model"\nmodel_provider = "scv_fixture"\n\n[features]\nmcp_2026_07_28 = true\nhooks = true\n` +
  `\n[model_providers.scv_fixture]\nname = "SCV Hook Fixture"\nbase_url = "http://127.0.0.1:${model.address().port}/v1"\nwire_api = "responses"\n` +
  `\n[projects.'${fixture}']\ntrust_level = "trusted"\n`);
const market = path.join(probe, "market");
await cp(path.join(pkg, ".agents"), path.join(market, ".agents"), { recursive: true });
const testPackage = path.join(market, "plugins/socraticode-v");
await cp(plugin, testPackage, { recursive: true });
const testMcp = path.join(testPackage, "mcp.json");
const registration = JSON.parse(await readFile(testMcp, "utf8"));
assert.equal(registration.mcpServers.scv.command, exe);
registration.mcpServers.scv.args.push("--profile", profilePath);
await writeFile(testMcp, JSON.stringify(registration));
const testHooks = path.join(testPackage, "hooks/hooks.json");
const hooksConfig = JSON.parse(await readFile(testHooks, "utf8"));
hooksConfig.hooks.SessionStart[0].hooks[0].command += ` --profile '${profilePath.replaceAll("'", "''")}'`;
await writeFile(testHooks, JSON.stringify(hooksConfig));

function cli(args) {
  return JSON.parse(execFileSync(codex, args, {
    cwd: pkg, env, windowsHide: true, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  }));
}

function connect(proc) {
  let id = 0;
  const pending = new Map();
  createInterface({ input: proc.stdout }).on("line", line => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  proc.stderr.resume();

  return (method, params, notify = false) => {
    if (notify) return proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Тайм-аут ${method}`));
      }, 20_000);
      pending.set(requestId, { resolve, reject, timeout });
      proc.stdin.write(`${JSON.stringify({ method, id: requestId, params })}\n`);
    });
  };
}

cli(["plugin", "marketplace", "add", market, "--json"]);
assert.equal(cli(["plugin", "add", pluginId, "--json"]).pluginId, pluginId);
const mcp = cli(["mcp", "list", "--json"]).find(entry => entry.name === "scv").transport;
assert.equal(mcp.type, "stdio");
assert(mcp.command.endsWith("SocratiCodeV.exe"));
const listening = (port, route) => fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(350) })
  .then(() => true, () => false);
const runtimeOnline = () => listening(runtimeProfile.mcpPort, "/mcp");
async function stopRuntime() {
  execFileSync(exe, ["--stop", "--profile", profilePath], { env, windowsHide: true, timeout: 5000, stdio: "pipe" });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (!await runtimeOnline() && !await listening(runtimeProfile.qdrantPort, "/readyz")) return;
    await delay(100);
  }
  assert.fail("Лабораторный SCV не остановился");
}
const ownHook = async ask => (await ask("hooks/list", { cwds: [fixture] })).data
  .flatMap(entry => entry.hooks).find(entry => entry.pluginId === pluginId);

let app;
let checked = false;
try {
  app = spawn(codex, ["app-server", "--listen", "stdio://"], {
    cwd: fixture, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const ask = connect(app);
  await ask("initialize", {
    clientInfo: { name: "scv-lab-check", title: "SCV Lab Check", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  ask("initialized", undefined, true);
  const skills = await ask("skills/list", { cwds: [fixture] });
  const skillNames = skills.data.flatMap(entry => entry.skills.map(skill => skill.name));
  assert(skillNames.some(name => name.split(":").at(-1) === "scv-code"), JSON.stringify(skillNames));
  const threads = await Promise.all([fixture, fixture].map(cwd => ask("thread/start", { cwd, ephemeral: true })));
  const discovered = await ask("mcpServerStatus/list", { threadId: threads[0].thread.id, serverName: "scv" });
  const connection = discovered.data.find(item => item.name === "scv");
  assert.equal(connection?.pluginId, pluginId);
  assert(connection.tools.codebase_setup && connection.tools.codebase_search, JSON.stringify(connection));
  assert(!await listening(runtimeProfile.mcpPort, "/mcp"), "Codex запустил общий сервер при обнаружении инструментов");
  const projectPaths = [fixture, path.join(probe, "not-created")];
  const calls = await Promise.all(threads.map(({ thread }, index) => ask("mcpServer/tool/call", {
    threadId: thread.id, server: "scv", tool: "codebase_setup", arguments: { projectPath: projectPaths[index], action: "inspect" },
  })));
  for (const call of calls) assert(!call.isError, JSON.stringify(call));
  const states = calls.map(call => JSON.parse(call.content[0].text).status);
  assert.deepEqual(states, ["index_missing", "directory_missing"]);
  assert.deepEqual(await readdir(fixture), []);
  assert(await listening(runtimeProfile.mcpPort, "/mcp"));
  assert(!await listening(runtimeProfile.ollamaPort, "/api/version"));
  const hook = await ownHook(ask);
  assert.equal(hook?.eventName, "sessionStart");
  assert.equal(hook?.async, true);
  assert.equal(hook.trustStatus, "untrusted");
  await ask("config/batchWrite", {
    edits: [{ keyPath: "hooks.state", value: { [hook.key]: { trusted_hash: hook.currentHash } }, mergeStrategy: "upsert" }],
    reloadUserConfig: true,
  });
  assert.equal((await ownHook(ask)).trustStatus, "trusted");
  await stopRuntime();
  await writeFile(path.join(fixture, ".socraticodeignore"), ".lab/\n");
  const reloaded = await ask("thread/start", { cwd: fixture, ephemeral: true });
  assert(!await runtimeOnline());
  await ask("turn/start", { threadId: reloaded.thread.id, input: [{ type: "text", text: "SCV startup test", text_elements: [] }] });
  for (let attempt = 0; attempt < 100 && !await runtimeOnline(); attempt++) await delay(250);
  assert(await runtimeOnline(), "Доверенный хук Codex не запустил SCV");
  assert(!await listening(runtimeProfile.ollamaPort, "/api/version"));
  checked = true;
  console.log(JSON.stringify({ plugin: pluginId, tools: Object.keys(connection.tools).length, states, projectWrites: 0, ollamaStarted: false, trustedHookStartedRuntime: true }));
} finally {
  if (app?.pid && app.exitCode === null && app.signalCode === null) {
    const exited = once(app, "exit");
    app.stdin.end();
    await Promise.race([exited, delay(500)]);
    if (app.exitCode === null && app.signalCode === null) app.kill();
    await exited;
  }
  model.closeAllConnections();
  model.close();
  const wasStarted = await runtimeOnline();
  await stopRuntime();
  if (checked) {
    assert(wasStarted, "Закрытие Codex остановило общий SCV");
    console.log(JSON.stringify({ runtimeOutlivedCodex: wasStarted }));
  }
}
