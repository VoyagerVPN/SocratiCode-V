import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureCatalog } from "./backend/catalog.mjs";

const src = import.meta.dirname;
const repository = path.resolve(src, "..");
const pkg = path.join(repository, "plugins/socraticode-v");
const runtime = path.join(repository, "runtime");
const bin = path.join(runtime, "bin");
const cache = path.join(repository, ".cache/scv-windows");
const node = path.join(bin, "node.exe");
const qdrant = path.join(bin, "qdrant-1.20.2/qdrant.exe");
const ollama = path.join(bin, "ollama-0.40.19/ollama.exe");
const models = path.join(runtime, "models");
const backend = path.join(src, "backend/dist/launcher.js");
const stage = process.argv.includes("--stage-shell");
await Promise.all([node, qdrant, ollama, models].map(file => access(file)));
await mkdir(cache, { recursive: true });
await mkdir(bin, { recursive: true });
const tmp = path.join(cache, "tmp");
await mkdir(tmp, { recursive: true });
const root = process.env["ProgramFiles(x86)"];
const vswhere = path.join(root, "Microsoft Visual Studio/Installer/vswhere.exe");
const sdk = path.join(root, "Windows Kits/10");
const env = { ...process.env, TEMP: tmp, TMP: tmp };
const run = (exe, args, opts = {}) => execFileSync(exe, args, {
  cwd: cache, windowsHide: true, stdio: "inherit", env, ...opts,
});
if (!stage) {
  run(node, [path.join(repository, "node_modules/typescript/bin/tsc"), "-p", path.join(repository, "tsconfig.json")], { cwd: repository });
  run(node, [path.join(repository, "scripts/copy-assets.mjs")], { cwd: repository });
  run(node, [path.join(src, "backend/prepare.mjs")], { cwd: repository });
}
const vs = run(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
const msvcBase = path.join(vs, "VC/Tools/MSVC");
const lastDirectoryVersion = async directory => (await readdir(directory)).sort(new Intl.Collator("en", { numeric: true }).compare).at(-1);
const msvc = path.join(msvcBase, await lastDirectoryVersion(msvcBase));
const sdkVersion = await lastDirectoryVersion(path.join(sdk, "Include"));
const sdkHeaders = path.join(sdk, "Include", sdkVersion);
const sdkLibs = path.join(sdk, "Lib", sdkVersion);
const vcBin = path.join(msvc, "bin/Hostx64/x64");
const sdkBin = path.join(sdk, "bin", sdkVersion, "x64");
const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "Path";
env[pathKey] = [vcBin, sdkBin, env[pathKey]].join(";");
env.INCLUDE = [path.join(msvc, "include"), ...["ucrt", "shared", "um", "winrt", "cppwinrt"].map(dir => path.join(sdkHeaders, dir))].join(";");
env.LIB = [path.join(msvc, "lib/x64"), path.join(sdkLibs, "ucrt/x64"), path.join(sdkLibs, "um/x64")].join(";");

run(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
  ["-NoProfile", "-NonInteractive", "-File", path.join(src, "icon.ps1"), "-LogoDirectory", path.join(pkg, "assets"), "-OutputDirectory", cache]);
const resource = path.join(cache, "scv.res");
run(path.join(sdkBin, "rc.exe"), ["/nologo", "/i", cache, "/fo", resource, path.join(src, "scv.rc")]);
const exe = path.join(stage ? cache : bin, "SocratiCodeV.exe");
run(path.join(vcBin, "cl.exe"), ["/nologo", "/std:c++20", "/utf-8", "/EHsc", "/O2", "/MT", "/W4", "/DUNICODE", "/D_UNICODE",
  path.join(src, "scv.cpp"), resource, `/Fe:${exe}`, "/link", "/SUBSYSTEM:WINDOWS", "/ENTRY:wmainCRTStartup",
  "windowsapp.lib", "winhttp.lib", "shell32.lib", "user32.lib", "ole32.lib", "oleaut32.lib", "uuid.lib", "advapi32.lib"]);
if (stage) {
  console.log(exe);
  process.exit(0);
}
const catalogDir = path.join(cache, "catalog-runtime");
await mkdir(catalogDir, { recursive: true });
const catalogPath = path.join(runtime, "catalog.json");
await writeFile(catalogPath, JSON.stringify(await captureCatalog(node, backend, catalogDir, env)));
const profilePath = path.join(bin, "profile.json");
const previous = await readFile(profilePath, "utf8").then(JSON.parse, error => {
  if (error.code !== "ENOENT") throw error;
  return {};
});
const profile = {
  mcpPort: 27365, qdrantPort: 27333, qdrantGrpcPort: 27334, ollamaPort: 22435, tray: true, warmPrepared: true,
  ...previous,
  node, backend, qdrant, ollama, models,
  cache: path.join(cache, "ollama"),
  data: path.join(runtime, "data"),
  catalog: catalogPath,
};
const settings = JSON.stringify(profile, null, 2) + "\n";
await writeFile(profilePath, settings);
const mcpFile = path.join(pkg, "mcp.json");
await writeFile(mcpFile, JSON.stringify({ mcpServers: { scv: {
  type: "stdio", command: exe, args: ["--mcp"], env: { CODEX_MCP_PROTOCOL_VERSION: "2026-07-28" },
} } }, null, 2) + "\n");
const hooks = { hooks: { SessionStart: [{ matcher: "^(startup|resume)$", hooks: [{
  type: "command", command: `& '${exe.replaceAll("'", "''")}' --session-start`, async: true, timeout: 30,
}] }] } };
await mkdir(path.join(pkg, "hooks"), { recursive: true });
await writeFile(path.join(pkg, "hooks/hooks.json"), JSON.stringify(hooks, null, 2) + "\n");
console.log(exe);
