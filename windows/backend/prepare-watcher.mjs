
export async function prepareWatcher(patch){
  await patch("index.js",[
    ['    server.registerTool("codebase_index", {',
`    server.registerTool("codebase_setup", {
        description: "Inspect project and index state. When there is no index, ask the user if they want indexing and the code graph. After consent, inspect the project structure, save ignore rules, preview files, then call codebase_index. Save and preview do not start indexing.",
        inputSchema: z.object({
            projectPath: projectPathSchema("Absolute path to the project directory."),
            action: z.enum(["inspect", "save", "preview"]),
            ignoreRules: z.string().max(16000).optional(),
            includePaths: z.array(z.string().min(1).max(400)).max(32).optional(),
            limit: z.number().int().min(1).max(200).optional(),
        }),
    }, async (args, context) => {
        const { configure } = await import("../setup-policy.mjs");
        return { content: [{ type: "text", text: JSON.stringify(await runRequest(context, () => configure(args))) }] };
    });
    server.registerTool("codebase_index", {`],
    ['const result = await runRequest(context, () => handleGraphListTool("codebase_graph_query", args));',
     'const result = withGraphFreshness(await runRequest(context, () => handleGraphListTool("codebase_graph_query", args)), args.projectPath);'],
    ['const result = await runRequest(context, () => handleGraphListTool("codebase_symbols", args));',
     'const result = withGraphFreshness(await runRequest(context, () => handleGraphListTool("codebase_symbols", args)), args.projectPath);'],
    ['import { handleIndexTool } from "./tools/index-tools.js";',
     'import { handleIndexTool } from "./tools/index-tools.js";\nimport { withGraphFreshness } from "../watch-state.mjs";'],
  ]);
  await patch("tools/index-tools.js",[
    ['export async function handleIndexTool(name, args) {',
`import { setupRules, needsRules } from "../../setup-policy.mjs";
export async function handleIndexTool(name, args) {
    if ((name === "codebase_index" && args.dryRun !== true) || name === "codebase_update") {
        const rule = await setupRules(args.projectPath ?? process.cwd());
        if (rule.status !== "rules_ready") return "Cannot index: " + needsRules(rule);
    }`],
  ]);
  await patch("tools/query-tools.js",[
    ['import { exactPage } from "../../exact.mjs";',
     'import { exactPage } from "../../exact.mjs";\nimport { currentChanges } from "../../watch-state.mjs";\nimport { stat } from "node:fs/promises";'],
    ['    if (args.cursor !== undefined)\n        return continueSearchPage(resolvedArgs);',
`    if (args.cursor !== undefined)
        return continueSearchPage(resolvedArgs);
    const directory = await stat(resolvedArgs.projectPath).then(value => value.isDirectory(), error => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
        throw error;
    });
    if (!directory) {
        return createSearchPage(resolvedArgs, [], { status:"index_missing", partial:false, searchedSources:[], failedSources:[], skippedSources:[resolvedArgs.projectPath], incompleteSources:[] },
            ["Project directory does not exist: " + resolvedArgs.projectPath], 0);
    }`],
    ['    if (args.mode === "exact") return exactPage(resolvedArgs);', '    if (args.mode === "exact") { ensureWatcherStarted(resolvedArgs.projectPath); return exactPage(resolvedArgs); }'],
    ['    return createSearchPage(resolvedArgs, results, selection, [...warnings, ...notices], filteredCount);',
`    if (currentChanges(resolvedArgs.projectPath) && (selection.status === "ok" || selection.status === "empty" || selection.status === "partial")) {
        selection.status = "partial";
        selection.partial = true;
        warnings.push("File changes are being indexed; results may contain the previous snapshot.");
    }
    return createSearchPage(resolvedArgs, results, selection, [...warnings, ...notices], filteredCount);`],
    ['Run codebase_index for this project when indexing is intended.', 'Ask the user whether they want indexing and a code graph, then use codebase_setup.'],
  ]);
  await patch("services/ignore.js",[
    ['import ignore from "ignore";','import ignore from "ignore";\nimport { includesFromRules, keepsPath } from "../../setup-policy.mjs";'],
    ['    ".cache",\n    ".temp",','    ".lab",\n    ".cache",\n    ".temp",'],
    ['    const respectGitignore = (process.env.RESPECT_GITIGNORE ?? "true").toLowerCase() !== "false";','    const respectGitignore = true;'],
    ['    const scanIg = ignore().add(ig).add(projectRules);','    const scanIg = ignore().add(ig).add(projectRules);\n    const explicit = includesFromRules(projectRules);\n    const includeDot = (process.env.INCLUDE_DOT_FILES ?? "false").toLowerCase() === "true";'],
    ['            const byPattern = ig.test(relativePath);','            if (!keepsPath(relativePath, explicit, includeDot)) return true;\n            const byPattern = ig.test(relativePath);'],
  ]);
  await patch("services/indexer.js",[
    ['/** Full index of a project directory */','import { refreshExactSnapshot } from "../../exact.mjs";\nimport { setupRules, needsRules } from "../../setup-policy.mjs";\n/** Full index of a project directory */'],
    ['        dot: (process.env.INCLUDE_DOT_FILES ?? "false").toLowerCase() === "true",','        dot: true,'],
    ['        return indexProjectImpl(projectPath, onProgress, extraExtensions, target);',
`        const check = await setupRules(projectPath);
        if (check.status !== "rules_ready") throw Error(needsRules(check));
        const result = await indexProjectImpl(projectPath, onProgress, extraExtensions, target);
        if (!result.cancelled && !result.skipped && result.filesIndexed > 0) await refreshExactSnapshot(check.root, extraExtensions);
        return result;`],
    ['        return updateProjectIndexImpl(projectPath, onProgress, extraExtensions, target);',
`        const check = await setupRules(projectPath);
        if (check.status !== "rules_ready") throw Error(needsRules(check));
        const result = await updateProjectIndexImpl(projectPath, onProgress, extraExtensions, target);
        if (!result.cancelled && !result.skipped) await refreshExactSnapshot(check.root, extraExtensions);
        return result;`],
  ]);
  await patch("services/watcher.js",[
    ['import watcher from "@parcel/watcher";','import watcher from "@parcel/watcher";\nimport { changePending, currentChanges, publishChanges } from "../../watch-state.mjs";'],
    ['        ".cache",\n        ".parcel-cache",','        ".parcel-cache",'],
    ['            if (updateRunning) {\n                updateRequestedWhileRunning = true;', '            changePending(resolvedPath);\n            if (updateRunning) {\n                updateRequestedWhileRunning = true;'],
    ['                updateRunning = true;\n                try {','                updateRunning = true;\n                const generation = currentChanges(resolvedPath);\n                try {'],
    ['                    const result = await updateProjectIndex(resolvedPath, onProgress);','                    const result = await updateProjectIndex(resolvedPath, onProgress);\n                    if (!result.cancelled && !result.skipped) publishChanges(resolvedPath, generation);'],
    ['                        const environment = environmentEvent(event, relative, ig);',
     '                        if ([".gitignore", ".socraticodeignore"].includes(path.basename(relative))) return event;\n                        const environment = environmentEvent(event, relative, ig);'],
    ['        subscriptions.set(resolvedPath, subscription);','        subscriptions.set(resolvedPath, subscription);\n        scheduleUpdate();'],
  ]);
  await patch("tools/graph-tools.js",[
    ['import { ensureWatcherStarted } from "../services/watcher.js";', 'import { ensureWatcherStarted, isWatching } from "../services/watcher.js";'],
    ['    if (watcherMode === "auto")\n        return getOrBuildGraph(projectPath);','    if (watcherMode === "auto" && isWatching(projectPath))\n        return getOrBuildGraph(projectPath);'],
    ['        case "codebase_graph_build": {','        case "codebase_graph_build": {\n            const {setupRules, needsRules} = await import("../../setup-policy.mjs");\n            const check = await setupRules(projectPath);\n            if (check.status !== "rules_ready") return needsRules(check);'],
  ]);
}
