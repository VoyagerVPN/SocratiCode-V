// SPDX-License-Identifier: AGPL-3.0-only
import { posix as path } from "node:path";
import { type Lang, parse, type SgNode } from "@ast-grep/napi";
import type { CodeGraphEdge, CodeGraphNode } from "../types.js";

export const isUnrealDescriptor = (file: string) => /\.(uproject|uplugin)$/i.test(file);
const buildRule = /\.Build\.cs$/i;
const targetRule = /\.Target\.cs$/i;
export const isUnrealRule = (file: string) => buildRule.test(file) || targetRule.test(file);

function nearest<T>(file: string, roots: Map<string, T>): T | undefined {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (roots.has(dir)) return roots.get(dir);
    if (dir === path.dirname(dir)) return;
  }
}

function childNodes(node?: SgNode | null) {
  return node?.children().filter(n => n.isNamed() && n.kind() !== "comment") ?? [];
}

function literal(node?: SgNode): string | undefined {
  if (node?.kind() !== "string_literal") return;
  try { return JSON.parse(node.text()); } catch { return; }
}

function argumentsOf(node: SgNode) {
  return childNodes(node.field("arguments")).map(arg => childNodes(arg)[0]);
}

function parseRules(source: string, dir: string, plugin?: string) {
  const deps = new Map<string, string>();
  const roots = new Map<string, string>();
  let root: SgNode;
  try {
    root = parse("csharp" as Lang, source).root();
  } catch {
    // Без необязательной C#-грамматики доступны дескрипторы и принадлежность файлов.
    return { deps, roots };
  }
  for (const call of root.findAll({ rule: { kind: "invocation_expression" } })) {
    const member = call.field("function");
    const list = member?.field("expression")?.text().replace(/^this\./, "");
    const op = member?.field("name")?.text();
    if (!list || !op || !["Add", "AddRange"].includes(op)) continue;
    const args = argumentsOf(call);
    if (args.length !== 1 || !args[0]) continue;
    const arg = args[0];
    const init = childNodes(arg).find(n => n.kind() === "initializer_expression");
    const values = op === "Add" ? [arg] : childNodes(init);
    if (["PrivateDependencyModuleNames", "PublicDependencyModuleNames", "ExtraModuleNames"].includes(list)) {
      for (const value of values) {
        const name = literal(value);
        if (name && deps.get(name) !== "PublicDependencyModuleNames") deps.set(name, list);
      }
    } else if (["PrivateIncludePaths", "PublicIncludePaths"].includes(list)) {
      for (const value of values) {
        if (value.field("function")?.text() !== "Path.Combine") continue;
        const [base, ...segments] = argumentsOf(value);
        const start = base?.text() === "ModuleDirectory" ? dir : base?.text() === "PluginDirectory" ? plugin : undefined;
        const parts = segments.map(literal);
        if (start && parts.every((s): s is string => typeof s === "string")) roots.set(path.join(start, ...parts), list);
      }
    }
  }
  return { deps, roots };
}

interface Descriptor {
  Modules?: { Name?: string; Type?: string; LoadingPhase?: string }[];
  Plugins?: { Name?: string; Enabled?: boolean }[];
  EnabledByDefault?: boolean;
}

export function linkUnrealModules(sources: Map<string, string>, nodes: Map<string, CodeGraphNode>, edges: CodeGraphEdge[]) {
  if (!sources.size) return;
  const projects = new Map<string, string>();
  const plugins = new Map<string, string>();
  const descriptors = new Map<string, Descriptor>();
  for (const [file, source] of sources) {
    if (!isUnrealDescriptor(file)) continue;
    (/\.uproject$/i.test(file) ? projects : plugins).set(path.dirname(file), file);
    try {
      const value = JSON.parse(source.replace(/^\uFEFF/, ""));
      if (value && typeof value === "object") descriptors.set(file, value);
    } catch { /* Повреждённый дескриптор остаётся узлом без объявленных связей. */ }
  }
  const descriptorRoots = new Map([...projects, ...plugins]);
  function domain(file: string) {
    const project = nearest(file, projects);
    const plugin = nearest(file, plugins);
    if (plugin && (!project || !path.relative(path.dirname(project), plugin).startsWith("Plugins/"))) return plugin;
    const src = file.lastIndexOf("/Source/");
    return project ?? (src >= 0 ? file.slice(0, src) : ".");
  }
  function link(from: string, to: string, relation: string, spec?: string) {
    const a = nodes.get(from);
    const b = nodes.get(to);
    if (!a || !b || a === b) return;
    if (!a.dependencies.includes(to)) {
      a.dependencies.push(to);
      b.dependents.push(from);
      edges.push({ source: from, target: to, type: "import" });
    }
    a.unrealRelations ??= {};
    a.unrealRelations[to] = relation;
    if (spec) {
      a.importTargets ??= {};
      a.importTargets[spec] = to;
      a.importScopes ??= {};
      a.importScopes[spec] = "project";
    }
  }
  const rules = new Map<string, ReturnType<typeof parseRules>>();
  const owners = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const key = (file: string, name: string) => JSON.stringify([domain(file), name.toLowerCase()]);
  for (const [file, source] of sources) {
    if (!isUnrealRule(file)) continue;
    const plugin = nearest(file, plugins);
    rules.set(file, parseRules(source, path.dirname(file), plugin && path.dirname(plugin)));
    if (!buildRule.test(file)) continue;
    owners.set(path.dirname(file), file);
    const id = key(file, path.basename(file).replace(buildRule, ""));
    byName.set(id, [...(byName.get(id) ?? []), file]);
  }
  for (const [file, desc] of descriptors) {
    for (const m of Array.isArray(desc.Modules) ? desc.Modules : []) {
      if (typeof m?.Name !== "string") continue;
      const candidates = byName.get(key(file, m.Name)) ?? [];
      const local = candidates.filter(rule => nearest(rule, descriptorRoots) === file &&
        path.relative(path.dirname(file), rule).startsWith("Source/"));
      if (local.length === 1) link(file, local[0], ["module", m.Type, m.LoadingPhase].filter(Boolean).join(" / "));
    }
    if (!/\.uproject$/i.test(file)) continue;
    for (const plugin of plugins.values()) {
      if (domain(plugin) !== file) continue;
      const name = path.basename(plugin, path.extname(plugin));
      const entry = Array.isArray(desc.Plugins) ? desc.Plugins.find(p => p?.Name === name) : undefined;
      if (entry?.Enabled === true || (entry?.Enabled === undefined && descriptors.get(plugin)?.EnabledByDefault === true)) {
        link(file, plugin, entry ? "plugin (enabled)" : "plugin (enabled by default)");
      }
    }
  }
  const dependencies = new Map<string, Map<string, string>>();
  for (const [file, rule] of rules) {
    const resolved = new Map<string, string>();
    for (const [name, visibility] of rule.deps) {
      const matches = byName.get(key(file, name));
      if (matches?.length !== 1) continue;
      resolved.set(matches[0], visibility);
      link(file, matches[0], visibility);
    }
    dependencies.set(file, resolved);
  }
  const searchRoots = new Map<string, Set<string>>();
  function includeRoots(owner: string) {
    let roots = searchRoots.get(owner);
    if (roots) return roots;
    roots = new Set([path.join(path.dirname(owner), "Public"), path.join(path.dirname(owner), "Private")]);
    for (const dir of rules.get(owner)?.roots.keys() ?? []) roots.add(dir);
    const seen = new Set([owner]);
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      roots.add(path.join(path.dirname(file), "Public"));
      for (const [dir, vis] of rules.get(file)?.roots ?? []) if (vis === "PublicIncludePaths") roots.add(dir);
      for (const [dep, vis] of dependencies.get(file) ?? []) if (vis === "PublicDependencyModuleNames") visit(dep);
    };
    for (const dep of dependencies.get(owner)?.keys() ?? []) visit(dep);
    searchRoots.set(owner, roots);
    return roots;
  }
  for (const [file, node] of nodes) {
    if (!/\.(h|hpp|inl|c|cc|cpp|cxx)$/i.test(file)) continue;
    const owner = nearest(file, owners);
    if (!owner) continue;
    node.unrealModule = owner;
    node.unrealDomain = domain(file);
    for (const spec of node.imports) {
      if (node.importTargets?.[spec] || path.isAbsolute(spec) || spec.startsWith("..")) continue;
      const matches = [...includeRoots(owner)].map(dir => path.join(dir, spec)).filter(p => nodes.has(p));
      if (matches.length === 1) link(file, matches[0], "UBT include", spec);
    }
  }
}
