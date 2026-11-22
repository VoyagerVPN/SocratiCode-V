#!/usr/bin/env node
import { ensureHttpService, readHttpServiceProfile } from "./services/http-service.js";

try {
  await ensureHttpService(await readHttpServiceProfile());
} catch (error: unknown) {
  process.stderr.write(`SocratiCode startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
