
export async function prepareLease(patch){
  await patch("services/lock.js",[
    ['import lockfile from "proper-lockfile";','import lockfile from "proper-lockfile";\nimport { acquireWindowsWatchLease, useWindowsWatchLease, windowsWatchHeld } from "../../windows-watch-lease.mjs";'],
    ['    try {\n        const release = await lockfile.lock(filePath, {',
`    try {
        if (useWindowsWatchLease(operation)) {
            const release = await acquireWindowsWatchLease(filePath, error => {
                logger.warn("Watcher lease was lost", { projectPath, error: error.message });
                void Promise.resolve().then(() => onCompromised?.(error)).catch(cause => {
                    logger.warn("Watcher lease loss handler failed", { projectPath, error: String(cause) });
                });
            });
            if (!release) return false;
            let retained = false;
            try {
                // Старый сервер может удерживать собственную файловую блокировку.
                if (await lockfile.check(filePath, { stale: STALE_MS, realpath: false })) return false;
                fs.writeFileSync(filePath, String(process.pid) + "\\n", "utf8");
                heldLocks.set(key, release);
                retained = true;
                return true;
            } finally {
                if (!retained) await release();
            }
        }
        const release = await lockfile.lock(filePath, {`],
    ['        const filePath = lockFilePath(identityLockKey(projectId, operation));\n        try {',
     '        const filePath = lockFilePath(identityLockKey(projectId, operation));\n        if (useWindowsWatchLease(operation) && await windowsWatchHeld(filePath)) return true;\n        try {'],
    ['        const locked = await lockfile.check(filePath, { stale: STALE_MS, realpath: false });',
     '        const locked = await isProjectIdentityLocked(projectIdFromPath(path.resolve(projectPath)), operation);'],
  ]);
  await patch("services/watcher.js",[
    ['import { changePending, currentChanges, publishChanges } from "../../watch-state.mjs";',
     'import { changePending, currentChanges, publishChanges } from "../../watch-state.mjs";\nimport { useWindowsWatchLease } from "../../windows-watch-lease.mjs";'],
    ['const EXTERNAL_WATCH_CACHE_TTL_MS = 60_000;','const EXTERNAL_WATCH_CACHE_TTL_MS = useWindowsWatchLease() ? 1_000 : 60_000;'],
    ['    const lockAcquired = await acquireProjectLock(resolvedPath, "watch", undefined, { reentrant: false });',
     '    const lockAcquired = await acquireProjectLock(resolvedPath, "watch", () => stopWatching(resolvedPath), { reentrant: false });'],
  ]);
}
