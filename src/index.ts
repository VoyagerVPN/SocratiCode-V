#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parentPort } from "node:worker_threads";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { EXTENSION_LANGUAGE_MAP_INVALID, getWatcherMode, SOCRATICODE_VERSION } from "./constants.js";
import { startAutomaticCleanup } from "./services/auto-cleanup.js";
import { resetOllamaContainerReadinessCache, resetQdrantReadinessCache } from "./services/docker.js";
import { closeIdleLifecycle, runWithIdleActivity, setIdleResumeHandler } from "./services/idle-lifecycle.js";
import { readIndexBudget, withIndexBudget } from "./services/index-budget.js";
import { logger, runWithMcpLogSender } from "./services/logger.js";
import { startMcpHttp } from "./services/mcp-http.js";
import { getProjectCatalog, projectCatalogSchema } from "./services/project-catalog.js";
import { resetOllamaReadinessCache } from "./services/provider-ollama.js";
import { pageResultSchema } from "./services/result-pages.js";
import { searchPageSchema } from "./services/search-pages.js";
import { autoResumeIndexedProjects, gracefulShutdown } from "./services/startup.js";
import { traceSearch } from "./services/startup-trace.js";
import { readTextPage, textPageInputs } from "./services/text-pages.js";
import { handleContextTool } from "./tools/context-tools.js";
import { handleGraphListTool, handleGraphTool } from "./tools/graph-tools.js";
import { handleIndexTool } from "./tools/index-tools.js";
import { handleManageTool } from "./tools/manage-tools.js";
import { handleQueryTool, handleSearchTool } from "./tools/query-tools.js";

// Validate lifecycle configuration before the server accepts any tools. An
// invalid manual-mode value must never fall back to automatic index writes.
getWatcherMode();
setIdleResumeHandler(() => {
  resetQdrantReadinessCache();
  resetOllamaContainerReadinessCache();
  resetOllamaReadinessCache();
});

function runRequest<T>(context: ServerContext, operation: () => Promise<T>): Promise<T> {
  return runWithMcpLogSender((params) => {
    void context.mcpReq.log(params.level, params.data, params.logger).catch(() => {});
  }, () => runWithIdleActivity(operation));
}

// Общий HTTP-процесс не знает рабочую папку конкретного чата.
function projectPathSchema(description: string): z.ZodString | z.ZodOptional<z.ZodString> {
  const schema = z.string().min(1).describe(process.env.SOCRATICODE_MCP_TRANSPORT === "http"
    ? "Absolute path to the actual project/workspace root. Required for shared HTTP."
    : description);
  return process.env.SOCRATICODE_MCP_TRANSPORT === "http" ? schema : schema.optional();
}

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "socraticode",
      version: process.env.SOCRATICODE_MCP_VERSION ?? SOCRATICODE_VERSION,
    },
    {
      capabilities: {
        tools: {},
        // Логи доступны через контекст запроса при указанном клиентом logLevel.
        logging: {},
      },
    },
  );

  // ── Index tools ──────────────────────────────────────────────────────────

  const impactInput = z.object({
    ...textPageInputs,
    projectPath: projectPathSchema("Absolute path to the project directory."),
    target: z.string().trim().min(1).describe("Target file path (relative) OR symbol name.").optional(),
    file: z.string().describe("Optional file path to disambiguate the target symbol.").optional(),
    symbolId: z.string().trim().min(1).describe("Exact symbol ID to disambiguate the target.").optional(),
    depth: z.number().describe("How many hops back to walk (default 3, max 10).").optional(),
    limit: z.number().int().min(1).describe("Maximum candidates to list when the target symbol is ambiguous. Omit to list all.").optional(),
  });

  server.registerTool(
    "codebase_index",
    {
      description:
        "Start indexing a codebase in the background. Returns immediately. Wait for the operation to complete, including graph/artifact phases, using codebase_status. Partial snapshots remain searchable with coverage warnings. If already indexing, returns current progress.",
      inputSchema: z.object({
        parentPath: z
          .string()
          .optional()
          .describe(
            "Attach this indexed directory as a source of the parent project in the same call. Stored in the parent's .socraticode.json linkedProjects.",
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "Read-only chunk/byte preview after ignore rules using the requested profile. Stops scanning at the budget and reports complete=false with lower-bound counts. Does not start services, index or attach. Available during indexing.",
          ),
        maxFiles: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Maximum indexable files accepted by this request. Default 2000 (SOCRATICODE_INDEX_MAX_FILES). Prefer a relevant subdirectory for large repositories.",
          ),
        maxChunks: z.number().int().positive().optional().describe("Maximum planned chunks. Default 20000 (SOCRATICODE_INDEX_MAX_CHUNKS)."),
        maxBytes: z.number().int().positive().optional().describe("Maximum UTF-8 bytes of planned chunk text. Default 33554432 (SOCRATICODE_INDEX_MAX_BYTES)."),
        projectPath: projectPathSchema("Absolute path to the project directory. If omitted, uses the current working directory."),
        extraExtensions: z
          .string()
          .describe(
            "Comma-separated list of additional file extensions to index beyond the built-in set (e.g. '.tpl,.blade,.hbs'). Useful for projects with non-standard file extensions. Can also be set globally via EXTRA_EXTENSIONS env var.",
          )
          .optional(),
      }),
    },
    async (args, context) => {
      const text = await runRequest(context, () => withIndexBudget(readIndexBudget(args), () => handleIndexTool("codebase_index", args)));
      return {
        content: [{ type: "text", text }],
        ...(/^(Index limit exceeded|Cannot index|Source attachment failed|Infrastructure setup failed|❌)/.test(text)
          ? { isError: true }
          : {}),
      };
    },
  );

  server.registerTool(
    "codebase_update",
    {
      description:
        "Incrementally update an existing codebase index. Only re-indexes changed files. Runs synchronously. Use it to refresh a manual/off snapshot, working-tree edits before the next Git transition in git mode, or whenever an immediate catch-up is needed.",
      inputSchema: z.object({
        maxFiles: z.number().int().positive().optional().describe("Maximum discovered files. Default 2000."),
        maxChunks: z.number().int().positive().optional().describe("Maximum changed chunks. Default 20000."),
        maxBytes: z.number().int().positive().optional().describe("Maximum UTF-8 bytes of changed chunks. Default 33554432."),
        projectPath: projectPathSchema("Absolute path to the project directory."),
        extraExtensions: z
          .string()
          .describe("Comma-separated list of additional file extensions to index (e.g. '.tpl,.blade').")
          .optional(),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => withIndexBudget(readIndexBudget(args), () => handleIndexTool("codebase_update", args))),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_remove",
    {
      description:
        "Remove a project's codebase index entirely from the vector database. Safely stops the file watcher, cancels any in-progress indexing/update (with drain), and waits for any in-flight graph build before deleting.",
      inputSchema: z.object({
        projectPath: z.string().describe("Absolute path to the project directory."),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleIndexTool("codebase_remove", args)),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_prune",
    {
      description:
        "Inventory stored project identities and their resources. Report-only by default. Applying requires an exact identity, the confirmation token from a fresh inventory, and an acknowledgement that no other host is writing to it; path absence on this host is advisory, not proof of abandonment.",
      inputSchema: z.object({
        apply: z
          .boolean()
          .optional()
          .describe("Delete the selected identity only when true. Omit for the report-only inventory."),
        identity: z.string().optional().describe("Exact identity returned by codebase_prune."),
        confirmationToken: z.string().optional().describe("Opaque token returned for that identity by codebase_prune."),
        acknowledgeNoRemoteWriters: z
          .boolean()
          .optional()
          .describe(
            "Required with apply. Locks on this host cannot see another host sharing the same Qdrant; true states that none is writing to this identity.",
          ),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleIndexTool("codebase_prune", args)),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_stop",
    {
      description:
        "Stop an indexing operation after its in-flight embedding packet. Earlier file-batch checkpoints are preserved; the unfinished batch is retried on resume.",
      inputSchema: z.object({
        projectPath: projectPathSchema("Absolute path to the project directory. If omitted, uses the current working directory."),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleIndexTool("codebase_stop", args)),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_watch",
    {
      description:
        "Start/stop watching a project directory for file changes and automatically update the index. When starting, first runs an incremental update to catch up, then watches for changes. SOCRATICODE_WATCHER=manual allows explicit starts only; off and git reject file-watcher starts. In git mode, status reports Git refresh state and stop does not disable Git checks.",
      inputSchema: z.object({
        projectPath: projectPathSchema("Absolute path to the project directory."),
        action: z.enum(["start", "stop", "status"]).describe("start/stop watching, or get status of watchers."),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleIndexTool("codebase_watch", args)),
        },
      ],
    }),
  );

  // ── Query tools ──────────────────────────────────────────────────────────

  server.registerTool(
    "codebase_search",
    {
      description:
        "Hybrid search. Compact text shares identical overlapping lines by rank on each page; format=json preserves full records. Result order and scores are preserved. For multiple sources, [n] refers to searchedSources[n-1]. Coverage and nextCursor in structuredContent; partial snapshots are marked.",
      outputSchema: searchPageSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        query: z
          .string()
          .describe("Natural language search query (e.g. 'authentication middleware', 'database connection setup')."),
        projectPath: projectPathSchema("Absolute path to the project directory."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .describe(
            "Ranked candidate window, 1–50. Default 10 (SEARCH_DEFAULT_LIMIT). total and continuation cover this selected window, not all indexed matches.",
          )
          .optional(),
        format: z.enum(["compact", "json"]).optional().describe("Compact text with line references by default; json for full records. Records appear once. Can change between pages."),
        maxChars: z.number().int().min(512).max(100000).optional().describe("Budget for the entire MCP result in JSON characters. Default 12000. Whole code chunks and source coverage are preserved."),
        cursor: z.string().max(2048).optional().describe("nextCursor from this shared server. Repeat query, projectPath, limit and filters; maxChars may change. Snapshot expires after five minutes or server restart."),
        fileFilter: z.string().describe("Filter results to one exact relative file path, as shown in a result header (e.g. src/index.ts). Directories, globs, lists and bare names below the root match nothing.").optional(),
        languageFilter: z
          .string()
          .describe("Filter results to one exact language label shown in a result header (e.g. typescript, python, go). Aliases such as ts or py match nothing.")
          .optional(),
        minScore: z
          .number()
          .min(0)
          .max(1)
          .describe(
            "Minimum score in the existing ranking mode (hybrid RRF, cross-source cosine or fallback rank fusion), not confidence. Default 0.10 (SEARCH_MIN_SCORE). Set 0 to disable filtering.",
          )
          .optional(),
        includeLinked: z
          .boolean()
          .describe("Compatibility alias: false selects main scope, true selects project scope. Prefer scope.")
          .optional(),
        scope: z
          .enum(["project", "main", "sources"])
          .optional()
          .describe(
            "Default project: main code plus explicitly linked sources and existing nested indexes. main searches only this index; sources searches only its sources. Never indexes missing sources.",
          ),
      }),
    },
    async (args, context) => {
      const result = await traceSearch(() => runRequest(context, () => handleSearchTool(args)));
      return { content: [{ type: "text", text: result.text }],
        isError: result.isError, structuredContent: result.structuredContent };
    },
  );

  server.registerTool(
    "codebase_status",
    {
      description:
        "Check index, operation and graph state. Wait for completed, not only 100% of embeddings. Cancelled and failed operations are distinct.",
      inputSchema: z.object({
        projectPath: projectPathSchema("Absolute path to the project directory."),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleQueryTool("codebase_status", args)),
        },
      ],
    }),
  );

  // ── Graph tools ──────────────────────────────────────────────────────────

  server.registerTool(
    "codebase_graph_build",
    {
      description:
        "Build a dependency graph of the codebase using static analysis (ast-grep). Maps import/require/export relationships between files. Runs in the background — call codebase_graph_status to poll progress until complete.",
      inputSchema: z.object({
        projectPath: projectPathSchema("Absolute path to the project directory."),
        extraExtensions: z
          .string()
          .describe(
            "Comma-separated list of additional file extensions to include in the graph (e.g. '.tpl,.blade'). Files with non-standard extensions are included as leaf nodes (dependency targets). Can also be set globally via EXTRA_EXTENSIONS env var.",
          )
          .optional(),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleGraphTool("codebase_graph_build", args)),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_graph_query",
    {
      description:
        "File dependency picture: → imports, ← dependents. Compact text by default; format=json for typed records. Pagination/coverage in structuredContent. Continue with unchanged project/file filters. May refresh in automatic mode.",
      outputSchema: pageResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        projectPath: projectPathSchema("Absolute path to the project directory."),
        filePath: z.string().describe("Relative path of the file to query (e.g. 'src/index.ts')."),
        format: z.enum(["compact", "json"]).optional().describe("Compact text by default; json for typed records. Records appear once. Can change between pages."),
        limit: z.number().int().min(1).max(1000).describe("Maximum records per page (default 200).").optional(),
        cursor: z.string().max(2048).describe("nextCursor from the previous page; keep project and filters unchanged.").optional(),
        maxChars: z.number().int().min(512).max(100000).describe("Serialized MCP result budget in characters, including text and structured data (default 12000; not a token count).").optional(),
      }),
    },
    async (args, context) => {
      const result = await runRequest(context, () => handleGraphListTool("codebase_graph_query", args));
      return { content: [{ type: "text" as const, text: result.text }], structuredContent: result.structuredContent, isError: result.isError };
    },
  );
  server.registerTool(
    "codebase_graph_stats",
    {
      description:
        "Get statistics about the code dependency graph: total files, edges, most connected files, orphan files, circular dependencies.",
      inputSchema: z.object({
        projectPath: projectPathSchema("Absolute path to the project directory."),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleGraphTool("codebase_graph_stats", args)),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_graph_circular",
    {
      description: "Find circular dependencies in the codebase.",
      inputSchema: z.object({
        projectPath: projectPathSchema("Absolute path to the project directory."),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleGraphTool("codebase_graph_circular", args)),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_graph_visualize",
    {
      description: [
        "Visualise the code dependency graph. Two modes:",
        '  • mode="mermaid" (default) — returns a Mermaid diagram (text) colour-coded by language, circular deps highlighted. Best for inline rendering inside chat, GitHub, or editors that render Mermaid.',
        '  • mode="interactive" — writes a self-contained HTML page (vendored Cytoscape.js + Dagre, works offline) and opens it in the user\'s default browser. Shows the file graph and, when a symbol graph is available and fits, a Symbols toggle with the symbol-level call graph. Interactions: click node for sidebar with imports/dependents/symbols list; right-click node to highlight its blast radius (reverse-transitive closure); live search; layout switcher (Dagre / force / concentric / breadth-first / grid / circle); PNG export. Use this when the user asks for a visual/interactive view, wants to explore visually, or needs a shareable diagram.',
      ].join("\n"),
      inputSchema: z.object({
        projectPath: projectPathSchema("Absolute path to the project directory."),
        mode: z
          .enum(["mermaid", "interactive"])
          .describe('"mermaid" (default — text diagram) or "interactive" (browser-based explorer).')
          .optional(),
        open: z
          .boolean()
          .describe(
            "In interactive mode, whether to auto-open the browser. Default true. Set false to just get the file path (useful in headless environments).",
          )
          .optional(),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleGraphTool("codebase_graph_visualize", args)),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_graph_remove",
    {
      description:
        "Remove a project's persisted code graph. Waits for any in-flight graph build to finish first. The graph can be rebuilt with codebase_graph_build or will be rebuilt automatically on the next codebase_index.",
      inputSchema: z.object({
        projectPath: z.string().describe("Absolute path to the project directory."),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleGraphTool("codebase_graph_remove", args)),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_graph_status",
    {
      description:
        "Check the status of the code dependency graph: build progress (if building), node/edge count, when it was last built, whether it's cached in memory. Use this to poll progress after calling codebase_graph_build.",
      inputSchema: z.object({
        projectPath: projectPathSchema("Absolute path to the project directory."),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleGraphTool("codebase_graph_status", args)),
        },
      ],
    }),
  );

  // ── Impact analysis (symbol-level call graph) ───────────────────────────

  server.registerTool(
    "codebase_impact",
    {
      description:
        "Impact Analysis — return the BLAST RADIUS for a file or symbol. Lists every file (and, where helpful, function) that could break if you change the target. Polymorphic on target: a path-like string ('src/foo.ts') triggers file-mode; a name-like string ('validateUser') triggers symbol-mode. Use this BEFORE refactoring, renaming, or deleting code to know what depends on it.",
      inputSchema: z.union([
        impactInput.extend({ target: impactInput.shape.target.unwrap() }),
        impactInput.extend({ symbolId: impactInput.shape.symbolId.unwrap() }),
      ]),
    },
    async (args, context) => readTextPage("codebase_impact", args, () =>
      runRequest(context, () => handleGraphTool("codebase_impact", args))),
  );

  server.registerTool(
    "codebase_flow",
    {
      description:
        "Trace the EXECUTION FLOW forward from an entry point — what does this code call into? With NO args, returns a ranked list of auto-detected entry points (orphans with outgoing calls, conventional names like main(), framework routes, tests). With an entrypoint argument, returns the call tree.",
      inputSchema: z.object({
        ...textPageInputs,
        projectPath: projectPathSchema("Absolute path to the project directory."),
        entrypoint: z
          .string()
          .describe("Symbol name to trace from. Omit to list auto-detected entry points.")
          .optional(),
        file: z.string().describe("Optional file hint to disambiguate the symbol.").optional(),
        depth: z.number().describe("Maximum DFS depth (default 5, max 10).").optional(),
        limit: z.number().int().min(1).describe("Maximum candidates to list when the entrypoint is ambiguous. Omit to list all.").optional(),
      }),
    },
    async (args, context) => readTextPage("codebase_flow", args, () =>
      runRequest(context, () => handleGraphTool("codebase_flow", args))),
  );

  server.registerTool(
    "codebase_symbol",
    {
      description:
        "360° view of a symbol: definition, kind, callers, callees, confidence levels. Use to understand a function or class before changing it.",
      inputSchema: z.object({
        projectPath: projectPathSchema("Absolute path to the project directory."),
        name: z.string().describe("Symbol name (e.g. 'validateUser')."),
        file: z.string().describe("Optional file hint to disambiguate when the name is not unique.").optional(),
        limit: z.number().int().min(1).describe("Maximum definitions to resolve when the name is not unique. Omit to resolve all.").optional(),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleGraphTool("codebase_symbol", args)),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_symbols",
    {
      description:
        "Symbols grouped by file in compact text by default. Each row gives kind, id suffix and line range; exact symbolId = file + :: + suffix. format=json for full records. Page controls/coverage in structuredContent. Use codebase_symbol for details. With file, query is ignored.",
      outputSchema: pageResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        projectPath: projectPathSchema("Absolute path to the project directory."),
        file: z.string().describe("Relative file path — list all symbols in this file.").optional(),
        query: z.string().describe("Substring to match against symbol names project-wide.").optional(),
        format: z.enum(["compact", "json"]).optional().describe("Compact text by default; json for typed records. Records appear once. Can change between pages."),
        limit: z.number().int().min(1).max(1000).describe("Maximum records per page (default 200).").optional(),
        cursor: z.string().max(2048).describe("nextCursor from the previous page; keep project and filters unchanged.").optional(),
        maxChars: z.number().int().min(512).max(100000).describe("Serialized MCP result budget in characters, including text and structured data (default 12000; not a token count).").optional(),
      }),
    },
    async (args, context) => {
      const result = await runRequest(context, () => handleGraphListTool("codebase_symbols", args));
      return { content: [{ type: "text" as const, text: result.text }], structuredContent: result.structuredContent, isError: result.isError };
    },
  );
  // ── Context artifact tools ───────────────────────────────────────────────

  server.registerTool(
    "codebase_context",
    {
      description:
        "List all context artifacts defined in .socraticodecontextartifacts.json — database schemas, API specs, infra configs, architecture docs, etc. Shows each artifact's name, description, path, and index status. Use this to discover what project knowledge is available beyond source code.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        help: z.boolean().optional().describe("Show setup instructions explicitly. Default false; an empty artifact list stays concise."),
        projectPath: projectPathSchema("Absolute path to the project directory. If omitted, uses the current working directory."),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleContextTool("codebase_context", args)),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_context_search",
    {
      description:
        "Semantic search across context artifacts (database schemas, API specs, infra configs, etc.) defined in .socraticodecontextartifacts.json. Auto-indexes on first use and auto-detects stale artifacts. Use this to find relevant infrastructure or domain knowledge.",
      inputSchema: z.object({
        ...textPageInputs,
        query: z
          .string()
          .describe(
            "Natural language search query (e.g. 'tables related to billing', 'authentication endpoints', 'deployment resource limits').",
          ),
        projectPath: projectPathSchema("Absolute path to the project directory."),
        artifactName: z
          .string()
          .describe(
            "Filter search to a specific artifact by name (e.g. 'database-schema'). Omit to search across all artifacts.",
          )
          .optional(),
        limit: z.number().min(1).max(50).describe("Maximum number of results to return. Default: 10.").optional(),
        minScore: z
          .number()
          .min(0)
          .max(1)
          .describe(
            "Minimum RRF score threshold (0-1). Results below this are filtered out. Default: 0.10 (override globally via SEARCH_MIN_SCORE env var). Set to 0 to disable filtering.",
          )
          .optional(),
      }),
    },
    async (args, context) => readTextPage("codebase_context_search", args, () =>
      runRequest(context, () => handleContextTool("codebase_context_search", args))),
  );

  server.registerTool(
    "codebase_context_index",
    {
      description:
        "Index or re-index all context artifacts defined in .socraticodecontextartifacts.json. Chunks and embeds artifact content into the vector database for semantic search. Usually not needed — codebase_context_search auto-indexes on first use.",
      inputSchema: z.object({
        projectPath: projectPathSchema("Absolute path to the project directory."),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleContextTool("codebase_context_index", args)),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_context_remove",
    {
      description:
        "Remove all indexed context artifacts for a project from the vector database. Blocked while indexing is in progress — use codebase_stop or wait for the operation to finish first.",
      inputSchema: z.object({
        projectPath: z.string().describe("Absolute path to the project directory."),
      }),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleContextTool("codebase_context_remove", args)),
        },
      ],
    }),
  );

  // ── Management tools ─────────────────────────────────────────────────────

  server.registerTool(
    "codebase_health",
    {
      description:
        "Check the health of all infrastructure: Docker, Qdrant container, Ollama, and embedding model. Use this to diagnose setup issues.",
      inputSchema: z.object({}),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleManageTool("codebase_health", args)),
        },
      ],
    }),
  );

  server.registerTool(
    "codebase_list_projects",
    {
      description:
        "Discover the current project index and its sources. Defaults to project scope, never indexes candidates. Use scope=all only for a machine-wide inventory. Read index and graph state before searching; legacy or incomplete indexes require attention.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe("Actual project/workspace root. Required for project scope on shared HTTP.")
          .optional(),
        scope: z.enum(["project", "all"]).default("project"),
        limit: z.number().int().min(1).max(100).default(20).describe("Page size for scope=all."),
        cursor: z.string().optional().describe("nextCursor from a previous scope=all response."),
      }),
      outputSchema: projectCatalogSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, context) => {
      try {
        if (process.env.SOCRATICODE_MCP_TRANSPORT === "http" && args.scope !== "all" && !args.projectPath) {
          throw new Error("projectPath is required for project scope on shared HTTP; use scope=all for the machine inventory");
        }
        const catalog = await runRequest(context, () => getProjectCatalog(args));
        return {
          content: [{ type: "text", text: catalog.scope === "all"
            ? "Projects: " + (catalog.projects?.length ?? 0) + "/" + catalog.total + (catalog.nextCursor ? "; more: nextCursor." : ".")
            : "Project index: " + (catalog.project?.index ?? "missing") + "; sources: " + catalog.sources.length + "." }],
          structuredContent: { ...catalog },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Project catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "codebase_about",
    {
      description:
        "Display information about SocratiCode — what it is, its tools and how to use it. Use this to get a quick overview of the MCP tools and their purpose.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: z.object({}),
    },
    async (args, context) => ({
      content: [
        {
          type: "text",
          text: await runRequest(context, () => handleManageTool("codebase_about", args)),
        },
      ],
    }),
  );

  return server;
}

// ── Start server ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Только современный протокол: прежний initialize отклоняется самим SDK.
  const mode = process.env.SOCRATICODE_MCP_TRANSPORT ?? "stdio";
  if (mode !== "stdio" && mode !== "http") throw new Error("SOCRATICODE_MCP_TRANSPORT must be stdio or http");
  const port = Number(process.env.SOCRATICODE_MCP_PORT ?? "16335");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("SOCRATICODE_MCP_PORT must be between 0 and 65535");
  const connection = mode === "http" ? await startMcpHttp(createServer, port) : serveStdio(createServer, { legacy: "reject" });
  if (mode === "http" && "url" in connection) {
    process.stdout.write(`${JSON.stringify({ type: "socraticode/http-ready", url: connection.url })}\n`);
  }

  // Surface any EXTENSION_LANGUAGE_MAP entries we had to drop (malformed, or a
  // target language with no AST grammar) rather than silently ignoring them.
  if (EXTENSION_LANGUAGE_MAP_INVALID.length > 0) {
    logger.warn(
      "EXTENSION_LANGUAGE_MAP: ignored invalid entries. Each must be `<ext>:<language>` " +
        "with a language SocratiCode has an AST grammar for (e.g. .inc:php).",
      { ignored: EXTENSION_LANGUAGE_MAP_INVALID },
    );
  }

  // Auto-resume watchers and incremental updates for already-indexed projects
  // Fire-and-forget — runs in background, non-blocking, non-fatal
  void runWithIdleActivity(() => autoResumeIndexedProjects()).catch((error: unknown) => {
    logger.error("Startup resume failed", { error: String(error) });
  });
  startAutomaticCleanup();

  // ── Process-level error handlers ─────────────────────────────────────

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", {
      error: err.message,
      stack: err.stack,
    });
    // Uncaught exceptions leave the process in an undefined state — exit
    process.exit(1);
  });

  // ── Graceful shutdown ────────────────────────────────────────────────

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // prevent double shutdown
    shuttingDown = true;
    await gracefulShutdown(signal, () => connection.close());
    await closeIdleLifecycle();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  parentPort?.on("message", (message: unknown) => {
    if (message === "shutdown") void shutdown("launcher shutdown");
  });

  // ── Stdin pipe-break detection ─────────────────────────────────────────
  // When the MCP host (e.g. Cline/VS Code) closes its side of the stdio pipe,
  // Node.js may emit 'end', 'error', or 'close' on stdin depending on how
  // abruptly the pipe was severed. A clean close emits 'end'; an abrupt
  // break (e.g. heavy I/O during indexing) may skip 'end' and only emit
  // 'error' + 'close'. Listen for all three to catch every scenario.
  // The shuttingDown guard in shutdown() prevents double-shutdown.
  if (mode === "stdio") {
    process.stdin.on("end", () => shutdown("stdin EOF"));
    process.stdin.on("error", () => shutdown("stdin error"));
    process.stdin.on("close", () => shutdown("stdin close"));
  }
  // Log lines go to stdout as notifications/message. Once the host has closed
  // its end, that write fails with EPIPE; unhandled, the error would exit the
  // process in the middle of shutdown instead of letting it finish.
  process.stdout.on("error", () => shutdown("stdout error"));
}

if (parentPort || (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url)) main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
