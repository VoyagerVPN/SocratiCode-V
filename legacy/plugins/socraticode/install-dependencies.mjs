// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("./server/", import.meta.url));
const cache = path.join(serverRoot, ".cache");
const guard = path.join(serverRoot, "scripts", "windows-test-processes.cjs");
const index = process.argv.indexOf("--npm-cli");
if (index >= 0 && !process.argv[index + 1]) throw new Error("--npm-cli requires a path");
const npmCli = index >= 0 ? path.resolve(process.argv[index + 1]) :
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
try { await access(npmCli); } catch {
  throw new Error("Find npm/bin/npm-cli.js in your Node.js installation and pass --npm-cli <path>");
}
for (const directory of ["npm", "node-gyp", "tmp"]) await mkdir(path.join(cache, directory), { recursive: true });
// Прямой Node запускает npm без npm.cmd; preload наследуется Node-процессами установки.
const preload = `--require ${JSON.stringify(guard.replaceAll("\\", "/"))}`;
const child = spawn(process.execPath, ["--require", guard, npmCli, "ci", "--no-audit", "--no-fund"], {
  cwd: serverRoot, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, npm_config_cache: path.join(cache, "npm"), npm_config_devdir: path.join(cache, "node-gyp"),
    TEMP: path.join(cache, "tmp"), TMP: path.join(cache, "tmp"), TMPDIR: path.join(cache, "tmp"),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" "), NO_COLOR: "1" },
});
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.once("error", (error) => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
child.once("close", (code) => { process.exitCode = code ?? 1; });
