# SocratiCode HTTP · exploration

Справочник получен из tools/list командой node scripts/tool-references.mjs --write.

## codebase_search

Hybrid search. Compact text shares identical overlapping lines by rank on each page; format=json preserves full records. Result order and scores are preserved. For multiple sources, [n] refers to searchedSources[n-1]. Coverage and nextCursor in structuredContent; partial snapshots are marked.

| Параметр | Обязательность | Значение |
|---|---|---|
| query | да | Natural language search query (e.g. 'authentication middleware', 'database connection setup'). |
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |
| limit | нет | Ranked candidate window, 1–50. Default 10 (SEARCH_DEFAULT_LIMIT). total and continuation cover this selected window, not all indexed matches. · min 1 · max 50 |
| format | нет | Compact text with line references by default; json for full records. Records appear once. Can change between pages. · compact, json |
| maxChars | нет | Budget for the entire MCP result in JSON characters. Default 12000. Whole code chunks and source coverage are preserved. · min 512 · max 100000 |
| cursor | нет | nextCursor from this shared server. Repeat query, projectPath, limit and filters; maxChars may change. Snapshot expires after five minutes or server restart. |
| fileFilter | нет | Filter results to one exact relative file path, as shown in a result header (e.g. src/index.ts). Directories, globs, lists and bare names below the root match nothing. |
| languageFilter | нет | Filter results to one exact language label shown in a result header (e.g. typescript, python, go). Aliases such as ts or py match nothing. |
| minScore | нет | Minimum score in the existing ranking mode (hybrid RRF, cross-source cosine or fallback rank fusion), not confidence. Default 0.10 (SEARCH_MIN_SCORE). Set 0 to disable filtering. · min 0 · max 1 |
| includeLinked | нет | Compatibility alias: false selects main scope, true selects project scope. Prefer scope. |
| scope | нет | Default project: main code plus explicitly linked sources and existing nested indexes. main searches only this index; sources searches only its sources. Never indexes missing sources. · project, main, sources |

## codebase_graph_query

File dependency picture: → imports, ← dependents. Compact text by default; format=json for typed records. Pagination/coverage in structuredContent. Continue with unchanged project/file filters. May refresh in automatic mode.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |
| filePath | да | Relative path of the file to query (e.g. 'src/index.ts'). |
| format | нет | Compact text by default; json for typed records. Records appear once. Can change between pages. · compact, json |
| limit | нет | Maximum records per page (default 200). · min 1 · max 1000 |
| cursor | нет | nextCursor from the previous page; keep project and filters unchanged. |
| maxChars | нет | Serialized MCP result budget in characters, including text and structured data (default 12000; not a token count). · min 512 · max 100000 |

## codebase_graph_stats

Get statistics about the code dependency graph: total files, edges, most connected files, orphan files, circular dependencies.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |

## codebase_graph_circular

Find circular dependencies in the codebase.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |

## codebase_graph_visualize

Visualise the code dependency graph. Two modes:
  • mode="mermaid" (default) — returns a Mermaid diagram (text) colour-coded by language, circular deps highlighted. Best for inline rendering inside chat, GitHub, or editors that render Mermaid.
  • mode="interactive" — writes a self-contained HTML page (vendored Cytoscape.js + Dagre, works offline) and opens it in the user's default browser. Shows the file graph and, when a symbol graph is available and fits, a Symbols toggle with the symbol-level call graph. Interactions: click node for sidebar with imports/dependents/symbols list; right-click node to highlight its blast radius (reverse-transitive closure); live search; layout switcher (Dagre / force / concentric / breadth-first / grid / circle); PNG export. Use this when the user asks for a visual/interactive view, wants to explore visually, or needs a shareable diagram.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |
| mode | нет | "mermaid" (default — text diagram) or "interactive" (browser-based explorer). · mermaid, interactive |
| open | нет | In interactive mode, whether to auto-open the browser. Default true. Set false to just get the file path (useful in headless environments). |

## codebase_impact

Impact Analysis — return the BLAST RADIUS for a file or symbol. Lists every file (and, where helpful, function) that could break if you change the target. Polymorphic on target: a path-like string ('src/foo.ts') triggers file-mode; a name-like string ('validateUser') triggers symbol-mode. Use this BEFORE refactoring, renaming, or deleting code to know what depends on it.

| Параметр | Обязательность | Значение |
|---|---|---|
| maxChars | нет | Maximum text characters per page (default 12000). · min 512 · max 100000 |
| cursor | нет | Continue with structuredContent.nextCursor and the same project and filters within five minutes. |
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |
| target | в части вариантов | Target file path (relative) OR symbol name. |
| file | нет | Optional file path to disambiguate the target symbol. |
| symbolId | в части вариантов | Exact symbol ID to disambiguate the target. |
| depth | нет | How many hops back to walk (default 3, max 10). |
| limit | нет | Maximum candidates to list when the target symbol is ambiguous. Omit to list all. · min 1 · max 9007199254740991 |

Варианты обязательных полей: projectPath + target / projectPath + symbolId

## codebase_flow

Trace the EXECUTION FLOW forward from an entry point — what does this code call into? With NO args, returns a ranked list of auto-detected entry points (orphans with outgoing calls, conventional names like main(), framework routes, tests). With an entrypoint argument, returns the call tree.

| Параметр | Обязательность | Значение |
|---|---|---|
| maxChars | нет | Maximum text characters per page (default 12000). · min 512 · max 100000 |
| cursor | нет | Continue with structuredContent.nextCursor and the same project and filters within five minutes. |
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |
| entrypoint | нет | Symbol name to trace from. Omit to list auto-detected entry points. |
| file | нет | Optional file hint to disambiguate the symbol. |
| depth | нет | Maximum DFS depth (default 5, max 10). |
| limit | нет | Maximum candidates to list when the entrypoint is ambiguous. Omit to list all. · min 1 · max 9007199254740991 |

## codebase_symbol

360° view of a symbol: definition, kind, callers, callees, confidence levels. Use to understand a function or class before changing it.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |
| name | да | Symbol name (e.g. 'validateUser'). |
| file | нет | Optional file hint to disambiguate when the name is not unique. |
| limit | нет | Maximum definitions to resolve when the name is not unique. Omit to resolve all. · min 1 · max 9007199254740991 |

## codebase_symbols

Symbols grouped by file in compact text by default. Each row gives kind, id suffix and line range; exact symbolId = file + :: + suffix. format=json for full records. Page controls/coverage in structuredContent. Use codebase_symbol for details. With file, query is ignored.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |
| file | нет | Relative file path — list all symbols in this file. |
| query | нет | Substring to match against symbol names project-wide. |
| format | нет | Compact text by default; json for typed records. Records appear once. Can change between pages. · compact, json |
| limit | нет | Maximum records per page (default 200). · min 1 · max 1000 |
| cursor | нет | nextCursor from the previous page; keep project and filters unchanged. |
| maxChars | нет | Serialized MCP result budget in characters, including text and structured data (default 12000; not a token count). · min 512 · max 100000 |

## codebase_context

List all context artifacts defined in .socraticodecontextartifacts.json — database schemas, API specs, infra configs, architecture docs, etc. Shows each artifact's name, description, path, and index status. Use this to discover what project knowledge is available beyond source code.

| Параметр | Обязательность | Значение |
|---|---|---|
| help | нет | Show setup instructions explicitly. Default false; an empty artifact list stays concise. |
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |

## codebase_context_search

Semantic search across context artifacts (database schemas, API specs, infra configs, etc.) defined in .socraticodecontextartifacts.json. Auto-indexes on first use and auto-detects stale artifacts. Use this to find relevant infrastructure or domain knowledge.

| Параметр | Обязательность | Значение |
|---|---|---|
| maxChars | нет | Maximum text characters per page (default 12000). · min 512 · max 100000 |
| cursor | нет | Continue with structuredContent.nextCursor and the same project and filters within five minutes. |
| query | да | Natural language search query (e.g. 'tables related to billing', 'authentication endpoints', 'deployment resource limits'). |
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |
| artifactName | нет | Filter search to a specific artifact by name (e.g. 'database-schema'). Omit to search across all artifacts. |
| limit | нет | Maximum number of results to return. Default: 10. · min 1 · max 50 |
| minScore | нет | Minimum RRF score threshold (0-1). Results below this are filtered out. Default: 0.10 (override globally via SEARCH_MIN_SCORE env var). Set to 0 to disable filtering. · min 0 · max 1 |
