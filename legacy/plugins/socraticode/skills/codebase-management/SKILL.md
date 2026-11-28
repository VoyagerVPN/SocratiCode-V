---
name: codebase-management
description: >-
  Set up, index, and manage SocratiCode codebase indexing. Use when the user wants to
  index a project, check infrastructure health, start/stop file watching, configure
  context artifacts, troubleshoot indexing issues, manage the code graph, or any
  SocratiCode administrative task. Activates when the user mentions indexing, setting up
  search, SocratiCode infrastructure, or managing the codebase index.
---

# SocratiCode Management

Set up, index, and manage SocratiCode codebase indexing, file watching, code graphs, and context artifacts.

## Локальный профиль Jina/GPU

Локальный плагин запускает `server/dist/launcher.js` из установленного пакета и использует Jina v5 Nano Retrieval F16 (`hf.co/jinaai/jina-embeddings-v5-text-nano-retrieval:F16`), 768 измерений, префиксы `Query: ` и `Document: `, контекст 2048, пакет 8 и одно соединение Ollama в общем HTTP-процессе. Launcher запускает один Worker со стеком 16 МБ для нативного AST-парсера. Рабочий контейнер `socraticode-ollama` на порту 11435 использует NVIDIA GPU через Docker Desktop/WSL2. `SOCRATICODE_OLLAMA_GPUS=all` сохраняет GPU при повторном создании контейнера; CUDA-кэш находится в `server/.cache/cuda-cache`. Не заменяйте этот профиль на Nomic и не создавайте второй Ollama для каждого чата.

Проверяйте фактическое ускорение через `/api/ps` (ненулевой `size_vram`) и `docker inspect socraticode-ollama` (GPU DeviceRequests). Обычный `codebase_health` подтверждает доступность, но не использование GPU. Смена модели в настройках не преобразует существующие индексы: нужен `codebase_remove` и полный `codebase_index`, включая контекст и граф.

Остановка после 10 минут простоя встроена в SocratiCode и согласуется между всеми MCP-процессами через `.cache/runtime`. Активные запросы, индексирование и графы защищены от остановки; следующий поисковый запрос запускает существующие контейнеры. Внешняя задача `SocratiCode Idle Stop` заменена встроенным supervisor этой сборки. Не удаляйте volumes для устранения штатного состояния простоя. Для установки и обслуживания следуйте `AGENTS.md` в корне пакета.

## Проект и источники

Передавайте фактический корень рабочего проекта как `projectPath`: общий MCP не хранит переключаемый «текущий проект» между чатами. `codebase_list_projects { projectPath }` возвращает компактный JSON и `structuredContent`: основной `project` и его `sources`. Полный реестр этой машины доступен только через `scope: "all"` с `limit` и `cursor`; используйте его при неизвестном пути или неоднозначной идентичности, а не при каждом старте работы.

`codebase_index { projectPath: child, parentPath: parent }` индексирует явно выбранный источник и подключает его к родителю через `.socraticode.json.linkedProjects`. Готовый индекс подключается без повторной индексации. Вложенный уже зарегистрированный индекс автоматически виден как источник, включая `.temp` и `.cache`; вложенная папка или Git-репозиторий без индекса источником не становится. Подключение двух источников из разных чатов сохраняет оба изменения конфигурации.

Родительский обход по умолчанию обрезает зависимости, сборки и временные папки до чтения содержимого. Явное индексирование самого подкаталога `.temp/mod` допускается с его собственными ignore. Изучение большого проекта не означает разрешения на полную индексацию: сначала используйте `codebase_index { projectPath, dryRun: true }`, выберите нужное поддерево и подготовьте ignore. По умолчанию новый запуск принимает до 2000 индексируемых файлов; `maxFiles` увеличивайте только для намеренно выбранного полного индекса. Preview не запускает инфраструктуру и не записывает индексы или связи.

Не перестраивайте старые проекты заранее: индексирование и исправление legacy выполняются при потребности в конкретном проекте. `sources` со статусом `missing`, `legacy` или `unknown` требуют отдельного решения; поиск не индексирует их автоматически. `incomplete` означает частичный снимок: ранее сохранённые фрагменты доступны с предупреждением, но полнота результата не доказана.

## Локальное подключение HTTP

Общий stateless HTTP: `http://127.0.0.1:16335/mcp`, MCP 2026-07-28. Во всех инструментах проекта передавайте явный абсолютный `projectPath`; рабочую папку чата сервер не определяет. Каталог без пути допускается только с `scope: "all"`. После отключения клиента фоновая индексация продолжается; повторный клиент проверяет `codebase_status { projectPath }`.

Доверенный SessionStart запускает сервер при первом сообщении чата с source startup/resume/clear. Одновременные чаты используют один запуск и короткий кеш готовности; хук не обращается к модели и индексам. Автозапуск Windows удалён после проверки восьми чатов через Codex. Для восстановления подключения выполните `node hooks/session-start.mjs` из корня установленного пакета: команда повторно использует готовый сервер и не останавливает посторонние процессы. Контейнеры по-прежнему останавливаются встроенным supervisor после 10 минут простоя и поднимаются следующим запросом.

Для проверки последнего запуска и поиска выполните `node scripts/startup-status.mjs` из корня сервера. Команда читает локальный журнал без запуска Docker. Время каждого этапа отсчитывается от начала своего вызова; одновременные чаты имеют отдельные идентификаторы операций.

## First-Time Setup

При настройке SocratiCode проверьте `.socraticodeignore` в корне проекта. Если файла ещё нет, создайте его с исключениями по фактическому дереву проекта. Как только при настройке или дальнейшей работе впервые встретится авторитетный документ, который пригодится снова, сразу создайте рядом `.socraticodecontextartifacts.json` и добавьте документ в массив `artifacts`. Укажите устойчивое `name`, путь относительно корня в `path` и в `description` — на какие вопросы документ отвечает. Одного источника достаточно. Если каталог уже есть, дополните его, сохранив прежние записи и исключив дубли по пути.

1. **Check infrastructure**: `codebase_health` — verifies Docker, Qdrant, Ollama/embedding provider, and embedding model
2. **Preflight**: determine the actual Git/workspace root and call `codebase_list_projects { projectPath }`; compare the main index and its sources. Use paginated `scope=all` when the actual path or identity is uncertain. For a needed legacy-adopted/unverified profile, report its previous indexing time with timezone before removing the exactly matched project and rebuilding it.
3. **Start indexing**: `codebase_index` — runs in background, returns immediately
4. **Poll progress**: `codebase_status` — wait for the operation, indexing and graph to complete
   - HTTP requests are independent; polling observes the background task.
5. **Done**: wait for both indexing and graph completion; verify no legacy/profile-change warnings remain. In the default watcher mode, the file watcher auto-starts. Ready to search.

On first use, SocratiCode automatically pulls Docker images, starts containers, and downloads the embedding model (~5 min one-time setup).

## Incremental Updates & File Watching

The file watcher keeps the index automatically updated in the default `SOCRATICODE_WATCHER=auto` mode.

- **`codebase_watch { action: "start" }`** — start the watcher (runs catch-up update first)
- **`codebase_watch { action: "stop" }`** — stop the watcher
- **`codebase_watch { action: "status" }`** — list watched projects (including cross-process)
- **`codebase_update`** — manual incremental update (only changed files, synchronous). Usually not needed if watcher is active.

For a deliberate code-index snapshot, configure every MCP process that uses the checkout with `SOCRATICODE_WATCHER=off` and `SOCRATICODE_AUTO_RESUME=off`. Search and graph tools keep reading the existing index and graph; run `codebase_update` and `codebase_graph_build` only when a refresh is wanted. Use watcher mode `manual` instead when explicit `codebase_watch { action: "start" }` should remain available. Never try to restart a watcher whose status says disabled.

With `SOCRATICODE_WATCHER=git`, active indexed checkouts refresh on checked-out ref/HEAD changes, checked every 10 seconds and on search/status/graph requests. No native file watcher starts. Pending or failed refreshes are not current results. Git triggers the update, but the working tree is indexed, including uncommitted edits. Use `codebase_update` for file saves that do not change ref/HEAD. Selecting Git mode does not create a first index. `SOCRATICODE_AUTO_RESUME=off` suppresses startup catch-up, not later Git-triggered updates. A Git diagnostic must not be bypassed by starting a watcher.

## Managing Indexes

- **`codebase_stop`** — cancel between embedding packets; the current provider request may finish. Previously committed checkpoints survive; the unfinished file batch is discarded. Resume with `codebase_index`.
- **`codebase_remove`** — delete entire index (destructive). Safely stops watcher, cancels indexing, waits for graph builds.
- **`codebase_prune`** — inventory stored identities; delete one by exact identity, fresh confirmation token and shared-store acknowledgement. Path absence is advisory, never a candidate set.
- **`codebase_list_projects`** — current project and explicit/existing nested sources, with compact index and graph state. `scope=all` is a paginated machine inventory.

## Managing the Code Graph

The dependency graph is auto-built after indexing. In watcher modes `manual` and `off`, graph queries read an existing graph but will ask for an explicit build instead of creating a missing graph as a side effect.

- **`codebase_graph_build`** — manually rebuild (background, async). Poll with `codebase_graph_status`.
- **`codebase_graph_remove`** — delete graph (auto-rebuilds on next `codebase_index`)
- **`codebase_graph_status`** — check build progress or graph readiness

## Context Artifacts Setup

To index non-code knowledge, create `.socraticodecontextartifacts.json` in the project root:

```json
{
  "artifacts": [
    {
      "name": "database-schema",
      "path": "./docs/schema.sql",
      "description": "PostgreSQL schema — all tables, indexes, constraints, foreign keys."
    }
  ]
}
```

Supported types: SQL schemas, OpenAPI/Protobuf API specs, Terraform/CloudFormation configs, Kubernetes manifests, architecture docs, environment configs — any text-based file or directory.

- **`codebase_context_index`** — manually index/re-index all artifacts (usually auto-triggered)
- **`codebase_context_remove`** — remove all indexed artifacts (blocked during indexing)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Docker not available | Install Docker Desktop from https://docker.com, ensure it's running |
| Slow indexing on this Windows machine | Verify the existing Ollama container has GPU DeviceRequests and the loaded Jina model has nonzero VRAM usage. Keep the local GPU profile; Docker Desktop/WSL2 supports this NVIDIA GPU. |
| Want cloud embeddings instead | Set `EMBEDDING_PROVIDER=openai` + `OPENAI_API_KEY`, or `EMBEDDING_PROVIDER=google` + `GOOGLE_API_KEY` |
| Search returns no results | Check `codebase_status` — project may not be indexed. Run `codebase_index`. |
| Stale results | Check `codebase_status`. Run `codebase_update`; start the watcher only when status does not say it is disabled. |
| Indexing was interrupted | Run `codebase_index` again — it resumes from the last checkpoint automatically. |
| Another process is indexing | `codebase_status` detects cross-process indexing. Wait for it, or use `codebase_stop`. |

## Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QDRANT_MODE` | `managed` | `managed` (Docker) or `external` (remote/cloud Qdrant) |
| `QDRANT_URL` | — | Full URL for remote Qdrant (e.g. `https://xyz.cloud.qdrant.io:6333`) |
| `QDRANT_API_KEY` | — | API key for remote Qdrant |
| `EMBEDDING_PROVIDER` | `ollama` | `ollama`, `openai`, or `google` |
| `OPENAI_API_KEY` | — | Required when `EMBEDDING_PROVIDER=openai` |
| `GOOGLE_API_KEY` | — | Required when `EMBEDDING_PROVIDER=google` |
| `OLLAMA_MODE` | `auto` | `auto` (detect native, fallback Docker), `docker`, `external` |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Model name (provider-specific) |
| `SEARCH_DEFAULT_LIMIT` | `10` | Default result limit for codebase_search (1-50) |
| `SEARCH_MIN_SCORE` | `0.10` | Default minimum RRF score threshold (0-1) |
| `MAX_FILE_SIZE_MB` | `5` | Maximum file size for indexing in MB; must be a complete finite number |
| `EXTRA_EXTENSIONS` | — | Additional file extensions to index (e.g. `.tpl,.blade,.hbs`) |
| `SOCRATICODE_WATCHER` | `auto` | `auto`, `manual` (explicit start only), `off` (no watcher), or `git` (ref/HEAD-triggered refresh, no native watcher) |
| `SOCRATICODE_AUTO_RESUME` | — | `all` resumes all stored projects; `off` disables startup catch-up and interrupted-index recovery |

For full parameter details on every tool, see [references/tool-reference.md](references/tool-reference.md).
