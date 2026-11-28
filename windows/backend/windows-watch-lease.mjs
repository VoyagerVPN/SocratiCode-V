
import { createHash } from "node:crypto";
import { createConnection,createServer } from "node:net";
import path from "node:path";
if(process.platform!=="win32")throw Error("This SocratiCode V pilot requires Windows");
export function useWindowsWatchLease(operation="watch"){
  return operation==="watch";
}
function endpoint(file){
  const identity=createHash("sha256").update(path.resolve(file).toLowerCase()).digest("hex").slice(0,32);
  return "\\\\.\\pipe\\socraticode-watch-"+identity;
}
export async function windowsWatchHeld(file){
  return new Promise((resolve,reject)=>{
    const probe=createConnection(endpoint(file));
    probe.once("connect",()=>{probe.destroy();resolve(true);});
    probe.once("error",error=>{
      if(error.code==="ENOENT"||error.code==="ECONNREFUSED")resolve(false);
      else reject(error);
    });
    probe.setTimeout(1000,()=>{probe.destroy();reject(Error("Watcher lease probe timed out"));});
  });
}
export async function acquireWindowsWatchLease(file,onLost){
  const server=createServer(peer=>peer.destroy());
  let closing=false;
  const acquire=await new Promise((resolve,reject)=>{
    function failed(error){
      server.removeListener("listening",listening);
      if(error.code==="EADDRINUSE")resolve(false);
      else reject(error);
    }
    function listening(){
      server.removeListener("error",failed);
      resolve(true);
    }
    server.once("error",failed);
    server.once("listening",listening);
    server.listen(endpoint(file));
  });
  if(!acquire)return null;
  // Канал привязан к жизни процесса. Через него не передаются данные.
  server.on("error",error=>{if(!closing)onLost?.(error);});
  server.on("close",()=>{if(!closing)onLost?.(Error("Watcher lease closed unexpectedly"));});
  server.unref();
  return async function release(){
    closing=true;
    if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  };
}
