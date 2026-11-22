# SocratiCode HTTP · management

Справочник получен из tools/list командой node scripts/tool-references.mjs --write.

## codebase_index

Start indexing a codebase in the background. Returns immediately. Wait for the operation to complete, including graph/artifact phases, using codebase_status. Partial snapshots remain searchable with coverage warnings. If already indexing, returns current progress.

| Параметр | Обязательность | Значение |
|---|---|---|
| parentPath | нет | Attach this indexed directory as a source of the parent project in the same call. Stored in the parent's .socraticode.json linkedProjects. |
| dryRun | нет | Read-only chunk/byte preview after ignore rules using the requested profile. Stops scanning at the budget and reports complete=false with lower-bound counts. Does not start services, index or attach. Available during indexing. |
| maxFiles | нет | Maximum indexable files accepted by this request. Default 2000 (SOCRATICODE_INDEX_MAX_FILES). Prefer a relevant subdirectory for large repositories. · max 9007199254740991 |
| maxChunks | нет | Maximum planned chunks. Default 20000 (SOCRATICODE_INDEX_MAX_CHUNKS). · max 9007199254740991 |
| maxBytes | нет | Maximum UTF-8 bytes of planned chunk text. Default 33554432 (SOCRATICODE_INDEX_MAX_BYTES). · max 9007199254740991 |
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |
| extraExtensions | нет | Comma-separated list of additional file extensions to index beyond the built-in set (e.g. '.tpl,.blade,.hbs'). Useful for projects with non-standard file extensions. Can also be set globally via EXTRA_EXTENSIONS env var. |

## codebase_update

Incrementally update an existing codebase index. Only re-indexes changed files. Runs synchronously. Use it to refresh a manual/off snapshot, working-tree edits before the next Git transition in git mode, or whenever an immediate catch-up is needed.

| Параметр | Обязательность | Значение |
|---|---|---|
| maxFiles | нет | Maximum discovered files. Default 2000. · max 9007199254740991 |
| maxChunks | нет | Maximum changed chunks. Default 20000. · max 9007199254740991 |
| maxBytes | нет | Maximum UTF-8 bytes of changed chunks. Default 33554432. · max 9007199254740991 |
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |
| extraExtensions | нет | Comma-separated list of additional file extensions to index (e.g. '.tpl,.blade'). |

## codebase_remove

Remove a project's codebase index entirely from the vector database. Safely stops the file watcher, cancels any in-progress indexing/update (with drain), and waits for any in-flight graph build before deleting.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the project directory. |

## codebase_prune

Inventory stored project identities and their resources. Report-only by default. Applying requires an exact identity, the confirmation token from a fresh inventory, and an acknowledgement that no other host is writing to it; path absence on this host is advisory, not proof of abandonment.

| Параметр | Обязательность | Значение |
|---|---|---|
| apply | нет | Delete the selected identity only when true. Omit for the report-only inventory. |
| identity | нет | Exact identity returned by codebase_prune. |
| confirmationToken | нет | Opaque token returned for that identity by codebase_prune. |
| acknowledgeNoRemoteWriters | нет | Required with apply. Locks on this host cannot see another host sharing the same Qdrant; true states that none is writing to this identity. |

## codebase_stop

Stop an indexing operation after its in-flight embedding packet. Earlier file-batch checkpoints are preserved; the unfinished batch is retried on resume.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |

## codebase_watch

Start/stop watching a project directory for file changes and automatically update the index. When starting, first runs an incremental update to catch up, then watches for changes. SOCRATICODE_WATCHER=manual allows explicit starts only; off and git reject file-watcher starts. In git mode, status reports Git refresh state and stop does not disable Git checks.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |
| action | да | start/stop watching, or get status of watchers. · start, stop, status |

## codebase_status

Check index, operation and graph state. Wait for completed, not only 100% of embeddings. Cancelled and failed operations are distinct.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |

## codebase_graph_build

Build a dependency graph of the codebase using static analysis (ast-grep). Maps import/require/export relationships between files. Runs in the background — call codebase_graph_status to poll progress until complete.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |
| extraExtensions | нет | Comma-separated list of additional file extensions to include in the graph (e.g. '.tpl,.blade'). Files with non-standard extensions are included as leaf nodes (dependency targets). Can also be set globally via EXTRA_EXTENSIONS env var. |

## codebase_graph_remove

Remove a project's persisted code graph. Waits for any in-flight graph build to finish first. The graph can be rebuilt with codebase_graph_build or will be rebuilt automatically on the next codebase_index.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the project directory. |

## codebase_graph_status

Check the status of the code dependency graph: build progress (if building), node/edge count, when it was last built, whether it's cached in memory. Use this to poll progress after calling codebase_graph_build.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |

## codebase_context_index

Index or re-index all context artifacts defined in .socraticodecontextartifacts.json. Chunks and embeds artifact content into the vector database for semantic search. Usually not needed — codebase_context_search auto-indexes on first use.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the actual project/workspace root. Required for shared HTTP. |

## codebase_context_remove

Remove all indexed context artifacts for a project from the vector database. Blocked while indexing is in progress — use codebase_stop or wait for the operation to finish first.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | да | Absolute path to the project directory. |

## codebase_health

Check the health of all infrastructure: Docker, Qdrant container, Ollama, and embedding model. Use this to diagnose setup issues.

## codebase_list_projects

Discover the current project index and its sources. Defaults to project scope, never indexes candidates. Use scope=all only for a machine-wide inventory. Read index and graph state before searching; legacy or incomplete indexes require attention.

| Параметр | Обязательность | Значение |
|---|---|---|
| projectPath | нет | Actual project/workspace root. Required for project scope on shared HTTP. |
| scope | нет | project, all |
| limit | нет | Page size for scope=all. · min 1 · max 100 |
| cursor | нет | nextCursor from a previous scope=all response. |

## codebase_about

Display information about SocratiCode — what it is, its tools and how to use it. Use this to get a quick overview of the MCP tools and their purpose.
