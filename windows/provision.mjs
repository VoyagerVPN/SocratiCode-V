import { constants } from "node:fs";
import { copyFile, link, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

const importFolder = process.argv[2];
if (!importFolder) throw new Error("Укажите подготовленный каталог с Windows-бинарниками и моделью Ollama");
const runtime = path.resolve(import.meta.dirname, "../runtime");

async function place(source, destination, immutable) {
  const info = await stat(source);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(source)) await place(path.join(source, name), path.join(destination, name), immutable);
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    if (immutable) {
      try { await link(source, destination); }
      catch (error) {
        if (!["EXDEV", "EPERM", "ENOTSUP"].includes(error.code)) throw error;
        await copyFile(source, destination, constants.COPYFILE_EXCL);
      }
    } else await copyFile(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await stat(destination)).size !== info.size) throw new Error(`В каталоге SCV уже есть другая версия ${destination}`);
  }
}

await place(process.execPath, path.join(runtime, "bin/node.exe"), false);
await place(path.join(importFolder, "bin/qdrant-1.20.2"), path.join(runtime, "bin/qdrant-1.20.2"), true);
await place(path.join(importFolder, "bin/ollama-0.40.19"), path.join(runtime, "bin/ollama-0.40.19"), true);
// Бинарники и адресуемые по SHA-256 веса можно разместить жёсткими ссылками NTFS.
await place(path.join(importFolder, "data/models/blobs"), path.join(runtime, "models/blobs"), true);
await place(path.join(importFolder, "data/models/manifests"), path.join(runtime, "models/manifests"), false);
console.log(`Среда Windows подготовлена в ${runtime}`);
