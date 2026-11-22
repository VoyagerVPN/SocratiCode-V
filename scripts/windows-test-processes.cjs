// SPDX-License-Identifier: AGPL-3.0-only
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const { promisify } = require("node:util");

// Вывод автоматических проверок читается как текст, а не как терминал с ANSI-цветами.
if (!process.stdout.isTTY) {
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;
}

if (process.platform === "win32") {
  const originalExec = childProcess.exec;
  // Vite проверяет сетевые диски через оболочку; запускаем net.exe напрямую.
  childProcess.exec = function execWithoutNetworkDriveWindow(command, options, callback) {
    if (command !== "net use") return Reflect.apply(originalExec, this, arguments);
    const suppliedOptions = options !== null && typeof options === "object" ? options : {};
    const suppliedCallback = typeof options === "function" ? options : callback;
    return childProcess.execFile("net.exe", ["use"], {
      ...suppliedOptions, shell: false, windowsHide: true,
    }, suppliedCallback);
  };
  function hiddenArguments(method, args) {
    const hasArgumentList = !method.startsWith("exec") || method.startsWith("execFile");
    const optionsIndex = hasArgumentList && Array.isArray(args[1]) ? 2 : 1;
    const options = args[optionsIndex];
    if (options !== null && typeof options === "object") {
      args[optionsIndex] = { ...options, windowsHide: true };
    } else if (typeof options === "function") {
      args.splice(optionsIndex, 0, { windowsHide: true });
    } else {
      args[optionsIndex] = { windowsHide: true };
    }
    if (process.env.SOCRATICODE_PROCESS_TRACE) {
      require("node:fs").appendFileSync(process.env.SOCRATICODE_PROCESS_TRACE, JSON.stringify({
        at: new Date().toISOString(), pid: process.pid, method,
        executable: args[0] === "net use" ? args[0] : String(args[0]).split(/\s/)[0],
        stack: new Error("Child process origin").stack,
      }) + "\n");
    }
    return args;
  }
  // Защита применяется к тестам, общему HTTP-процессу и его Worker.
  for (const method of ["spawn", "spawnSync", "execFile", "execFileSync", "fork", "exec", "execSync"]) {
    const original = childProcess[method];
    const hidden = function hiddenProcess(...args) {
      return Reflect.apply(original, this, hiddenArguments(method, args));
    };
    if (method === "exec" || method === "execFile") {
      const custom = original[promisify.custom];
      // Сохраняем Node-контракт { stdout, stderr }, а не только первое значение callback.
      hidden[promisify.custom] = function hiddenPromise(...args) {
        if (custom) return Reflect.apply(custom, this, hiddenArguments(method, args));
        return new Promise((resolve, reject) => {
          Reflect.apply(hidden, this, [...args, (error, stdout, stderr) => {
            if (error) { reject(error); return; }
            resolve({ stdout, stderr });
          }]);
        });
      };
    }
    childProcess[method] = hidden;
  }
  syncBuiltinESMExports();
}
