import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".cache/vite",
  test: {
    // Вложенные временные проекты не должны наследовать Git основного репозитория.
    env: {
      GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES ?? os.tmpdir(),
      // Unit-тесты не используют supervisor и lease рабочего HTTP-сервера.
      SOCRATICODE_IDLE_STOP_TIMEOUT_MS: "off",
      SOCRATICODE_RUNTIME_DIR: path.resolve(".cache/vitest-runtime"),
    },
    // ESM support
    // Потоки не создают дочерние консольные процессы тестового пула.
    pool: "threads",

    // Test file patterns
    include: ["tests/**/*.test.ts"],

    // Longer timeouts for Docker-based integration tests
    testTimeout: 120_000,
    hookTimeout: 120_000,

    // Run tests sequentially (Docker resources and Qdrant collections are shared)
    sequence: {
      concurrent: false,
    },
    fileParallelism: false,

    // Coverage configuration
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"], // Entry point with stdio transport
    },
  },
});
