---
name: codebase-exploration
description: >-
  Explore and understand codebases using SocratiCode semantic search, dependency graphs,
  and context artifacts. Use when exploring code, understanding architecture, finding
  functions/types, analysing dependencies, searching database schemas or API specs,
  or when socraticode/codebase_search tools are available. Activates when the user asks
  about code structure, wants to find where a feature lives, or needs to understand
  how code is organised.
---

# SocratiCode Codebase Exploration

## Локальное подключение HTTP

Общий stateless HTTP: `http://127.0.0.1:16335/mcp`, MCP 2026-07-28. Во всех инструментах проекта передавайте явный абсолютный `projectPath`; рабочую папку чата сервер не определяет. Каталог без пути допускается только с `scope: "all"`. После отключения клиента фоновая индексация продолжается; повторный клиент проверяет `codebase_status { projectPath }`.

Доверенный SessionStart запускает сервер при первом сообщении чата с source startup/resume/clear. Одновременные чаты используют один запуск и короткий кеш готовности; хук не обращается к модели и индексам. Автозапуск Windows удалён после проверки восьми чатов через Codex. Для восстановления подключения выполните `node hooks/session-start.mjs` из корня установленного пакета: команда повторно использует готовый сервер и не останавливает посторонние процессы. Контейнеры по-прежнему останавливаются встроенным supervisor после 10 минут простоя и поднимаются следующим запросом.

## Workflow

Сначала определите фактический корень проекта и вызовите `codebase_list_projects { projectPath }`. По умолчанию ответ содержит только основной индекс и его источники. Не перечисляйте весь компьютер при обычной работе: `scope: "all"` нужен только для поиска неизвестной или неоднозначной регистрации. Не индексируйте кандидаты без отдельного запроса; готовые вложенные индексы уже видны как источники. Для нового источника одна операция `codebase_index { projectPath: child, parentPath: parent }` выполняет индексирование и подключение.

`codebase_search` по умолчанию ищет в основном проекте и его источниках (`scope: "project"`). `scope: "main"` ограничивает поиск основным кодом; `scope: "sources"` — ресурсами. `includeLinked` оставлен для совместимости; явный `scope` имеет приоритет. Ответ указывает путь источника. Поиск не создаёт отсутствующие индексы источников. Частичные снимки сохраняют доступность прежних фрагментов, но отмечаются как неполные. Графовые инструменты работают с одним `projectPath`: для графа источника передавайте его путь отдельно.

### Выбор инструмента по вопросу

| Что нужно узнать | Маршрут |
|---|---|
| Где реализована функция продукта | `codebase_search` с `scope=main` для собственного кода. Для сравнения с подключёнными проектами выберите `scope=project`. |
| Кто вызывает функцию | Найдите имя и файл через `codebase_symbols`, затем запросите `codebase_symbol` с именем и файлом. Для импортов файла используйте `codebase_graph_query`. |
| Что затронет правка | `codebase_impact` по symbolId или имени с подсказкой файла. Для пути исполнения от функции выберите `codebase_flow` с небольшой глубиной. |
| Где описан контракт | `codebase_context` перечисляет объявленные командой источники. По описанию выберите artifactName для `codebase_context_search`, откройте найденное место. Когда каталог пуст, Markdown также доступен через обычный поиск, если включён в индекс. |

Ссылка вида `L91-95 = #1` означает, что те же строки этого файла уже напечатаны в результате 1 на текущей странице. JSON сохраняет исходные фрагменты целиком. У больших деревьев и документов проверяйте `structuredContent.nextCursor`.

### Ведение источников контекста

При настройке SocratiCode проверьте `.socraticodeignore` в корне проекта. Если файла ещё нет, создайте его с исключениями по фактическому дереву проекта. Как только при настройке или дальнейшей работе впервые встретится авторитетный документ, который пригодится снова, сразу создайте рядом `.socraticodecontextartifacts.json` и добавьте документ в массив `artifacts`. Укажите устойчивое `name`, путь относительно корня в `path` и в `description` — на какие вопросы документ отвечает. Одного источника достаточно. Если каталог уже есть, дополните его, сохранив прежние записи и исключив дубли по пути.

Примеры первоисточников — действующая схема OpenAPI, схема БД и принятое архитектурное решение. После регистрации проверьте документ через `codebase_context` и один характерный запрос `codebase_context_search` по `artifactName`.

### Проверка состояния

- **`codebase_status`** — check index status, progress, watcher state, graph status
- If search returns no results, the project may not be indexed yet
- If the watcher is inactive, results may be stale — run `codebase_update`; start the watcher only when status does not say it is disabled
- In snapshot mode (`SOCRATICODE_WATCHER=off` plus `SOCRATICODE_AUTO_RESUME=off`), stale results are expected until an explicit update. Do not enable or start the watcher.
- In Git mode (`SOCRATICODE_WATCHER=git`), search, graph, and status requests report refresh state. Do not treat pending, failed, or unverified results as current. Git transitions trigger refreshes; use `codebase_update` for an immediate refresh of working-tree edits. Do not start the file watcher.

### Справка

- **`codebase_about`** — quick reference of all SocratiCode tools and a typical workflow

## Goal → Tool Quick Reference

| Goal | Tool |
|------|------|
| Understand what a codebase does / where a feature lives | `codebase_search` (broad query) |
| Find a specific function, constant, or type | `codebase_search` (exact name) or grep |
| Find exact error messages, log strings, or regex patterns | grep / ripgrep |
| See what a file imports or what depends on it | `codebase_graph_query` |
| Get architecture overview (files, edges, most connected) | `codebase_graph_stats` |
| Spot circular dependencies | `codebase_graph_circular` |
| Visualise module structure (text / Mermaid) | `codebase_graph_visualize` |
| User asks for a visual / interactive / shareable graph | `codebase_graph_visualize mode="interactive"` |
| Check graph build status | `codebase_graph_status` |
| Verify index is up to date | `codebase_status` |
| Discover available schemas, specs, configs | `codebase_context` |
| Find database tables, API endpoints, infra configs | `codebase_context_search` |
| Quick overview of all tools | `codebase_about` |

For full parameter details on every tool, see [references/tool-reference.md](references/tool-reference.md).

### Перенесённые обновления upstream

`limit` в `codebase_symbol` ограничивает число разрешаемых определений с одинаковым именем. В `codebase_impact` и `codebase_flow` он ограничивает список неоднозначных кандидатов, а не глубину или размер дерева вызовов. Положительное целое число; без параметра возвращаются все определения/кандидаты. Ответ сообщает полное число совпадений.

`fileFilter` принимает один точный относительный путь из результата, без каталогов и glob; `languageFilter` принимает точное имя языка (`typescript`, `python`), без сокращений `ts` и `py`.
