
import path from "node:path";
const changes=new Map();
const key=value=>process.platform==="win32"?path.resolve(value??process.cwd()).toLowerCase():path.resolve(value??process.cwd());
export function changePending(root){
  const p=key(root);
  changes.set(p,(changes.get(p)??0)+1);
}
export function currentChanges(root){return changes.get(key(root));}
export function publishChanges(root,generation){
  const p=key(root);
  if(changes.get(p)===generation)changes.delete(p);
}
export function withGraphFreshness(result,root){
  if(!currentChanges(root))return result;
  const note="File changes are being indexed; the graph may still contain the previous snapshot.";
  return {...result,text:note+"\n\n"+result.text,structuredContent:{...result.structuredContent,partial:true,
    warnings:[...(result.structuredContent?.warnings??[]),note]}};
}
