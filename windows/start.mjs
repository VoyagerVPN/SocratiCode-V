import { execFileSync } from "node:child_process";
import path from "node:path";

const exe = path.resolve(import.meta.dirname, "../runtime/bin/SocratiCodeV.exe");
execFileSync(exe, ["--open"], { windowsHide: true, stdio: "inherit" });
