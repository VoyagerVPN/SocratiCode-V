
import { DatabaseSync } from "node:sqlite";
let graph;

function open(){
  const db=new DatabaseSync(process.env.PILOT_SQLITE_DB);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec("CREATE TABLE IF NOT EXISTS graph_namespace(name TEXT PRIMARY KEY) WITHOUT ROWID;"
    +"CREATE TABLE IF NOT EXISTS graph_record(namespace TEXT NOT NULL REFERENCES graph_namespace(name) ON DELETE CASCADE, id TEXT NOT NULL, generation TEXT, payload BLOB NOT NULL, PRIMARY KEY(namespace,id)) WITHOUT ROWID;"
    +"CREATE INDEX IF NOT EXISTS graph_generations ON graph_record(namespace,generation);");
  return db;
}
function selectPayload(row,selector){
  const point={id:row.id};
  if(selector===false)return point;
  const stored=JSON.parse(Buffer.from(row.payload).toString("utf8"));
  const keys=Array.isArray(selector)?selector:selector?.include;
  point.payload=keys
    ?Object.fromEntries(keys.filter(key=>Object.hasOwn(stored,key)).map(key=>[key,stored[key]]))
    :stored;
  return point;
}
export function sqliteGraph(){
  if(graph)return graph;
  const db=open();
  const create=db.prepare("INSERT OR IGNORE INTO graph_namespace VALUES (?)");
  const put=db.prepare("INSERT INTO graph_record VALUES (?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET generation=excluded.generation,payload=excluded.payload");
  const get=db.prepare("SELECT id,payload FROM graph_record WHERE namespace=? AND id=?");
  const erase=db.prepare("DELETE FROM graph_record WHERE namespace=? AND id=?");
  const page=db.prepare("SELECT id,payload FROM graph_record WHERE namespace=? AND id>=? ORDER BY id LIMIT ?");
  function txn(action){
    db.exec("BEGIN IMMEDIATE");
    try{action();db.exec("COMMIT");}
    catch(error){db.exec("ROLLBACK");throw error;}
  }
  graph={
    close(){db.close();graph=undefined;},
    async getCollections(){return {collections:db.prepare("SELECT name FROM graph_namespace ORDER BY name").all()};},
    async createCollection(name){create.run(name);return true;},
    async deleteCollection(name){db.prepare("DELETE FROM graph_namespace WHERE name=?").run(name);return true;},
    async upsert(name,{points}) {
      txn(()=>{
        for(const {id,payload} of points)
          put.run(name,String(id),typeof payload.generation==="string"?payload.generation:null,Buffer.from(JSON.stringify(payload)));
      });
    },
    async retrieve(name,{ids,with_payload}) {
      const result=[];
      for(const id of ids){
        const row=get.get(name,String(id));
        if(row)result.push(selectPayload(row,with_payload));
      }
      return result;
    },
    async delete(name,{points,filter}){
      if(points){txn(()=>{for(const id of points)erase.run(name,String(id));});return;}
      const rule=filter?.must?.[0];
      if(filter?.must?.length!==1)throw Error("Unexpected graph deletion filter");
      if(rule.is_empty?.key==="generation"){
        db.prepare("DELETE FROM graph_record WHERE namespace=? AND generation IS NULL").run(name);
      }else if(rule.key==="generation"&&typeof rule.match?.value==="string"){
        db.prepare("DELETE FROM graph_record WHERE namespace=? AND generation=?").run(name,rule.match.value);
      }else throw Error("Unexpected graph deletion field");
    },
    async scroll(name,{limit=10,offset,filter,with_payload}){
      if(filter)throw Error("Unexpected graph scroll filter");
      const rows=page.all(name,String(offset??""),limit+1);
      return {points:rows.slice(0,limit).map(row=>selectPayload(row,with_payload)),next_page_offset:rows[limit]?.id??null};
    },
  };
  return graph;
}
