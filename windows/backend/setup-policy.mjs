
import path from "node:path";
import {lstat,realpath,stat,readFile,readdir,appendFile,writeFile} from "node:fs/promises";
const defaults=new Set([".lab",".tmp",".temp",".cache"]);
const marker="# socraticode-include: ";
export const ignoreName=".socraticodeignore";
const blocked=new Set(["node_modules",".git"]);
const portable=value=>value.replaceAll("\\","/");
const comparable=value=>process.platform==="win32"?value.toLowerCase():value;
function parse(value){
  const rel=portable(value.trim()).replace(/\/$/,"");
  const parts=rel.split("/");
  if(!rel||parts.some(x=>!x||x==="."||x===".."||/[:*?[\]\n\r\0]/.test(x)))return null;
  if(parts.some(x=>blocked.has(x.toLowerCase())))return null;
  const first=parts.findIndex(x=>defaults.has(x.toLowerCase()));
  if(first<0||first===parts.length-1)return null;
  return {rel,parts,first};
}
export function includesFromRules(text){
  return text.split(/\r?\n/).filter(x=>x.startsWith(marker)).map(x=>parse(x.slice(marker.length))).filter(Boolean);
}
export function keepsPath(relative,includes,includeDot){
  const clean=comparable(portable(relative).replace(/\/$/,""));
  const parts=clean.split("/");
  if(parts.some(x=>blocked.has(x.toLowerCase())))return false;
  const included=includes.some(({rel})=>{
    const allow=comparable(rel);
    return clean===allow||clean.startsWith(allow+"/")||allow.startsWith(clean+"/");
  });
  if(parts.some(x=>defaults.has(x.toLowerCase())))return included;
  if(!includeDot&&parts.some(x=>x.startsWith(".")))return included;
  return true;
}
async function directory(projectPath){
  try{
    const root=await realpath(projectPath);
    return (await stat(root)).isDirectory()?root:null;
  }catch(error){if(error.code==="ENOENT"||error.code==="ENOTDIR")return null;throw error;}
}
export async function setupRules(projectPath){
  const root=await directory(projectPath);
  if(!root)return {status:"directory_missing",projectPath:path.resolve(projectPath)};
  const name=path.join(root,ignoreName);
  try{
    const info=await lstat(name);
    if(!info.isFile())return {status:"rules_required",root,projectPath:root};
    return {status:"rules_ready",root,projectPath:root,file:name,text:await readFile(name,"utf8")};
  }catch(error){if(error.code==="ENOENT")return {status:"rules_required",root,projectPath:root};throw error;}
}
export function needsRules(check){
  return check.status==="directory_missing"
    ? "Project directory does not exist: "+check.projectPath
    : ".socraticodeignore is required before indexing. Ask the user whether they want an index and code graph, then use codebase_setup.";
}
function emitRules(includes){
  const all=includes.filter(x=>!includes.some(y=>y.rel!==x.rel&&x.rel.startsWith(y.rel+"/")));
  const prefixes=new Set();
  for(const {parts,first} of all)for(let i=first+1;i<parts.length;i++)prefixes.add(parts.slice(0,i).join("/"));
  const literal=value=>value.replace(/([# !\\])/g,"\\$1");
  return [
    "# SocratiCode indexing scope",
    ...[...defaults,"node_modules"].map(x=>x+"/"),
    ...[...prefixes].sort((a,b)=>a.split("/").length-b.split("/").length||a.localeCompare(b))
      .flatMap(x=>["!/"+literal(x)+"/","/"+literal(x)+"/*"]),
    ...all.map(({rel})=>"!/"+literal(rel)),
    ...all.map(({rel})=>marker+rel),
  ].join("\n");
}
export async function configure(args){
  const current=await setupRules(args.projectPath);
  if(current.status==="directory_missing")return current;
  const {root}=current;
  if(args.action==="inspect"){
    const {getCollectionInfo,getProjectMetadata}=await import("./dist/services/qdrant.js");
    const {projectIdFromPath,collectionName}=await import("./dist/config.js");
    const entries=await readdir(root,{withFileTypes:true});
    const peek=entries.slice(0,45);
    let status,hasIndex;
    try{
      const collection=collectionName(projectIdFromPath(root));
      const info=await getCollectionInfo(collection);
      const meta=info?await getProjectMetadata(collection):null;
      hasIndex=!!info;status=!info?"index_missing":meta?.indexingStatus==="in-progress"?"index_incomplete":"index_present";
    }catch{status="index_status_unknown";hasIndex=null;}
    return {status,projectPath:root,hasIndex,rulesReady:current.status==="rules_ready",
      gitignorePresent:entries.some(x=>x.name===".gitignore"),entries:peek.map(x=>({path:x.name,directory:x.isDirectory()}))};
  }
  if(args.action==="preview"){
    if(current.status!=="rules_ready")return {status:current.status,message:needsRules(current)};
    const {getIndexableFiles}=await import("./dist/services/indexer.js");
    const files=(await getIndexableFiles(root)).map(portable).sort();
    return {status:"preview",projectPath:root,fileCount:files.length,files:files.slice(0,args.limit??30),more:files.length>(args.limit??30)};
  }
  const list=[];
  for(const raw of args.includePaths??[]){
    const candidate=parse(raw);
    if(!candidate)throw Error("Invalid inclusion. Select a specific path inside .lab, .tmp, .temp or .cache; node_modules is excluded.");
    const abs=await realpath(path.join(root,candidate.rel));
    const resolved=path.relative(root,abs);
    if(!resolved||resolved.startsWith(".."+path.sep)||resolved===".."||path.isAbsolute(resolved)||
      comparable(portable(resolved))!==comparable(candidate.rel))
      throw Error("Include path must resolve to the same project path.");
    list.push(candidate);
  }
  const old=includesFromRules(current.text??"");
  const merged=[...new Map([...old,...list].map(x=>[comparable(x.rel),x])).values()];
  const knownRules=args.ignoreRules??"";
  if(knownRules.split(/\r?\n/).some(x=>x.startsWith(marker)))throw Error("Use includePaths for explicit inclusions");
  const block=emitRules(merged)+(knownRules.trim()?"\n"+knownRules.trim():"")+"\n";
  const file=path.join(root,ignoreName);
  if(current.status==="rules_ready"){
    if(!current.text.endsWith(block))await appendFile(file,"\n"+block,"utf8");
  }else{
    await writeFile(file,block,{encoding:"utf8",flag:"wx"});
  }
  return {status:"rules_saved",projectPath:root,file,explicitIncludes:merged.map(x=>x.rel)};
}
