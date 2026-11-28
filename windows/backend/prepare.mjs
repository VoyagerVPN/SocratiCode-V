
import path from "node:path";
import { cp,readFile,writeFile } from "node:fs/promises";
const root=import.meta.dirname;
const dist=path.join(root,"dist");
await cp(path.resolve(root,"../../dist"),dist,{recursive:true});
async function patch(file,replacements){
  const target=path.join(dist,file);
  let code=await readFile(target,"utf8");
  for(const [before,after] of replacements){
    if(code.split(before).length!==2)throw Error("Expected one match in "+file+": "+before);
    code=code.replace(before,after);
  }
  await writeFile(target,code);
}
await patch("constants.js", [[
  'esmRequire("../package.json")', 'esmRequire("../../../package.json")',
]]);
const searchMarker='    server.registerTool("codebase_search", {';
const without=await readFile(path.join(dist,"index.js"),"utf8");
const pos=without.indexOf(searchMarker);
if(pos<0)throw Error("Search registration not found");
const before=without.indexOf("inputSchema: z.object({",pos)+"inputSchema: z.object({".length;
await writeFile(path.join(dist,"index.js"),without.slice(0,before)+'\n            mode: z.enum(["hybrid", "exact"]).optional(),'+without.slice(before));
await patch("tools/query-tools.js",[
  ['import path from "node:path";','import path from "node:path";\nimport { exactPage } from "../../exact.mjs";'],
  ['    let response;\n    const text = await withGitRefreshNotice(projectPath,', '    if (args.mode === "exact") return exactPage(resolvedArgs);\n    let response;\n    const text = await withGitRefreshNotice(projectPath,'],
]);
await patch("services/search-pages.js",[
  ['pageFingerprint([args.projectPath, args.query,','pageFingerprint([args.projectPath, args.mode ?? "hybrid", args.query,'],
]);
await patch("launcher.js", [[
  'process.stdin.on("error", shutdown);',
  'if (process.env.SCV_LAUNCHER) {\n    process.stdin.once("end", shutdown);\n    process.stdin.resume();\n}\nprocess.stdin.on("error", shutdown);',
]]);
await patch("services/provider-ollama.js", [
  ['import { Agent, fetch as undiciFetch } from "undici";', 'import { Agent, fetch as undiciFetch } from "undici";\nimport { ensureNativeOllama, resetNativeOllama } from "../../native-provider.mjs";'],
  ['                    const response = await undiciFetch(input, { ...init, dispatcher: transportDispatcher });', '                    await ensureNativeOllama();\n                    const response = await undiciFetch(input, { ...init, dispatcher: transportDispatcher });'],
  ['                    // Preserve the actionable policy failure', '                    if (error instanceof TypeError) resetNativeOllama();\n                    // Preserve the actionable policy failure'],
  ['        const response = await fetch(config.ollamaUrl.replace(/\\/$/, "") + "/api/tags", {', '        await ensureNativeOllama();\n        const response = await fetch(config.ollamaUrl.replace(/\\/$/, "") + "/api/tags", {'],
  ['    catch {\n        return null;\n    }\n}\nfunction containsModel', '    catch {\n        resetNativeOllama();\n        return null;\n    }\n}\nfunction containsModel'],
]);
await (await import("./prepare-graph.mjs")).prepareGraph(dist,patch);


await (await import("./prepare-watcher.mjs")).prepareWatcher(patch);
await (await import("./prepare-lease.mjs")).prepareLease(patch);
