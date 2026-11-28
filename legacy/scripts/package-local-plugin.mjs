// SPDX-License-Identifier: AGPL-3.0-only
import { verifyToolReferences } from "./tool-references.mjs";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "plugins", "socraticode");
const profile = JSON.parse(await readFile(path.join(source, "runtime.json"), "utf8"));
const cache = path.join(root, ".cache", "portable-export");
await mkdir(cache, { recursive: true });
const stage = await mkdtemp(path.join(cache, "release-"));
const plugin = path.join(stage, "socraticode");
const server = path.join(plugin, "server");
const index = process.argv.indexOf("--output");
if (index >= 0 && !process.argv[index + 1]) throw new Error("--output requires a path");
const archive = path.resolve(index >= 0 ? process.argv[index + 1] : path.join(cache, `SocratiCode-V-${profile.version}.zip`));
const forbidden = new Set([".git", ".cache", ".research", ".tgrep", "node_modules", ".env", "%SystemDrive%"]);

async function copyClean(from, to) {
  const stat = await lstat(from);
  if (stat.isSymbolicLink()) throw new Error(`Symlink not allowed in distribution: ${from}`);
  if (stat.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from)) {
      if (forbidden.has(entry) || entry.startsWith(".env.")) continue;
      await copyClean(path.join(from, entry), path.join(to, entry));
    }
  } else {
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to);
  }
}

await copyClean(source, plugin);
await verifyToolReferences(plugin);
for (const entry of ["src", "dist", "scripts", "tests", "package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "biome.json", "LICENSE", "LICENSE-COMMERCIAL", "THIRD-PARTY-LICENSES"]) {
  await copyClean(path.join(root, entry), path.join(server, entry));
}
await copyClean(path.join(root, "README.md"), path.join(server, "README.md"));
await copyClean(path.join(root, "LICENSE"), path.join(plugin, "LICENSE"));
const packageFile = path.join(server, "package.json");
const pkg = JSON.parse(await readFile(packageFile, "utf8"));
pkg.version = profile.version;
// Сервер передаётся вместе с плагином, без upstream stdio/npx entrypoint.
delete pkg.bin;
pkg.scripts = { build: "tsc && node scripts/copy-assets.mjs", start: "node ../hooks/session-start.mjs",
  test: "node --require ./scripts/windows-test-processes.cjs ./node_modules/vitest/vitest.mjs run" };
pkg.files = ["dist", "src", "scripts", "tests", "LICENSE", "THIRD-PARTY-LICENSES"];
await writeFile(packageFile, JSON.stringify(pkg, null, 2) + "\n");
const lockFile = path.join(server, "package-lock.json");
const lock = JSON.parse(await readFile(lockFile, "utf8"));
lock.version = profile.version;
lock.packages[""].version = profile.version;
delete lock.packages[""].bin;
await writeFile(lockFile, JSON.stringify(lock, null, 2) + "\n");
await writeFile(path.join(server, ".gitignore"), "node_modules/\ndist/\n.cache/\n.tgrep/\ncoverage/\n*.log\n.env\n");
await writeFile(path.join(server, "AGENTS.md"), "# Обслуживание сервера\n\nСначала прочитай ../AGENTS.md. Здесь исходники, готовая сборка и lockfile именно исправленного форка. Не заменяй сервер upstream-версией. Все кэши направляй в .cache, автоматические процессы запускай без окон. Для тестов используй scripts/windows-test-processes.cjs и threads.\n");
await mkdir(path.join(plugin, ".agents", "plugins"), { recursive: true });
await writeFile(path.join(plugin, ".agents", "plugins", "marketplace.json"), JSON.stringify({
  name: "socraticode-fixed", interface: { displayName: "SocratiCode V" }, plugins: [{ name: "socraticode",
    category: "Development", source: { source: "local", path: "./" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" } }],
}, null, 2) + "\n");
await writeFile(path.join(plugin, "RELEASE.json"), JSON.stringify({
  name: "socraticode", version: profile.version, builtAt: new Date().toISOString(),
  sourceBase: "1e829bf7ddf1e34c4cc6713227f00422cee791cc",
  ollamaBackportFrom: "401a920264b0d38fa86a6702e8ddcf5361a8d557",
  transport: "stateless-http", protocol: "2026-07-28", sourceIncluded: true,
}, null, 2) + "\n");

if (process.argv.includes("--stage-only")) {
  process.stdout.write(JSON.stringify({ stage, plugin, archive }) + "\n");
} else {
  if (process.platform !== "win32") throw new Error("ZIP creation uses Windows .NET; use --stage-only and zip the single socraticode folder on other platforms");
  await mkdir(path.dirname(archive), { recursive: true });
  const zipper = path.join(cache, "zip.ps1");
  await writeFile(zipper, 'param([string]$Source,[string]$Archive)\n$ErrorActionPreference = "Stop"\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[System.IO.Compression.ZipFile]::CreateFromDirectory($Source,$Archive,[System.IO.Compression.CompressionLevel]::Optimal,$false)\n');
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", zipper, "-Source", stage, "-Archive", archive], {
      cwd: root, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ZIP failed (${code}): ${errors}`)));
  });
  process.stdout.write(JSON.stringify({ stage, plugin, archive }) + "\n");
}
