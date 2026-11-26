// SPDX-License-Identifier: AGPL-3.0-only
import type { SgNode } from "@ast-grep/napi";
import type { SymbolEdge, SymbolNode } from "../types.js";
import { type cppBindings, cppProject } from "./graph-cpp.js";

interface SourcePoint { functionStart: number; offset: number; }

function point(node: SgNode): SourcePoint {
  const fn = node.ancestors().find(n => n.kind() === "function_definition");
  return { functionStart: fn?.range().start.index ?? -1, offset: node.range().start.index };
}

type FeatureEvidence =
  | { kind: "register"; key: string; at: SourcePoint }
  | { kind: "mutation"; key?: string; at: SourcePoint }
  | { kind: "dispatch"; at: SourcePoint; key: string; iface: string; method: string; returned: boolean }
  | { kind: "construct"; type: string }
  | { kind: "invoke"; at: SourcePoint; factoryOwner: string; factoryMethod: string; method: string };

export interface FeatureSite { symbol: SymbolNode; line: number; evidence: FeatureEvidence; }

function named(n?: SgNode | null) {
  return n?.children().filter(c => c.isNamed() && c.kind() !== "comment") ?? [];
}

function keyOf(arg?: SgNode) {
  if (!arg) return;
  if (arg.kind() === "string_literal") return arg.text();
  const fn = arg.field("function")?.text();
  const args = named(arg.field("arguments"));
  if (fn === "TEXT" && args.length === 1 && args[0].kind() === "string_literal") return args[0].text();
  if (fn && /^(?:\w+::)*\w+$/.test(fn) && !args.length) return fn + "()";
}

function typeName(text?: string) {
  if (text && /^(?:\w+::)*\w+$/.test(text)) return text.split("::").pop();
}

function contains(outer: SgNode, inner: SgNode) {
  const range = outer.range();
  return range.start.index <= inner.range().start.index && inner.range().end.index <= range.end.index;
}

const loops = new Set(["for_statement", "for_range_loop", "while_statement", "do_statement"]);
const conditionalScopes = new Set(["if_statement", "switch_statement", "case_statement", "conditional_expression",
  "lambda_expression", "try_statement", "catch_clause", ...loops]);

// Ветвление с неизвестным исходом обрывает цепочку. У копии сохраняется значение на момент присваивания.
export function cppValueSource(root: SgNode, lookup: ReturnType<typeof cppBindings>) {
  type Write = { end: number; value?: SgNode | null; guards: SgNode[]; loops: SgNode[] };
  const writes = new Map<number, Write[]>();
  for (const assignment of root.findAll({ rule: { kind: "assignment_expression" } })) {
    const left = assignment.field("left");
    const variable = left?.kind() === "subscript_expression" ? left.field("argument") : left;
    if (variable?.kind() !== "identifier") continue;
    let binding = lookup(variable.text(), variable);
    while (binding?.reference && binding.initializer?.kind() === "identifier") {
      const init = binding.initializer;
      const referent = lookup(init.text(), init);
      binding = referent && referent.start < binding.start ? referent : undefined;
    }
    if (!binding) continue;
    let child = assignment;
    const guards: SgNode[] = [];
    const enclosingLoops: SgNode[] = [];
    for (const parent of assignment.ancestors()) {
      if (parent.kind() === "function_definition") break;
      if (loops.has(String(parent.kind()))) enclosingLoops.push(parent);
      if (conditionalScopes.has(String(parent.kind())) ||
          (parent.kind() === "binary_expression" && ["&&", "||"].includes(parent.field("operator")?.text() ?? ""))) guards.push(child);
      child = parent;
    }
    const value = left?.kind() === "identifier" && assignment.field("operator")?.text() === "=" ? assignment.field("right") : undefined;
    const list = writes.get(binding.start) ?? [];
    list.push({ end: assignment.range().end.index, value, guards, loops: enclosingLoops });
    writes.set(binding.start, list);
  }
  for (const list of writes.values()) list.sort((a, b) => b.end - a.end);

  return function origin(expression?: SgNode | null): SgNode | undefined {
    let node = expression;
    let use = expression;
    const visited = new Set<number>();
    while (node?.kind() === "identifier" && use) {
      const binding = lookup(node.text(), node);
      if (!binding || visited.has(binding.start)) return;
      visited.add(binding.start);
      const position = use;
      const lambda = use.ancestors().find(a => {
        if (a.kind() !== "lambda_expression" || a.range().start.index <= binding.start) return false;
        const body = a.field("body");
        return body && contains(body, position);
      });
      if (lambda) {
        const capture = named(lambda.children().find(c => c.kind() === "lambda_capture_specifier"))
          .find(c => c.kind() === "lambda_capture_initializer" && c.field("left")?.text() === node?.text());
        if (capture) {
          let value = capture.field("right");
          if (value?.field("function")?.text() === "MoveTemp") value = named(value.field("arguments"))[0];
          if (value?.kind() !== "identifier" || value.text() !== node.text()) return;
          if (writes.get(binding.start)?.some(w => w.end > value.range().end.index && w.end <= position.range().start.index)) return;
          use = value;
        }
      }
      if (binding.reference && binding.initializer?.kind() === "identifier") {
        node = binding.initializer;
        continue;
      }
      const at = use;
      const history = writes.get(binding.start);
      const offset = at.range().start.index;
      const write = history?.find(w => w.end <= offset);
      const lastDefinition = write?.end ?? binding.start;
      if (history?.some(w => w.end > offset && w.loops.some(loop => loop.range().start.index > lastDefinition && contains(loop, at)))) return;
      if (write && !write.guards.every(guard => contains(guard, at))) return;
      node = write ? write.value : binding.initializer;
      use = node;
    }
    return node ?? undefined;
  };
}

export function featureEvidence(n: SgNode, origin: ReturnType<typeof cppValueSource>): FeatureEvidence | undefined {
  const fn = n.field("function");
  const receiver = origin(fn?.field("argument"));
  const field = fn?.field("field");
  const parent = n.parent();
  const isRegistry = (node?: SgNode | null) => node?.field("function")?.text() === "IModularFeatures::Get";
  const op = field?.text();
  if ((op === "RegisterModularFeature" || op === "UnregisterModularFeature") && isRegistry(receiver)) {
    const args = named(n.field("arguments"));
    const key = keyOf(origin(args[0]));
    const at = point(n);
    if (op === "RegisterModularFeature" && key && args[1]?.text() === "this") return { kind: "register", key, at };
    return { kind: "mutation", key, at };
  }
  if (parent?.kind() === "return_statement" && fn?.field("name")?.text() === "MakeShared") {
    const type = typeName(named(fn.field("arguments"))[0]?.text());
    if (type) return { kind: "construct", type };
  }
  if (field?.kind() !== "field_identifier") return;
  if (receiver?.kind() === "subscript_expression") {
    const collection = origin(receiver.field("argument"));
    const getter = collection?.field("function");
    const method = getter?.field("field");
    if (method?.field("name")?.text() !== "GetModularFeatureImplementations" || !isRegistry(origin(getter?.field("argument")))) return;
    const iface = typeName(named(method.field("arguments"))[0]?.text());
    const key = keyOf(origin(named(collection?.field("arguments"))[0]));
    if (collection && iface && key) return { kind: "dispatch", at: point(collection), iface, key, method: field.text(), returned: parent?.kind() === "return_statement" };
  }
  const factory = receiver?.field("function");
  if (factory?.kind() === "qualified_identifier") {
    const owner = typeName(factory.field("scope")?.text());
    const method = factory.field("name")?.text();
    if (receiver && owner && method) return { kind: "invoke", at: point(receiver), factoryOwner: owner, factoryMethod: method, method: field.text() };
  }
}

export function connectFeatureSites(sites: FeatureSite[], files: Map<string, SymbolNode[]>, edges: Map<string, SymbolEdge[]>,
  scope: (file: string) => string = cppProject) {
  if (!sites.some(s => s.evidence.kind === "dispatch")) return;
  const symbols = [...files.values()].flat().filter(s => s.language === "cpp");
  const methods = new Map<string, SymbolNode[]>();
  const classes = new Map<string, SymbolNode[]>();
  const id = (file: string, owner: string, name: string) => JSON.stringify([scope(file), owner, name]);
  for (const s of symbols) {
    if (!s.cppOwner && s.kind !== "class" && s.kind !== "struct") continue;
    const map = s.cppOwner ? methods : classes;
    const key = id(s.file, s.cppOwner ?? s.name, s.cppOwner ? s.name : "");
    map.set(key, [...(map.get(key) ?? []), s]);
  }
  const targets = new Map<FeatureSite, Set<SymbolNode>>();
  const products = new Map<string, Array<{ type: string; iface: string; key: string }>>();
  function record(site: FeatureSite, candidates: SymbolNode[]) {
    const set = targets.get(site) ?? new Set();
    for (const s of candidates) set.add(s);
    if (set.size) targets.set(site, set);
  }
  const groups = new Map<FeatureEvidence["kind"], FeatureSite[]>();
  for (const site of sites) {
    const key = site.evidence.kind;
    const list = groups.get(key);
    if (list) list.push(site);
    else groups.set(key, [site]);
  }
  const mutations = new Map<string, Array<{ key?: string; offset: number }>>();
  const location = (file: string, at: SourcePoint) => JSON.stringify([file, at.functionStart]);
  for (const site of sites) {
    const e = site.evidence;
    if (e.kind !== "register" && e.kind !== "mutation") continue;
    const id = location(site.symbol.file, e.at);
    const list = mutations.get(id) ?? [];
    list.push({ key: e.key, offset: e.at.offset });
    mutations.set(id, list);
  }
  function registryChanged(file: string, at: SourcePoint, iface: string, key: string) {
    const bare = (name: string) => name.startsWith(iface + "::") ? name.slice(iface.length + 2) : name;
    return mutations.get(location(file, at))?.some(m => m.offset < at.offset && (!m.key || bare(m.key) === bare(key)));
  }
  for (const dispatch of groups.get("dispatch") ?? []) {
    const l = dispatch.evidence;
    if (l.kind !== "dispatch" || registryChanged(dispatch.symbol.file, l.at, l.iface, l.key)) continue;
    for (const reg of groups.get("register") ?? []) {
      const r = reg.evidence;
      const owner = reg.symbol.cppOwner;
      if (r.kind !== "register" || !owner || scope(reg.symbol.file) !== scope(dispatch.symbol.file)) continue;
      const impl = classes.get(id(reg.symbol.file, owner, ""));
      if (impl?.length !== 1 || !impl[0].cppBases?.includes(l.iface)) continue;
      const canonicalKey = (s: string) => s.replace(l.iface + "::", "");
      if (canonicalKey(l.key) !== canonicalKey(r.key)) continue;
      if (!r.key.startsWith('"') && !r.key.includes("::")) {
        const fn = r.key.slice(0, -2);
        if (dispatch.symbol.cppOwner !== l.iface || methods.has(id(reg.symbol.file, owner, fn)) || !methods.has(id(reg.symbol.file, l.iface, fn))) continue;
      }
      const candidates = methods.get(id(reg.symbol.file, owner, l.method)) ?? [];
      record(dispatch, candidates);
      if (!l.returned || !dispatch.symbol.cppOwner) continue;
      const key = id(dispatch.symbol.file, dispatch.symbol.cppOwner, dispatch.symbol.name);
      const result = products.get(key) ?? [];
      for (const c of groups.get("construct") ?? []) {
        if (c.evidence.kind !== "construct" || !candidates.some(m => m.id === c.symbol.id)) continue;
        const type = classes.get(id(c.symbol.file, c.evidence.type, ""));
        if (type?.length !== 1) continue;
        result.push({ type: c.evidence.type, iface: l.iface, key: l.key });
        record(c, type);
      }
      products.set(key, result);
    }
  }
  for (const invoke of groups.get("invoke") ?? []) {
    const e = invoke.evidence;
    if (e.kind !== "invoke") continue;
    const types = products.get(id(invoke.symbol.file, e.factoryOwner, e.factoryMethod));
    for (const product of types ?? []) {
      if (registryChanged(invoke.symbol.file, e.at, product.iface, product.key)) continue;
      record(invoke, methods.get(id(invoke.symbol.file, product.type, e.method)) ?? []);
    }
  }
  for (const [site, candidates] of targets) {
    const outgoing = edges.get(site.symbol.file);
    if (!outgoing) continue;
    const [first] = candidates;
    const constructs = site.evidence.kind === "construct";
    const existing = outgoing.find(e => e.callerId === site.symbol.id && e.callSite.line === site.line && e.calleeName === first.name && !e.calleeCandidates.length);
    const edge: SymbolEdge = { callerId: site.symbol.id, calleeName: first.name, calleeCandidates: [...candidates].map(s => s.id),
      confidence: candidates.size === 1 ? "unique" : "multiple-candidates", kind: constructs ? "type_reference" : "call", targetScope: "project",
      cpp: { label: constructs ? "MakeShared" : "IModularFeatures: candidate" }, callSite: { file: site.symbol.file, line: site.line } };
    if (existing) Object.assign(existing, edge);
    else outgoing.push(edge);
  }
}
