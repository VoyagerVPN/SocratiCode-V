
import { readFile,writeFile } from "node:fs/promises";
import path from "node:path";
export async function prepareGraph(dist,patch){
  await patch("services/symbol-graph-store.js",[
    ['function storeClient() {','import { sqliteGraph } from "../../graph-sqlite.mjs";\nfunction storeClient() {'],
    ['    const qdrant = getClient();\n    return {','    const qdrant = sqliteGraph();\n    return {'],
  ]);
  await patch("services/qdrant.js",[
    ['async function loadMetadataPayloadReadOnly(collName) {\n    try {\n        const points = await getClient().retrieve','async function loadMetadataPayloadReadOnly(collName, client = getClient()) {\n    try {\n        const points = await client.retrieve'],
    ['async function localOwnershipPayload(collName, projectPath) {','async function localOwnershipPayload(collName, projectPath, client) {'],
    ['    const previous = await loadMetadataPayloadReadOnly(collName);','    const previous = await loadMetadataPayloadReadOnly(collName, client);'],
  ]);
  const target=path.join(dist,"services","qdrant.js");
  const original=await readFile(target,"utf8");
  const first=original.indexOf("export async function saveGraphData");
  const last=original.indexOf("// ── Context artifact metadata",first);
  if(first<0||last<0)throw Error("Graph persistence range not found");
  const region=original.slice(first,last)
    .replaceAll("await ensureMetadataCollection();","await sqliteGraph().createCollection(METADATA_COLLECTION);")
    .replaceAll("const qdrant = getClient();","const qdrant = sqliteGraph();")
    .replaceAll("loadMetadataPayloadReadOnly(graphCollName)","loadMetadataPayloadReadOnly(graphCollName, sqliteGraph())")
    .replaceAll("localOwnershipPayload(graphCollName, projectPath)","localOwnershipPayload(graphCollName, projectPath, sqliteGraph())")
    .replaceAll("await getClient().retrieve(METADATA_COLLECTION","await sqliteGraph().retrieve(METADATA_COLLECTION");
  await writeFile(target,'import { sqliteGraph } from "../../graph-sqlite.mjs";\n'+original.slice(0,first)+region+original.slice(last));
}
