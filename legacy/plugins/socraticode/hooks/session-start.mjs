// Общий сервер живёт вне чата; запускатель сериализует одновременные вызовы.
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const started = performance.now();
const bundled = new URL("../server/dist/http-service.js", import.meta.url);
const development = new URL("../../../dist/http-service.js", import.meta.url);
let entry = bundled;
let profileFile = new URL("../runtime.json", import.meta.url);
try {
  await access(bundled);
  await access(new URL("../server/node_modules/@modelcontextprotocol/server", import.meta.url));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  try {
    await access(development);
    entry = development;
  } catch (developmentError) {
    if (developmentError.code !== "ENOENT") throw developmentError;
    // Codex использует кешированную копию; зависимости остаются в установленной папке.
    const receiptFile = process.env.SOCRATICODE_INSTALLATION_FILE ?? path.join(homedir(), ".local", "share", "socraticode", "installation.json");
    let receipt;
    try { receipt = JSON.parse(await readFile(receiptFile, "utf8")); } catch (receiptError) {
      if (receiptError.code !== "ENOENT") throw receiptError;
      throw new Error("SocratiCode is not prepared: install server dependencies and run setup.mjs from the unpacked plugin folder");
    }
    const localProfile = JSON.parse(await readFile(profileFile, "utf8"));
    if (!receipt || receipt.version !== localProfile.version || typeof receipt.serverRoot !== "string" || !path.isAbsolute(receipt.serverRoot) || typeof receipt.profileFile !== "string" || !path.isAbsolute(receipt.profileFile)) {
      throw new Error("SocratiCode installation does not match this plugin version; run setup.mjs again");
    }
    entry = pathToFileURL(path.join(receipt.serverRoot, "dist", "http-service.js"));
    profileFile = pathToFileURL(receipt.profileFile);
  }
}
const { ensureHttpService, readHttpServiceProfile } = await import(new URL("services/http-service.js", entry));
const profile = await readHttpServiceProfile(profileFile);
const { startupTrace } = await import(new URL("services/startup-trace.js", entry));
const emit = startupTrace(profile.env.SOCRATICODE_RUNTIME_DIR, profile.port, started);
emit("hook_start");

// Codex передаёт событие в stdin. При ручном запуске поток может оставаться открытым.
async function readSource() {
  if (process.stdin.isTTY) return "unknown";
  return new Promise((resolve) => {
    let input = "";
    function finish() {
      clearTimeout(timer);
      process.stdin.off("data", onData).off("end", finish).off("error", finish).pause();
      try {
        const { source } = JSON.parse(input);
        resolve(["startup", "resume", "clear", "compact"].includes(source) ? source : "unknown");
      } catch { resolve("unknown"); }
    }
    function onData(chunk) {
      input += chunk;
      if (input.length > 65536) { input = ""; finish(); }
    }
    const timer = setTimeout(finish, 150);
    process.stdin.setEncoding("utf8").on("data", onData).once("end", finish).once("error", finish);
  });
}
const source = readSource().then((name) => {
  emit("hook_event", { source: name });
  return name;
});
try {
  const outcome = await ensureHttpService(profile);
  emit("http_ready", { outcome, source: await source });
} catch (error) {
  emit("http_failed", { source: await source });
  throw error;
}
