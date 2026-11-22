import { getProjectCatalog } from "../services/project-catalog.js";
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { QDRANT_HOST, QDRANT_MODE, QDRANT_PORT, QDRANT_URL, SOCRATICODE_VERSION } from "../constants.js";
import { isDockerAvailable, isQdrantImagePresent, isQdrantRunning } from "../services/docker.js";
import { getEmbeddingConfig } from "../services/embedding-config.js";
import { getEmbeddingProvider } from "../services/embedding-provider.js";
import { listCodebaseCollections } from "../services/qdrant.js";
import type { HealthStatus } from "../types.js";

export async function handleManageTool(
  name: string,
  _args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "codebase_health": {
      const config = getEmbeddingConfig();
      const status: HealthStatus = {
        docker: false,
        ollama: false,
        qdrant: false,
        ollamaModel: false,
        qdrantImage: false,
        ollamaImage: false,
      };

      const icon = (ok: boolean) => (ok ? "[OK]" : "[MISSING]");
      const lines: string[] = [
        "SocratiCode — Infrastructure Health Check:",
        "",
        `Qdrant mode: ${QDRANT_MODE}`,
      ];

      if (QDRANT_MODE === "external") {
        const endpoint = QDRANT_URL ?? `http://${QDRANT_HOST}:${QDRANT_PORT}`;
        lines.push(`Qdrant endpoint: ${endpoint}`);
        try {
          await listCodebaseCollections();
          status.qdrant = true;
          lines.push(`${icon(true)} External Qdrant (${endpoint}): Reachable`);
        } catch {
          lines.push(`${icon(false)} External Qdrant (${endpoint}): Unreachable — check QDRANT_URL / QDRANT_HOST`);
        }
      } else {
        // managed mode — Docker-managed container
        const docker = await isDockerAvailable();
        status.docker = docker;
        lines.push(`${icon(status.docker)} Docker: ${status.docker ? "Running" : "Not found — install from https://docker.com"}`);

        if (docker) {
          const [qdrantRunning, qdrantImage] = await Promise.all([
            isQdrantRunning(),
            isQdrantImagePresent(),
          ]);
          status.qdrant = qdrantRunning;
          status.qdrantImage = qdrantImage;

          lines.push(`${icon(status.qdrantImage)} Qdrant image: ${status.qdrantImage ? "Pulled" : "Not pulled — will be pulled on first index"}`);
          lines.push(`${icon(status.qdrant)} Qdrant container: ${status.qdrant ? "Running" : "Not running — will be started on first index"}`);
        }
      }

      // Embedding provider health check (works for ollama, openai, google)
      lines.push("");
      lines.push(`Embedding provider: ${config.embeddingProvider}`);
      try {
        const provider = await getEmbeddingProvider();
        const health = await provider.healthCheck();
        lines.push(...health.statusLines);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`${icon(false)} Embedding provider check failed: ${message}`);
      }

      lines.push("");
      if (QDRANT_MODE === "external") {
        lines.push("External Qdrant mode — Docker is not required for the vector database.");
      } else {
        lines.push(
          status.docker
            ? "Docker is available. Qdrant container will be auto-managed."
            : "Docker is required for Qdrant. Install from https://docker.com",
        );
      }

      return lines.join("\n");
    }

    case "codebase_list_projects": {
      try { return JSON.stringify(await getProjectCatalog(_args)); }
      catch (error) { return `Project catalog unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    }

    case "codebase_about": {
      return [
        "SocratiCode — Codebase intelligence MCP server",
        "Hybrid semantic + keyword search, dependency graphs, context artifacts.",
        "",
        "",
        "━━━ Quick Reference ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
        "Indexing:",
        "  codebase_index        — Index a project (background). Poll with codebase_status.",
        "  codebase_update       — Incremental re-index (changed files only).",
        "  codebase_stop         — Gracefully stop in-progress indexing.",
        "  codebase_remove       — Delete a project's index.",
        "  codebase_prune        — Inventory stored identities; delete one only with its confirmation token.",
        "  codebase_watch        — Start/stop/status of live file watcher.",
        "",
        "Search:",
        "  codebase_search       — Hybrid semantic + BM25 search over stored snapshots; budget and continuation.",
        "  codebase_status       — Check index status, progress, watcher state.",
        "",
        "Dependency Graph:",
        "  codebase_graph_build  — Build AST-based dependency graph (background).",
        "  codebase_graph_query  — Imports & dependents for a file.",
        "  codebase_graph_stats  — Graph stats: files, edges, most connected, orphans.",
        "  codebase_graph_circular — Find circular dependencies.",
        "  codebase_graph_visualize — Mermaid diagram (default) or interactive HTML explorer (mode=\"interactive\"), colour-coded by language.",
        "  codebase_graph_status — Poll graph build progress.",
        "  codebase_graph_remove — Delete a project's graph.",
        "  codebase_symbol       — Definition, callers and callees of a symbol.",
        "  codebase_symbols      — Paginated symbol lookup by file/name.",
        "  codebase_impact       — Transitive callers in the resolved graph.",
        "  codebase_flow         — Forward call flow or entry-point discovery.",
        "",
        "Context Artifacts:",
        "  codebase_context        — List artifacts (.socraticodecontextartifacts.json).",
        "  codebase_context_search — Search schemas, API specs, configs, docs.",
        "  codebase_context_index  — Re-index artifacts (usually automatic).",
        "  codebase_context_remove — Delete indexed artifacts.",
        "",
        "Management:",
        "  codebase_health       — Check Docker, Qdrant, embeddings status.",
        "  codebase_list_projects — Current project and indexed sources; scope=all for machine inventory.",
        "",
        "━━━ Typical Workflow ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
        "1. codebase_list_projects { projectPath } → inspect this index and its sources.",
        "2. codebase_search → ranked code in structuredContent.entries; maxChars bounds the response.",
        "3. codebase_graph_query for files; codebase_symbol / symbols / impact / flow for symbol relations.",
        "4. Index only a requested missing project/source. Search can use marked partial snapshots.",
        "",
        `v${SOCRATICODE_VERSION} · © 2026 Giancarlo Erra — Altaire Limited · AGPL-3.0`,
        "https://github.com/giancarloerra/socraticode",
      ].join("\n");
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
