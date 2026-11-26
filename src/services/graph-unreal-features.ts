// SPDX-License-Identifier: AGPL-3.0-only
import type { SgNode } from "@ast-grep/napi";
import type { SymbolEdge, SymbolNode } from "../types.js";
import { type cppBindings, cppProject } from "./graph-cpp.js";

type FeatureEvidence =
  | { kind: "register"; key: string }
  | { kind: "lookup"; key: string; iface: string; declaration: number }
  | { kind: "dispatch"; declaration: number; method: string; returned: boolean }
  | { kind: "construct"; type: string }
  | { kind: "receive"; owner: string; method: string; declaration: number }
  | { kind: "invoke"; declaration: number; method: string };

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

export function featureEvidence(n: SgNode, lookup: ReturnType<typeof cppBindings>): FeatureEvidence | undefined {
  const fn = n.field("function");
  const receiver = fn?.field("argument");
  const field = fn?.field("field");
  const parent = n.parent();
  const decl = parent?.kind() === "init_declarator" ? parent.parent() : undefined;
  const declaration = decl?.kind() === "declaration" ? decl.range().start.index : undefined;
  if (receiver?.field("function")?.text() === "IModularFeatures::Get") {
    const args = named(n.field("arguments"));
    const key = keyOf(args[0]);
    if (!key) return;
    if (field?.text() === "RegisterModularFeature" && args[1]?.text() === "this") return { kind: "register", key };
    if (field?.field("name")?.text() === "GetModularFeatureImplementations" && declaration !== undefined) {
      const iface = typeName(named(field.field("arguments"))[0]?.text());
      if (iface) return { kind: "lookup", key, iface, declaration };
    }
  }
  if (receiver?.kind() === "subscript_expression") {
    const array = receiver.field("argument");
    const binding = array?.kind() === "identifier" && lookup(array.text(), n);
    if (binding && field?.kind() === "field_identifier") return { kind: "dispatch", declaration: binding.start, method: field.text(), returned: parent?.kind() === "return_statement" };
  }
  if (parent?.kind() === "return_statement" && fn?.field("name")?.text() === "MakeShared") {
    const type = typeName(named(fn.field("arguments"))[0]?.text());
    if (type) return { kind: "construct", type };
  }
  if (declaration !== undefined && fn?.kind() === "qualified_identifier") {
    const owner = typeName(fn.field("scope")?.text());
    const method = fn.field("name")?.text();
    if (owner && method) return { kind: "receive", owner, method, declaration };
  }
  if (receiver?.kind() === "identifier" && field?.kind() === "field_identifier") {
    const binding = lookup(receiver.text(), n);
    if (!binding?.factory) return;
    for (const lambda of n.ancestors().filter(a => a.kind() === "lambda_expression" && a.range().start.index > binding.start)) {
      const captures = lambda.children().find(c => c.kind() === "lambda_capture_specifier");
      const init = named(captures).find(c => c.kind() === "lambda_capture_initializer" && named(c)[0]?.text() === receiver.text());
      if (!init) continue;
      const value = named(init)[1];
      if (value?.text() === receiver.text()) continue;
      if (value?.field("function")?.text() !== "MoveTemp" || named(value.field("arguments"))[0]?.text() !== receiver.text()) return;
    }
    return { kind: "invoke", declaration: binding.start, method: field.text() };
  }
}

export function connectFeatureSites(sites: FeatureSite[], files: Map<string, SymbolNode[]>, edges: Map<string, SymbolEdge[]>,
  scope: (file: string) => string = cppProject) {
  if (!sites.some(s => s.evidence.kind === "lookup")) return;
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
  const products = new Map<string, Set<string>>();
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
  for (const lookup of groups.get("lookup") ?? []) {
    const l = lookup.evidence;
    if (l.kind !== "lookup") continue;
    for (const reg of groups.get("register") ?? []) {
      const r = reg.evidence;
      const owner = reg.symbol.cppOwner;
      if (r.kind !== "register" || !owner || scope(reg.symbol.file) !== scope(lookup.symbol.file)) continue;
      const impl = classes.get(id(reg.symbol.file, owner, ""));
      if (impl?.length !== 1 || !impl[0].cppBases?.includes(l.iface)) continue;
      const canonicalKey = (s: string) => s.replace(l.iface + "::", "");
      if (canonicalKey(l.key) !== canonicalKey(r.key)) continue;
      if (!r.key.startsWith('"') && !r.key.includes("::")) {
        const fn = r.key.slice(0, -2);
        if (lookup.symbol.cppOwner !== l.iface || methods.has(id(reg.symbol.file, owner, fn)) || !methods.has(id(reg.symbol.file, l.iface, fn))) continue;
      }
      for (const dispatch of groups.get("dispatch") ?? []) {
        const d = dispatch.evidence;
        if (d.kind !== "dispatch" || dispatch.symbol.id !== lookup.symbol.id || d.declaration !== l.declaration) continue;
        const candidates = methods.get(id(reg.symbol.file, owner, d.method)) ?? [];
        record(dispatch, candidates);
        if (!d.returned || !lookup.symbol.cppOwner) continue;
        const key = id(lookup.symbol.file, lookup.symbol.cppOwner, lookup.symbol.name);
        const result = products.get(key) ?? new Set();
        for (const c of groups.get("construct") ?? []) {
          if (c.evidence.kind !== "construct" || !candidates.some(m => m.id === c.symbol.id)) continue;
          const type = classes.get(id(c.symbol.file, c.evidence.type, ""));
          if (type?.length !== 1) continue;
          result.add(c.evidence.type);
          record(c, type);
        }
        products.set(key, result);
      }
    }
  }
  for (const receive of groups.get("receive") ?? []) {
    const r = receive.evidence;
    if (r.kind !== "receive") continue;
    const types = products.get(id(receive.symbol.file, r.owner, r.method));
    if (!types?.size) continue;
    for (const invoke of groups.get("invoke") ?? []) {
      const e = invoke.evidence;
      if (e.kind !== "invoke" || invoke.symbol.file !== receive.symbol.file || e.declaration !== r.declaration) continue;
      for (const type of types) record(invoke, methods.get(id(invoke.symbol.file, type, e.method)) ?? []);
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
