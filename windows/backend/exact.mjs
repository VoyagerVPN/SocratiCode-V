
import path from "node:path";
import { realpath,readFile,stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { getIndexableFiles,chunkFileContent } from "./dist/services/indexer.js";
import { EXTRA_EXTENSIONS, MAX_FILE_BYTES, getLanguageFromExtension } from "./dist/constants.js";
import { createSearchPage } from "./dist/services/search-pages.js";
import { currentChanges } from "./watch-state.mjs";
let db;
const queues=new Map();
function store(){
  if(db)return db;
  db=new DatabaseSync(process.env.PILOT_SQLITE_DB);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS exact_files(id INTEGER PRIMARY KEY, root TEXT NOT NULL, file TEXT NOT NULL, fingerprint TEXT NOT NULL, language TEXT NOT NULL, UNIQUE(root,file));"
    +"CREATE TABLE IF NOT EXISTS exact_ready(root TEXT PRIMARY KEY) WITHOUT ROWID;"
    +"CREATE VIRTUAL TABLE IF NOT EXISTS exact_grams USING fts5(text,tokenize='trigram case_sensitive 1',detail=none,content='',contentless_delete=1);");
  return db;
}
const normal=file=>file.replaceAll("\\","/");
async function inspect(root,file,fingerprint) {
  const absolute=await realpath(path.resolve(root,file));
  const relative=path.relative(root,absolute);
  if(!relative||relative===".."||relative.startsWith(".."+path.sep)||path.isAbsolute(relative))return null;
  const info=await stat(absolute);
  if(!info.isFile()||info.size>MAX_FILE_BYTES)return null;
  const version=JSON.stringify([info.size,info.mtimeMs,info.ctimeMs]);
  if(version===fingerprint)return {file,fingerprint:version};
  const text=await readFile(absolute,"utf8");
  const extension=path.extname(absolute).toLowerCase();
  const language=extension ? getLanguageFromExtension(extension) : (chunkFileContent(absolute,file,text)[0]?.language??"text");
  return {file,fingerprint:version,language,text};
}
async function refresh(root,extraExtensions) {
  const db=store();
  const before=new Map(db.prepare("SELECT * FROM exact_files WHERE root=?").all(root).map(r=>[r.file,r]));
  const current=new Set();
  const changed=[];
  const warnings=[];
  const list=(await getIndexableFiles(root,extraExtensions??EXTRA_EXTENSIONS)).map(normal).sort();
  if(list.length>2000) throw Error("Laboratory limit is 2,000 files per exact index");
  for(let offset=0;offset<list.length;offset+=24){
    const batch=await Promise.all(list.slice(offset,offset+24).map(async file=>{
      try{return {file,info:await inspect(root,file,before.get(file)?.fingerprint)};}
      catch(error){return {file,error};}
    }));
    for(const {file,info,error} of batch){
      if(error){if(error.code!=="ENOENT")warnings.push(file+": "+String(error.code??error));continue;}
      if(!info)continue;
      current.add(file);
      if(info.text!==undefined)changed.push(info);
    }
  }
  const deleted=[...before.values()].filter(row=>!current.has(row.file));
  if(!changed.length&&!deleted.length)return warnings;
  const erase=db.prepare("DELETE FROM exact_grams WHERE rowid=?");
  const eraseFile=db.prepare("DELETE FROM exact_files WHERE id=?");
  const put=db.prepare("INSERT INTO exact_files(root,file,fingerprint,language) VALUES (?,?,?,?) ON CONFLICT(root,file) DO UPDATE SET fingerprint=excluded.fingerprint,language=excluded.language RETURNING id");
  const write=db.prepare("INSERT INTO exact_grams(rowid,text) VALUES (?,?)");
  db.exec("BEGIN IMMEDIATE");
  try{
    for(const {id} of deleted){erase.run(id);eraseFile.run(id);}
    for(const item of changed){
      const {id}=put.get(root,item.file,item.fingerprint,item.language);
      if(before.has(item.file))erase.run(id);
      write.run(id,item.text);
    }
    db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error;}
  return warnings;
}
async function exact(root,args){
  const query=args.query;
  if(!query.length||query.includes("\n")||query.includes("\r")||query.includes("\0"))
    throw Error("Exact mode accepts a nonempty, single-line literal");
  const scope=args.scope??"main";
  if(scope!=="main")throw Error("This laboratory exact index supports scope=main");
  const limit=args.limit??10;
  const db=store();
  if(!db.prepare("SELECT root FROM exact_ready WHERE root=?").get(root)){
    return createSearchPage(args,[],{status:"index_missing",partial:false,searchedSources:[],failedSources:[],skippedSources:[root],incompleteSources:[]},
      ["No codebase index found. Ask the user whether they want indexing and a code graph, then use codebase_setup."],0);
  }
  const warnings=currentChanges(root) ? ["File changes are being indexed; results may contain the previous snapshot."] : [];
  const grams=new Set();
  const chars=[...query];
  for(let i=0;i+2<chars.length;i++)grams.add(chars.slice(i,i+3).join(""));
  const expression=[...grams].map(x=>'"'+x.replaceAll('"','""')+'"').join(" AND ");
  const wanted=args.fileFilter?normal(args.fileFilter):null;
  const language=args.languageFilter??null;
  const params=[root,wanted,wanted,language,language];
  const where=" WHERE f.root=? AND (? IS NULL OR f.file=?) AND (? IS NULL OR f.language=?)";
  const rows=expression
    ?db.prepare("SELECT f.file,f.language FROM exact_grams JOIN exact_files f ON f.id=exact_grams.rowid"+where+" AND exact_grams MATCH ? ORDER BY f.file").all(...params,expression)
    :db.prepare("SELECT f.file,f.language FROM exact_files f"+where+" ORDER BY f.file").all(...params);
  const hits=[];
  for(const row of rows){
    if(hits.length===limit)break;
    try{
      const absolute=await realpath(path.resolve(root,row.file));
      const relative=path.relative(root,absolute);
      if(!relative||relative===".."||relative.startsWith(".."+path.sep)||path.isAbsolute(relative))continue;
      const lines=(await readFile(absolute,"utf8")).split(/\r?\n/);
      for(let i=0;i<lines.length&&hits.length<limit;i++){
        if(lines[i].includes(query))hits.push({relativePath:row.file,startLine:i+1,endLine:i+1,content:lines[i],score:1,language:row.language});
      }
    }catch(error){warnings.push(row.file+": "+String(error?.code??error));}
  }
  const partial=warnings.length>0;
  return createSearchPage(args,hits,{status:partial?"partial":hits.length?"ok":"empty",partial,searchedSources:[root],failedSources:[],skippedSources:[],incompleteSources:partial?[root]:[]},warnings,0);
}
async function serialize(root,run){
  const pending=queues.get(root)??Promise.resolve();
  const result=pending.catch(()=>{}).then(run);
  queues.set(root,result);
  try{return await result;}finally{if(queues.get(root)===result)queues.delete(root);}
}



export async function exactPage(args){
  const root=await realpath(args.projectPath);
  return serialize(root,()=>exact(root,args));
}
export async function refreshExactSnapshot(root,extraExtensions){
  const absolute=await realpath(root);
  return serialize(absolute,async()=>{
    const warnings=await refresh(absolute,extraExtensions);
    if(warnings.length)throw Error("Exact index refresh incomplete: "+warnings.join("; "));
    store().prepare("INSERT OR IGNORE INTO exact_ready VALUES (?)").run(absolute);
  });
}
