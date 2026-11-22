// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import path from "node:path";
import { collectionName, projectIdFromPath } from "../config.js";
import type { WatcherMode } from "../constants.js";
import { getWatcherMode, SEARCH_DEFAULT_LIMIT, SEARCH_MIN_SCORE, SOCRATICODE_VERSION } from "../constants.js";
import { getGraphStatus, isGraphBuilderStale } from "../services/code-graph.js";
import { getArtifactStatusSummary } from "../services/context-artifacts.js";
import { ensureQdrantReady } from "../services/docker.js";
import { withGitRefreshNotice } from "../services/git-refresh.js";
import {
  indexProfileDifferences,
  requestedIndexProfile,
  resolveEffectiveIndexProfile,
} from "../services/index-profile.js";
import type { IndexingProgress } from "../services/indexer.js";
import { getIndexingProgress, getLastCompleted, isIndexingInProgress } from "../services/indexer.js";
import { getLockHolderPid } from "../services/lock.js";
import { getProjectCatalog } from "../services/project-catalog.js";
import {
  getCollectionInfo,
  getProjectMetadata,
  loadProjectEffectiveProfile,
  searchChunks,
  searchMultipleCollections,
} from "../services/qdrant.js";
import { continueSearchPage, createSearchPage, type SearchToolResponse } from "../services/search-pages.js";
import { searchStage } from "../services/startup-trace.js";
import { ensureWatcherStarted, isWatchedByAnyProcess, isWatching } from "../services/watcher.js";
import type { SearchResult } from "../types.js";

export type { SearchToolResponse } from "../services/search-pages.js";

interface SearchQueryResponse {
  text: string;
  isError: boolean;
  structuredContent: {
    status: "ok" | "empty" | "partial" | "failed" | "index_missing";
    partial: boolean;
    searchedSources: string[];
    failedSources: Array<{ path: string; error: string }>;
    skippedSources: string[];
    incompleteSources: string[];
    results: SearchResult[];
    filteredCount: number;
    warnings: string[];
  };
}

/** MCP получает явное покрытие поиска вместе с текстовой выдачей. */
export async function handleSearchTool(args: Record<string, unknown>): Promise<SearchToolResponse> {
  const projectPath = typeof args.projectPath === "string" ? args.projectPath : process.cwd();
  const resolvedArgs = { ...args, projectPath: path.resolve(projectPath) };
  if (args.cursor !== undefined) return continueSearchPage(resolvedArgs);
  let response: SearchQueryResponse | undefined;
  const text = await withGitRefreshNotice(projectPath, async () => {
    const result = await dispatchQueryTool("codebase_search", args);
    if (typeof result === "string") throw new Error("Search response was not produced");
    response = result;
    return result.text;
  });
  if (!response) throw new Error("Search response was not produced");
  const notices = text === response.text ? [] : [text.replace(response.text, "").trim()];
  const { results, filteredCount, warnings, ...selection } = response.structuredContent;
  return createSearchPage(resolvedArgs, results, selection, [...warnings, ...notices], filteredCount);
}

/** Format an IndexingProgress into display lines (elapsed, progress, batches, graph). */
function formatProgressLines(progress: IndexingProgress): {
  elapsed: string;
  pct: string;
  progressLine: string;
  batchLine: string | undefined;
  graphLine: string;
} {
  const elapsed = ((Date.now() - progress.startedAt) / 1000).toFixed(0);

  const pct = progress.filesTotal > 0
    ? ` (${Math.round((progress.filesProcessed / progress.filesTotal) * 100)}%)`
    : "";

  const progressLine = (progress.chunksTotal && progress.chunksTotal > 0)
    ? `  Progress: ${progress.chunksProcessed ?? 0}/${progress.chunksTotal} chunks embedded (${Math.round(((progress.chunksProcessed ?? 0) / progress.chunksTotal) * 100)}%)`
    : `  Progress: ${progress.filesProcessed}/${progress.filesTotal} files${pct}`;

  const batchLine = (progress.batchesTotal && progress.batchesTotal > 1)
    ? `  Batches: ${progress.batchesProcessed ?? 0}/${progress.batchesTotal} completed (${progress.filesProcessed}/${progress.filesTotal} files)`
    : undefined;

  const graphLine = progress.phase === "building code graph"
    ? "Code graph: building now..."
    : "Code graph: pending — will be auto-built after indexing completes";

  return { elapsed, pct, progressLine, batchLine, graphLine };
}

/** Append the current watcher policy and activity state to a tool response. */
async function appendWatcherState(
  lines: string[],
  resolvedPath: string,
  watcherMode: WatcherMode,
  context: "search" | "status",
): Promise<void> {
  const watchedHere = isWatching(resolvedPath);
  const watchedAnywhere = watchedHere || await isWatchedByAnyProcess(resolvedPath);
  const watcherLines: string[] = [];

  if (watcherMode === "git") {
    watcherLines.push("File watcher: disabled (SOCRATICODE_WATCHER=git; refresh is triggered by ref/HEAD changes)");
    if (watchedAnywhere) watcherLines.push("Warning: an active file watcher in another configuration may still update this shared index.");
  } else if (context === "search") {
    if (watcherMode === "off") {
      if (watchedHere) {
        watcherLines.push("⚠ WARNING: File watching is disabled in this process, but this process still has an active watcher.");
        watcherLines.push("  Restart the MCP server to apply the changed environment setting.");
      } else if (watchedAnywhere) {
        watcherLines.push("⚠ WARNING: File watching is disabled in this process, but another active watcher can still update the shared index.");
        watcherLines.push("  Set SOCRATICODE_WATCHER=off for every MCP process that uses this checkout.");
      } else {
        watcherLines.push("ℹ INDEX SNAPSHOT: File watching is disabled by SOCRATICODE_WATCHER=off.");
        watcherLines.push("  Results reflect the last explicit codebase_index or codebase_update.");
      }
    } else if (watcherMode === "manual") {
      if (!watchedAnywhere) {
        watcherLines.push("ℹ INDEX SNAPSHOT: Automatic file watching is disabled by SOCRATICODE_WATCHER=manual.");
        watcherLines.push("  Run codebase_update to refresh, or start the watcher explicitly with codebase_watch.");
      } else if (!watchedHere) {
        watcherLines.push("ℹ NOTE: Another MCP process is watching this project, so the shared index may still update automatically.");
      }
    } else if (!watchedAnywhere) {
      watcherLines.push("⚠ WARNING: File watcher is not yet active for this project. Results may be stale.");
      watcherLines.push("  The watcher is being started automatically. Run codebase_update to force an immediate catch-up.");
    }
  } else if (watcherMode === "off") {
    watcherLines.push("File watcher: disabled (SOCRATICODE_WATCHER=off)");
    if (watchedHere) {
      watcherLines.push("  Warning: this process still has an active watcher. Restart the MCP server to apply the changed environment setting.");
    } else if (watchedAnywhere) {
      watcherLines.push("  Warning: another MCP process is watching this project. Set SOCRATICODE_WATCHER=off for every process that uses this checkout.");
    }
  } else if (watchedHere) {
    watcherLines.push(watcherMode === "manual"
      ? "File watcher: active (started explicitly; SOCRATICODE_WATCHER=manual)"
      : "File watcher: active (auto-updating on changes)");
  } else if (watchedAnywhere) {
    watcherLines.push(watcherMode === "manual"
      ? "File watcher: active (watched by another process; automatic startup disabled here)"
      : "File watcher: active (watched by another process)");
  } else {
    watcherLines.push(watcherMode === "manual"
      ? "File watcher: inactive (SOCRATICODE_WATCHER=manual; start explicitly or run codebase_update to refresh)"
      : "File watcher: inactive");
  }

  if (watcherLines.length > 0) {
    lines.push("", ...watcherLines);
  }
}

/** Пустой поиск поясняет точные фильтры с учётом реально выбранных источников. */
async function filteredNoResultsLines(
  query: string,
  resolvedPath: string,
  collection: string,
  fileFilter: string | undefined,
  languageFilter: string | undefined,
  singleSource: boolean,
): Promise<string[]> {
  const indexing = isIndexingInProgress(resolvedPath);
  if (singleSource && !indexing && (await getCollectionInfo(collection))?.pointsCount === 0) {
    return [
      `No results found for "${query}" in project ${resolvedPath}.`,
      "Make sure the project has been indexed first using codebase_index.",
    ];
  }
  const filters: string[] = [];
  const hints: string[] = [];
  if (fileFilter) {
    filters.push(`fileFilter "${fileFilter}"`);
    hints.push("fileFilter takes one file path exactly as a result header shows it (e.g. src/index.ts); directories, globs, lists and bare names of files below the root match nothing. Omit fileFilter to search everything.");
  }
  if (languageFilter) {
    filters.push(`languageFilter "${languageFilter}"`);
    hints.push("languageFilter takes a language label exactly as a result header shows it in brackets (e.g. typescript, python, go), not an alias such as ts or py.");
  }
  if (indexing) hints.push("Indexing is in progress, so matching files may not be indexed yet; codebase_status shows progress.");
  if (!singleSource) return [`No results found for "${query}" in the selected sources with ${filters.join(" and ")}.`, ...hints];
  const miss = filters.length > 1 ? `${filters.join(" and ")} together matched no indexed chunk`
    : fileFilter ? `${filters[0]} matched no indexed file` : `${filters[0]} matched no indexed chunk`;
  return [`No results found for "${query}" in project ${resolvedPath}: ${miss}.`, ...hints];
}

/** Run a query or status request with the selected mode's Git freshness notice. */
export async function handleQueryTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const projectPath = (args.projectPath as string) || process.cwd();
  return withGitRefreshNotice(projectPath, async () => {
    const result = await dispatchQueryTool(name, args);
    return typeof result === "string" ? result : result.text;
  });
}

/** Dispatch search and status requests using the existing project identity and watcher policy. */
async function dispatchQueryTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string | SearchQueryResponse> {
  const projectPath = (args.projectPath as string) || process.cwd();
  const resolvedPath = path.resolve(projectPath);
  const projectId = projectIdFromPath(resolvedPath);
  const collection = collectionName(projectId);
  const watcherMode = getWatcherMode();

  // Auto-start watcher on any query/status interaction (fire-and-forget)
  ensureWatcherStarted(resolvedPath);

  switch (name) {
    case "codebase_search": {
      await ensureQdrantReady();
      searchStage("qdrant_ready");

      const query = args.query as string;
      const limit = (args.limit as number) || SEARCH_DEFAULT_LIMIT;
      const fileFilter = args.fileFilter as string | undefined;
      const languageFilter = args.languageFilter as string | undefined;
      const includeLinked = args.includeLinked as boolean | undefined;
      const scope = args.scope === "main" || args.scope === "sources" || args.scope === "project"
        ? args.scope : includeLinked === false ? "main" : "project";
      const skipped: string[] = [];
      const incomplete: string[] = [];
      const searchedSources: string[] = [];
      const failedSources: Array<{ path: string; error: string }> = [];
      const response = (text: string, results: SearchResult[] = [], filteredCount = 0, warnings: string[] = []): SearchQueryResponse => {
        const partial = skipped.length > 0 || incomplete.length > 0 || failedSources.length > 0;
        const failed = searchedSources.length === 0 && (failedSources.length > 0 || skipped.length > 0);
        return { text, isError: failed, structuredContent: {
          status: failed ? "failed" : partial ? "partial" : allResults.length > 0 ? "ok" : "empty",
          partial, searchedSources, failedSources, skippedSources: skipped, incompleteSources: incomplete,
          results, filteredCount, warnings,
        } };
      };

      let allResults: SearchResult[];
      if (scope === "main") {
        const info = await getCollectionInfo(collection);
        if (!info) return {
          text: `No codebase index found for: ${resolvedPath}. Run codebase_index for this project when indexing is intended.`,
          isError: true,
          structuredContent: { status: "index_missing", partial: false, searchedSources: [], failedSources: [],
            skippedSources: [`${resolvedPath}: missing`], incompleteSources: [], results: [], filteredCount: 0, warnings: [] },
        };
        const metadata = await getProjectMetadata(collection);
        if (metadata?.indexingStatus === "in-progress") incomplete.push(resolvedPath);
        try {
          allResults = await searchChunks(collection, query, limit, fileFilter, languageFilter);
          searchedSources.push(resolvedPath);
        } catch (error) {
          allResults = [];
          failedSources.push({ path: resolvedPath, error: error instanceof Error ? error.message : String(error) });
        }
      } else {
        const catalog = await getProjectCatalog({ projectPath: resolvedPath });
        const entries = [...(scope === "project" && catalog.project ? [catalog.project] : []), ...catalog.sources];
        const selected = entries.filter((entry) => {
          if ((entry.index === "available" || entry.index === "incomplete") && entry.collection) {
            if (entry.index === "incomplete") incomplete.push(entry.path);
            return true;
          }
          skipped.push(`${entry.path}: ${entry.index}`);
          return false;
        });
        const collections = selected.flatMap((entry) => entry.collection ? [{ name: entry.collection, label: entry.path }] : []);
        if (scope === "project" && collections.length === 1 && selected[0] === catalog.project) {
          try {
            allResults = await searchChunks(collections[0].name, query, limit, fileFilter, languageFilter);
            searchedSources.push(resolvedPath);
          } catch (error) {
            allResults = [];
            failedSources.push({ path: resolvedPath, error: error instanceof Error ? error.message : String(error) });
          }
        } else {
          const report = await searchMultipleCollections(collections, query, limit, fileFilter, languageFilter);
          allResults = report.results;
          searchedSources.push(...report.searchedSources);
          failedSources.push(...report.failedSources);
        }
      }

      // Apply minimum score threshold
      const minScore = (args.minScore as number) ?? SEARCH_MIN_SCORE;
      const results = minScore > 0
        ? allResults.filter((r) => r.score >= minScore)
        : allResults;
      const filteredCount = allResults.length - results.length;

      if (results.length === 0) {
        const lines: string[] = [];
        if (searchedSources.length === 0 && failedSources.length > 0) {
          lines.push("Search failed: no selected source could be queried. This is not an empty search result.");
        } else if (searchedSources.length === 0 && skipped.length > 0) {
          lines.push("No searchable index is available in the selected scope. This is not an empty search result.");
        } else if (filteredCount > 0) {
          lines.push(
            `No results above score threshold ${minScore.toFixed(2)} for "${query}" in project ${resolvedPath}.`,
            `${filteredCount} result${filteredCount === 1 ? " was" : "s were"} below the threshold. Try a broader query or lower the minScore parameter.`,
          );
        } else if (fileFilter || languageFilter) {
          const singleSource = scope !== "sources" && searchedSources.length === 1 && searchedSources[0] === resolvedPath
            && skipped.length === 0 && failedSources.length === 0;
          lines.push(...await filteredNoResultsLines(query, resolvedPath, collection, fileFilter, languageFilter, singleSource));
        } else {
          lines.push(
            `No results found for "${query}" in project ${resolvedPath}.`,
          );
        }
        await appendWatcherState(lines, resolvedPath, watcherMode, "search");
        if (incomplete.length > 0) lines.push(`Incomplete snapshot: ${incomplete.join("; ")}. Previously stored chunks remain searchable during updates; check codebase_status.`);
        if (skipped.length > 0) lines.push(`Not searched: ${skipped.join("; ")}. Use codebase_status for the relevant path.`);
        if (failedSources.length > 0) lines.push("Partial search: failed sources are not covered.", ...failedSources.map((item) => `Failed source: ${item.path}: ${item.error}`));
        const result = response(lines.join("\n"), [], filteredCount, fileFilter || languageFilter ? lines : lines.slice(1));
        if (!result.structuredContent.partial) result.structuredContent.status = "empty";
        return result;
      }

      const lines = [`Search results for "${query}" (${results.length} matches):\n`];
      if (incomplete.length > 0) lines.push(`Incomplete snapshot: ${incomplete.join("; ")}. Previously stored chunks remain searchable during updates; check codebase_status.`);
      if (skipped.length > 0) lines.push(`Not searched: ${skipped.join("; ")}. Use codebase_status for the relevant path.`);
      if (failedSources.length > 0) lines.push("Partial search: failed sources are not covered.", ...failedSources.map((item) => `Failed source: ${item.path}: ${item.error}`));

      if (isIndexingInProgress(resolvedPath)) {
        const progress = getIndexingProgress(resolvedPath);
        if (progress?.type === "full-index") {
          const pct = progress.filesTotal > 0
            ? `${Math.round((progress.filesProcessed / progress.filesTotal) * 100)}%`
            : "unknown";
          lines.push(`⚠ INCOMPLETE INDEX: A full index is currently in progress (${pct} done).`);
          lines.push("  These results are from the portion indexed so far and may be significantly incomplete.");
          lines.push("  Call codebase_status to check progress. Wait for indexing to complete for full results.\n");
        } else {
          lines.push("⚠ NOTE: An incremental index update is in progress. Results may be slightly stale.\n");
        }
      }

      await appendWatcherState(lines, resolvedPath, watcherMode, "search");

      for (const r of results) {
        const projectTag = r.project ? ` [${r.project}]` : "";
        lines.push(`--- ${r.relativePath} (lines ${r.startLine}-${r.endLine}) [${r.language}]${projectTag} score: ${r.score.toFixed(4)} ---`);
        lines.push(r.content);
        lines.push("");
      }

      if (filteredCount > 0) {
        lines.push(`(${filteredCount} additional result${filteredCount === 1 ? "" : "s"} below score threshold ${minScore.toFixed(2)} omitted)`);
      }

      return response(lines.join("\n"), results, filteredCount, lines.slice(1, lines.findIndex((line) => line.startsWith("--- "))));
    }

    case "codebase_status": {
      try {
        await ensureQdrantReady();
      } catch {
        // Even if Qdrant is down, check if indexing is in progress (infra might be starting)
        if (isIndexingInProgress(resolvedPath)) {
          const progress = getIndexingProgress(resolvedPath);
          if (progress) {
            const { elapsed, progressLine, batchLine, graphLine } = formatProgressLines(progress);
            const lines = [
              `Project: ${resolvedPath}`,
              "",
              `\u26a0 ${progress.type === "full-index" ? "Full index" : "Incremental update"} in progress`,
              `  Phase: ${progress.phase}`,
              progressLine,
              ...(batchLine ? [batchLine] : []),
              `  Elapsed: ${elapsed}s`,
              "",
              graphLine,
              "",
              "Qdrant is starting up. Keep calling codebase_status to check progress.",
            ];
            await appendWatcherState(lines, resolvedPath, watcherMode, "status");
            return lines.join("\n");
          }
        }
        const lines = ["Qdrant is not available. Run codebase_index first to set up infrastructure."];
        await appendWatcherState(lines, resolvedPath, watcherMode, "status");
        return lines.join("\n");
      }

      const info = await getCollectionInfo(collection);

      // Check for in-progress indexing even if no collection exists yet
      if (!info) {
        if (isIndexingInProgress(resolvedPath)) {
          const progress = getIndexingProgress(resolvedPath);
          if (progress) {
            const { elapsed, progressLine, batchLine, graphLine } = formatProgressLines(progress);
            const lines = [
              `Project: ${resolvedPath}`,
              "",
              `\u26a0 ${progress.type === "full-index" ? "Full index" : "Incremental update"} in progress`,
              `  Phase: ${progress.phase}`,
              progressLine,
              ...(batchLine ? [batchLine] : []),
              `  Elapsed: ${elapsed}s`,
              "",
              graphLine,
              "",
              "Index is being created. Keep calling codebase_status to check progress.",
            ];
            await appendWatcherState(lines, resolvedPath, watcherMode, "status");
            return lines.join("\n");
          }
        }
        const lines = [
          `No index found for project: ${resolvedPath}`,
          "Run codebase_index to create one.",
        ];
        await appendWatcherState(lines, resolvedPath, watcherMode, "status");
        return lines.join("\n");
      }

      const metadata = await getProjectMetadata(collection);
      const storedProfile = await loadProjectEffectiveProfile(collection);

      const statusLines = [
        `Project: ${resolvedPath}`,
        `Collection: ${collection}`,
        `Status: ${info.status}`,
        `Indexed chunks: ${info.pointsCount}`,
      ];

      const effectiveProfile = resolveEffectiveIndexProfile(
        "code",
        storedProfile,
        info.pointsCount > 0,
        info.denseVectorSize,
      );
      const requestedProfile = requestedIndexProfile("code");
      const profileDifferences = indexProfileDifferences(effectiveProfile, requestedProfile);
      if (profileDifferences.length > 0) {
        statusLines.push(
          `Index profile: ${profileDifferences.length} requested change${profileDifferences.length === 1 ? "" : "s"} inactive for this existing index: ${profileDifferences.join(", ")}`,
        );
        // Say what this does and does not mean. The index remains operational
        // with its stored representation: every write continues to match the
        // collection's profile, so a changed file is re-chunked the way that
        // profile says, not the way the settings now ask for. That is why
        // re-running codebase_index adopts nothing, and why editing every file
        // would not either. Only a collection created fresh adopts the pending
        // changes, which for indexFormatVersion is also what recovers content
        // an older index truncated away.
        statusLines.push(
          "Index profile: this index remains operational with its stored representation. Re-running codebase_index reproduces that representation and adopts none of the pending changes. To apply them and, for chunk-format changes, improve content coverage, run codebase_remove and then codebase_index; that is optional.",
        );
      }
      if (effectiveProfile.legacyUnverifiedFields.length > 0) {
        statusLines.push(
          `Index profile: legacy-unverified fields: ${effectiveProfile.legacyUnverifiedFields.join(", ")}`,
        );
      }

      if (metadata?.scanFailure) statusLines.push("Index scan failed: " + metadata.scanFailure);

      // Detect persisted incomplete index (previous run was interrupted)
      if (metadata?.indexingStatus === "in-progress" && !isIndexingInProgress(resolvedPath)) {
        // Check if another process is actively indexing (cross-process lock)
        const orphanPid = await getLockHolderPid(resolvedPath, "index");
        if (orphanPid !== null) {
          statusLines.push("");
          statusLines.push(`⚠ ANOTHER PROCESS (PID ${orphanPid}) IS ACTIVELY INDEXING this project.`);
          statusLines.push(`  Files indexed so far: ${metadata.filesIndexed} of ${metadata.filesTotal} discovered`);
          statusLines.push(`  Chunks stored: ${info.pointsCount} (partial)`);
          statusLines.push("");
          statusLines.push("  This is likely an automatic resume of a previous indexing interruption.");
          statusLines.push("  You can use codebase_stop to terminate it (and restart it directly to watch progress if you want), or wait for it to finish.");
        } else {
          statusLines.push("");
          statusLines.push("⚠ INDEX IS INCOMPLETE — a previous indexing run was interrupted before finishing.");
          statusLines.push(`  Files indexed: ${metadata.filesIndexed} of ${metadata.filesTotal} discovered`);
          statusLines.push(`  Chunks stored: ${info.pointsCount} (partial)`);
          statusLines.push("");
          statusLines.push("  Run codebase_index to resume and complete the index.");
        }
      }

      // Show in-progress indexing
      if (isIndexingInProgress(resolvedPath)) {
        const progress = getIndexingProgress(resolvedPath);
        statusLines.push("");
        if (progress) {
          const { elapsed, progressLine, batchLine } = formatProgressLines(progress);
          statusLines.push(`⚠ ${progress.type === "full-index" ? "Full index" : "Incremental update"} in progress`);
          statusLines.push(`  Phase: ${progress.phase}`);
          statusLines.push(progressLine);
          if (batchLine) {
            statusLines.push(batchLine);
          }
          statusLines.push(`  Elapsed: ${elapsed}s`);
          if (progress.filesTotal > 0 && progress.filesProcessed < progress.filesTotal) {
            statusLines.push("");
            statusLines.push("Keep calling codebase_status to check progress until it reaches 100%.");
          }
        }
      } else {
        // Show last completed operation
        const completed = getLastCompleted(resolvedPath);
        if (completed) {
          statusLines.push("");
          const ago = ((Date.now() - completed.completedAt) / 1000).toFixed(0);
          const duration = (completed.durationMs / 1000).toFixed(1);
          if (completed.error === "Cancelled by user") {
            statusLines.push(`Last operation: ${completed.type === "full-index" ? "Full index" : "Incremental update"} — cancelled`);
            statusLines.push(`  Saved progress is preserved; ${ago}s ago (ran for ${duration}s)`);
          } else if (completed.error) {
            statusLines.push(`Last operation: ${completed.type === "full-index" ? "Full index" : "Incremental update"} — FAILED`);
            statusLines.push(`  Error: ${completed.error}`);
            statusLines.push(`  ${ago}s ago (ran for ${duration}s)`);
          } else {
            statusLines.push(`Last operation: ${completed.type === "full-index" ? "Full index" : "Incremental update"} — completed`);
            statusLines.push(`  Files: ${completed.filesProcessed}, Chunks: ${completed.chunksCreated}`);
            statusLines.push(`  ${ago}s ago (took ${duration}s)`);
          }
        }
      }

      await appendWatcherState(statusLines, resolvedPath, watcherMode, "status");

      // Graph status
      try {
        const graphInfo = await getGraphStatus(resolvedPath);
        statusLines.push("");
        if (graphInfo) {
          statusLines.push(`Code graph: ${graphInfo.nodeCount} files, ${graphInfo.edgeCount} edges`);
          const graphAgo = ((Date.now() - new Date(graphInfo.lastBuiltAt).getTime()) / 1000).toFixed(0);
          statusLines.push(`  Last built: ${graphAgo}s ago${graphInfo.cached ? " (cached in memory)" : ""}`);
          // The stored graph is served unchanged across upgrades, so this
          // reports the build that produced it, not the one answering (issue
          // #120). One line per case, matching the density of the rest of this
          // status; codebase_graph_status carries the full explanation.
          if (!graphInfo.builtByVersion) {
            // A graph persisted before the stamp existed. Unknown is not the
            // same as current: this is exactly the state that made a stale
            // artifact read as a resolver bug, so it gets said out loud.
            statusLines.push(
              `  Built by an unrecorded version — run codebase_graph_build to confirm this graph reflects v${SOCRATICODE_VERSION}'s resolvers.`,
            );
          } else if (isGraphBuilderStale(graphInfo.builtByVersion, SOCRATICODE_VERSION)) {
            statusLines.push(
              `  Built by v${graphInfo.builtByVersion}, this server is v${SOCRATICODE_VERSION} — run codebase_graph_build to pick up newer resolvers.`,
            );
          }
        } else if (isIndexingInProgress(resolvedPath)) {
          const progress = getIndexingProgress(resolvedPath);
          if (progress?.phase === "building code graph") {
            statusLines.push("Code graph: building now...");
          } else {
            statusLines.push("Code graph: pending — will be auto-built after indexing completes");
          }
        } else {
          statusLines.push("Code graph: not built");
          statusLines.push("  Run codebase_graph_build to build it, or codebase_index to re-index (graph is built automatically).");
        }
      } catch {
        // Graph status check failed — non-critical
      }

      // Context artifacts status
      try {
        const artifactSummary = await getArtifactStatusSummary(resolvedPath);
        if (artifactSummary) {
          statusLines.push("");
          statusLines.push(...artifactSummary.lines);
        }
      } catch {
        // Artifact status check failed — non-critical
      }

      return statusLines.join("\n");
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
