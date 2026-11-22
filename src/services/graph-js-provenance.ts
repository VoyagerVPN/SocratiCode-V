// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import type { SymbolTargetScope } from "../types.js";
import type { PathAliases } from "./graph-aliases.js";
import type { GraphInputRecorder } from "./graph-inputs.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Источник npm определяется декларацией, а не сходством имени метода. node_modules не читается. */
export function createJsImportClassifier(
  projectPath: string, aliases: PathAliases, recorder?: GraphInputRecorder, projectFiles: readonly string[] = [],
): (sourceFile: string, specifier: string, resolved: string | null) => SymbolTargetScope {
  const manifests = new Map<string, Map<string, string>>();
  const localPackages = new Set<string>();
  const root = path.resolve(projectPath);
  function dependencies(directory: string): Map<string, string> {
    const cached = manifests.get(directory);
    if (cached) return cached;
    const manifest = path.join(directory, "package.json");
    let result: Map<string, string> | undefined;
    let raw: string | undefined;
    try { raw = fs.readFileSync(manifest, "utf8"); }
    catch { recorder?.unreadable(manifest); }
    if (raw !== undefined) {
      recorder?.read(manifest, raw);
      result = new Map();
      try {
        const value: unknown = JSON.parse(raw);
        if (record(value) && typeof value.name === "string") localPackages.add(value.name);
        if (record(value)) for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          const entries = value[field];
          if (record(entries)) for (const [name, version] of Object.entries(entries)) {
            if (typeof version === "string") result.set(name, version);
          }
        }
      } catch { /* Некорректный manifest не доказывает внешний пакет. */ }
    }
    result ??= directory === root ? new Map() : dependencies(path.dirname(directory));
    manifests.set(directory, result);
    return result;
  }
  // Только каталоги уже допущенных исходников: не обходим установленное содержимое пакетов.
  for (const file of projectFiles) dependencies(path.dirname(path.join(root, file)));
  return (sourceFile, specifier, resolved): SymbolTargetScope => {
    if (resolved) return "project";
    if (isBuiltin(specifier)) return "runtime";
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") ||
      [...aliases.entries.keys()].some((prefix) => specifier === prefix || specifier.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"))) return "project";
    const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (localPackages.has(packageName)) return "project";
    const version = dependencies(path.dirname(path.join(root, sourceFile))).get(packageName);
    if (version === undefined) return "unknown";
    return /^(workspace:|file:|link:)/.test(version) ? "project" : "external";
  };
}
