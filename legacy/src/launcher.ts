#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { Worker } from "node:worker_threads";
import { readHttpServiceProfile } from "./services/http-service.js";

if (process.argv.includes("--http")) {
  const profile = await readHttpServiceProfile();
  Object.assign(process.env, profile.env, {
    SOCRATICODE_MCP_TRANSPORT: "http", SOCRATICODE_MCP_PORT: String(profile.port), SOCRATICODE_MCP_VERSION: profile.version,
  });
}

// Большие исходники требуют большего стека нативного AST-парсера на Windows.
const worker = new Worker(new URL("./index.js", import.meta.url), {
  stdin: true,
  stdout: true,
  stderr: true,
  resourceLimits: { stackSizeMb: 16 },
});
const workerInput = worker.stdin;
if (!workerInput) throw new Error("SocratiCode worker stdin is unavailable");
const input = workerInput;
if (process.env.SOCRATICODE_MCP_TRANSPORT !== "http") process.stdin.pipe(input);
worker.stdout.pipe(process.stdout);
worker.stderr.pipe(process.stderr);
let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  if (process.env.SOCRATICODE_MCP_TRANSPORT === "http") worker.postMessage("shutdown");
  else input.end();
  const deadline = setTimeout(() => { void worker.terminate(); }, 35_000);
  deadline.unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("message", (message: unknown) => {
  if (message === "shutdown") shutdown();
});
process.stdin.on("error", shutdown);
process.stdout.on("error", shutdown);
worker.on("error", (error: Error) => {
  process.stderr.write(`SocratiCode worker failed: ${error.message}\n`);
  process.exit(1);
});
// Родитель не оставляет lease с живым PID после аварии или закрытия Worker.
worker.on("exit", (code: number) => process.exit(code));
