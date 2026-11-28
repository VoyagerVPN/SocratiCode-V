// SPDX-License-Identifier: AGPL-3.0-only
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Установка не меняет профиль Codex: только фиксирует расположение подготовленного сервера.
const pluginRoot = fileURLToPath(new URL("./", import.meta.url));
const serverRoot = path.join(pluginRoot, "server");
const profileFile = path.join(pluginRoot, "runtime.json");
const profile = JSON.parse(await readFile(profileFile, "utf8"));
if (typeof profile.version !== "string") throw new Error("Invalid runtime version");
if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Node.js 20 or newer is required");
await access(path.join(serverRoot, "dist", "launcher.js"));
const require = createRequire(path.join(serverRoot, "package.json"));
for (const dependency of ["@modelcontextprotocol/server", "@ast-grep/napi", "proper-lockfile"]) {
  try { require.resolve(dependency); } catch {
    throw new Error("Missing server dependencies. Run: node install-dependencies.mjs");
  }
}
if (process.argv.includes("--check")) {
  process.stdout.write(`SocratiCode ${profile.version}: server dependencies ready\n`);
} else {
  const index = process.argv.indexOf("--installation-file");
  if (index >= 0 && !process.argv[index + 1]) throw new Error("--installation-file requires a path");
  const receiptFile = path.resolve(index >= 0 ? process.argv[index + 1] :
    process.env.SOCRATICODE_INSTALLATION_FILE ?? path.join(homedir(), ".local", "share", "socraticode", "installation.json"));
  let previous;
  try { previous = JSON.parse(await readFile(receiptFile, "utf8")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previous && previous.serverRoot !== serverRoot && !process.argv.includes("--replace")) {
    throw new Error("Another SocratiCode installation is registered; inspect it before using --replace");
  }
  await mkdir(path.dirname(receiptFile), { recursive: true });
  const temporary = `${receiptFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: profile.version, serverRoot, profileFile }, null, 2) + "\n");
  await rename(temporary, receiptFile);
  process.stdout.write(`SocratiCode ${profile.version}: installation registered at ${receiptFile}\n`);
}
