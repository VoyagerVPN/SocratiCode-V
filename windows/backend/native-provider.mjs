import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const launcher = process.env.SCV_LAUNCHER;
let readiness;

export function resetNativeOllama() { readiness = undefined; }

export function ensureNativeOllama() {
  if (!launcher) return;
  // Первый реальный запрос будит общий процесс через оболочку Windows.
  readiness ??= exec(launcher, ["--ollama"], { windowsHide: true, timeout: 30_000, stdio: "pipe" })
    .catch(error => {
      resetNativeOllama();
      throw new Error("SocratiCode V не смог запустить Ollama", { cause: error });
    });
  return readiness;
}
