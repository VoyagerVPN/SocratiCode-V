// Изолированный отказ файловой системы для публичных MCP-проверок.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const originalRead = fsp.readFile;
fsp.readFile = async function (file, ...args) {
  if (typeof file === "string" && path.basename(file) === "scan-failure.ts"
    && fs.existsSync(path.join(path.dirname(file), ".fail-scan"))) {
    const error = new Error("EACCES: deliberate fixture read failure");
    error.code = "EACCES";
    throw error;
  }
  return originalRead.call(this, file, ...args);
};
