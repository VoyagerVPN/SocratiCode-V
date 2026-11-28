// SPDX-License-Identifier: AGPL-3.0-only
import type { SgNode } from "@ast-grep/napi";
import type { CppCall, SymbolEdge, SymbolNode } from "../types.js";

export function cppType(text: string): string | undefined {
  const container = /^(TQueue|TSet|TArray)\s*</.exec(text);
  if (container) return container[1];
  const type = text.match(/^(?:T(?:Object|WeakObject|Unique|Shared|Pimpl)Ptr<([\w:]+)>|([\w:]+))$/);
  return (type?.[1] ?? type?.[2])?.split("::").pop();
}

function declaration(node: SgNode) {
  const type = node.field("type")?.text();
  let decl = node.field("declarator");
  const value = decl?.field("value");
  while (decl && ["reference_declarator", "pointer_declarator", "init_declarator"].includes(String(decl.kind()))) {
    decl = decl.field("declarator") ?? decl.children().find(n => n.isNamed()) ?? null;
  }
  if (!decl || !["identifier", "field_identifier"].includes(String(decl.kind())) || !type) return;
  const initializer = type === "auto" ? value?.text().replace(/\s+/g, "") : undefined;
  const inferred = type === "auto"
    ? initializer?.match(/(?:->|\.)GetSubsystem<([\w:]+)>\(\)$/)?.[1]
      ?? initializer?.match(/^(?:this->)?GetWorld\(\)->GetGameState<([\w:]+)>\(\)$/)?.[1]
    : type;
  return { name: decl.text(), initializer: value, reference: node.field("declarator")?.field("declarator")?.kind() === "reference_declarator", type: inferred ? cppType(inferred) : undefined };
}

export function cppClassFields(cls: SgNode): Record<string, string> | undefined {
  const fields: Record<string, string> = Object.create(null);
  for (const node of cls.field("body")?.children() ?? []) {
    if (node.kind() !== "field_declaration") continue;
    const field = declaration(node);
    if (field?.type) fields[field.name] = field.type;
  }
  return Object.keys(fields).length ? fields : undefined;
}

export function cppBindings(root: SgNode) {
  const bindings = new Map<string, { type?: string; initializer?: SgNode | null; reference: boolean; start: number; end: number }[]>();
  for (const kind of ["parameter_declaration", "declaration", "for_range_loop"]) {
    for (const node of root.findAll({ rule: { kind } })) {
      const value = declaration(node);
      if (!value) continue;
      const scope = kind === "for_range_loop" ? node : node.ancestors().find(n => (
        kind === "parameter_declaration" ? ["function_definition", "lambda_expression", "field_declaration", "declaration"].includes(String(n.kind())) :
          ["compound_statement", "for_statement", "if_statement", "translation_unit"].includes(String(n.kind()))));
      if (!scope) continue;
      const list = bindings.get(value.name) ?? [];
      list.push({ type: value.type, initializer: value.initializer, reference: value.reference, start: node.range().start.index, end: scope.range().end.index });
      bindings.set(value.name, list);
    }
  }
  return (name: string, call: SgNode) => {
    const position = call.range().start.index;
    return bindings.get(name)?.filter(b => b.start <= position && position < b.end)
      .sort((a,b) => b.start - a.start)[0];
  };
}

// Вложенная копия проекта может содержать одноимённый класс.
export function cppProject(file: string): string {
  const parts = file.split("/");
  const at = Math.max(parts.lastIndexOf("Source"), parts.lastIndexOf("Config"));
  return at < 0 ? "" : parts.slice(0, at).join("/");
}

export function cppDelegateTypes(root: SgNode): string[] {
  const names = new Set<string>();
  for (const node of root.findAll({ rule: { kind: "identifier", regex: "^DECLARE_MULTICAST_DELEGATE(_[A-Za-z]+)?$" } })) {
    const call = node.parent();
    const args = call?.field("parameters") ?? call?.field("arguments");
    const name = args?.children().find(n => n.isNamed())?.text();
    if (name && /^\w+$/.test(name)) names.add(name);
  }
  return [...names];
}

export function cppIndex(files: Map<string, SymbolNode[]>) {
  const methods = new Map<string, SymbolNode[]>();
  const classes = new Map<string, SymbolNode[]>();
  const delegates = new Set<string>();
  const key = (file: string, owner: string, name: string) => JSON.stringify([cppProject(file), owner, name]);
  for (const [file, symbols] of files) {
    for (const sym of symbols) {
      for (const type of sym.cppDelegateTypes ?? []) delegates.add(key(file, type, ""));
      if (sym.language !== "cpp") continue;
      const map = sym.cppFields ? classes : methods;
      if (!sym.cppFields && !sym.cppOwner) continue;
      const id = key(file, sym.cppOwner ?? sym.name, sym.cppFields ? "" : sym.name);
      const list = map.get(id) ?? [];
      list.push(sym);
      map.set(id, list);
    }
  }
  return {
    isDelegate(file: string, event: string) {
      const match = event.match(/^delegate:(\w+)\.(\w+)$/);
      if (!match) return false;
      const types = new Set(classes.get(key(file, match[1], ""))?.map(s => s.cppFields?.[match[2]]));
      const [type] = types;
      return types.size === 1 && !!type && delegates.has(key(file, type, ""));
    },
    methods: (file: string, owner: string, name: string) => methods.get(key(file, owner, name)) ?? [],
    field(file: string, owner: string, member: string) {
      const types = new Set(classes.get(key(file, owner, ""))?.map(s => s.cppFields?.[member]).filter(Boolean));
      return types.size === 1 ? [...types][0] : undefined;
    },
  };
}

type BindingLookup = ReturnType<typeof cppBindings>;

export function cppCallback(call: SgNode, owner: string | undefined, lookup: BindingLookup) {
  const target = call.field("function");
  const api = target?.field("field")?.text();
  const object = target?.field("argument");
  if (!api || !object) return;
  if (api === "Broadcast" && owner) {
    if (object.kind() !== "identifier") return;
    const event = object.text();
    return { name: event, cpp: { emits: `delegate:${owner}.${event}`, label: `${event} broadcast` } };
  }
  if (!["BindAction", "BindAxis", "AddUObject"].includes(api)) return;
  const args = call.field("arguments")?.children().filter(n => n.isNamed()).map(n => n.text()) ?? [];
  const input = api !== "AddUObject";
  const index = api === "BindAction" ? 2 : api === "BindAxis" ? 1 : 0;
  const method = args[index + 1]?.match(/^&\s*([\w:]+)::(\w+)$/);
  if (!method || args[index] !== "this") return;
  const handlerOwner = method[1] === "ThisClass" ? owner : method[1];
  if (!handlerOwner || handlerOwner !== owner) return;
  const cpp: CppCall = { owner: handlerOwner };
  if (input) {
    if (lookup(object.text(), call)?.type !== "UInputComponent") return;
    const action = args[0]?.match(/^(?:TEXT\(\s*"([^"]+)"\s*\)|"([^"]+)")$/);
    if (!action) return;
    const name = action[1] ?? action[2];
    cpp.binds = [api, name].join(":");
    cpp.label = [name, api === "BindAction" ? args[1] : "axis"].join(" ");
  } else {
    const member = object.field("field")?.text();
    const base = object.field("argument")?.text();
    const eventOwner = base === "this" || object.kind() === "identifier" ? owner : base ? lookup(base, call)?.type : undefined;
    const eventName = member ?? object.text();
    if (eventOwner) cpp.binds = `delegate:${eventOwner}.${eventName}`;
    cpp.label = `${eventName} subscription`;
  }
  return { name: method[2], cpp };
}

export function cppSubscriptions(files: Map<string, SymbolEdge[]>, index: ReturnType<typeof cppIndex>) {
  const subscriptions = new Map<string, Set<string>>();
  const key = (file: string, event: string) => JSON.stringify([cppProject(file), event]);
  for (const [file, edges] of files) {
    for (const edge of edges) {
      if (!edge.cpp?.binds || !edge.cpp.owner) continue;
      if (edge.cpp.binds.startsWith("delegate:") && !index.isDelegate(file, edge.cpp.binds)) continue;
      const id = key(file, edge.cpp.binds);
      const handlers = subscriptions.get(id) ?? new Set<string>();
      for (const method of index.methods(file, edge.cpp.owner, edge.calleeName)) handlers.add(method.id);
      subscriptions.set(id, handlers);
    }
  }
  return (file: string, event: string) => [...(subscriptions.get(key(file, event)) ?? [])];
}

export function isInputConfig(file: string): boolean {
  return /(?:^|\/)Config\/DefaultInput\.ini$/i.test(file);
}

export function unrealInputMappings(source: string, file: string) {
  const symbols: SymbolNode[] = [];
  const rawCalls = [];
  let inputSection = false;
  const mappings = new Map<string, { api: string; name: string; key: string; line: number }>();
  for (const [i, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line.startsWith("[")) inputSection = line.toLowerCase() === "[/script/engine.inputsettings]";
    if (!inputSection) continue;
    const rule = line.match(/^([+.!-]?)(Action|Axis)Mappings\s*=\s*(.*)$/i);
    if (!rule) continue;
    const [, op, kind, value] = rule;
    const api = kind.toLowerCase() === "action" ? "BindAction" : "BindAxis";
    const identity = `${api}:${value}`;
    if (op === "!") {
      for (const [id, entry] of mappings) if (entry.api === api) mappings.delete(id);
    } else if (op === "-") mappings.delete(identity);
    else {
      const name = value.match(/\b(?:Action|Axis)Name\s*=\s*"([^"]+)"/i)?.[1];
      const key = value.match(/\bKey\s*=\s*"?([\w]+)"?/i)?.[1];
      if (name && key) mappings.set(identity, { api, name, key, line: i+1 });
    }
  }
  for (const { api, name, key, line } of mappings.values()) {
    const id = `${file}::${key}#${line}`;
    symbols.push({ id, name: key, qualifiedName: key, kind: "variable", file, line, endLine: line, language: "ini" });
    rawCalls.push({ callerId: id, calleeName: name, kind: "call" as const, callSite: { file, line },
      cpp: { emits: `${api}:${name}`, label: `input mapping ${name}` } });
  }
  return { symbols, rawCalls };
}
