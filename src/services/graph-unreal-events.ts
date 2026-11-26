// SPDX-License-Identifier: AGPL-3.0-only
import type { SgNode } from "@ast-grep/napi";
import type { SymbolEdge, SymbolNode } from "../types.js";
import { type cppBindings, cppIndex, cppProject } from "./graph-cpp.js";

import { connectFeatureSites, type FeatureSite } from "./graph-unreal-features.js";

type Evidence =
  | { kind: "feature"; feature: FeatureSite["evidence"] }
  | { kind: "launch"; body: SymbolNode; slot?: string; object?: string; binding?: number }
  | { kind: "store"; object: string; collection: string }
  | { kind: "read"; slot: string; collection?: string; binding?: number }
  | { kind: "registration"; property: string }
  | { kind: "dirty" | "delta" }
  | { kind: "container"; path: string[]; op: string };

export type UnrealSite = { symbol: SymbolNode; line: number; evidence: Evidence };

type Lookup = ReturnType<typeof cppBindings>;

export function launchedLambda(call: SgNode) {
  if (call.field("function")?.text() !== "UE::Tasks::Launch") return;
  return call.field("arguments")?.children().filter(n => n.isNamed() && n.kind() !== "comment")[1];
}

export function launchEvidence(node: SgNode, body: SymbolNode, lookup: Lookup): Evidence {
  const parent = node.parent();
  const dest = parent?.kind() === "init_declarator" ? parent.field("declarator")
    : parent?.kind() === "assignment_expression" ? parent.field("left") : undefined;
  const member = dest?.kind() === "field_expression" ? dest.field("field") : undefined;
  const slot = member?.text() ?? (dest?.kind() === "identifier" ? dest.text() : undefined);
  const receiver = member ? dest?.field("argument")?.text() : undefined;
  const object = receiver === "this" ? undefined : receiver;
  const binding = slot && !receiver ? lookup(slot, node)?.start : undefined;
  return { kind: "launch", body, slot, binding, object };
}

function fieldName(node?: SgNode | null) {
  if (node?.kind() === "identifier") return node.text();
  if (node?.kind() === "field_expression" && node.field("argument")?.text() === "this") return node.field("field")?.text();
}

export function taskEvidence(node: SgNode, lookup: Lookup): Evidence | undefined {
  const callee = node.field("function");
  const member = callee?.field("field")?.text();
  const object = callee?.field("argument");
  if (!object) return;
  if (member === "Add" || member === "Emplace") {
    const collection = fieldName(object);
    if (!collection || (object.kind() === "identifier" && lookup(collection, node))) return;
    const args = node.field("arguments")?.children().filter(n => n.isNamed() && n.kind() !== "comment");
    if (args?.length !== 1) return;
    let item = args[0];
    if (item.field("function")?.text() === "MoveTemp") {
      const moved = item.field("arguments")?.children().filter(n => n.isNamed() && n.kind() !== "comment");
      if (moved?.length !== 1) return;
      item = moved[0];
    }
    if (item.kind() === "identifier") return { kind: "store", object: item.text(), collection };
  }
  if (member !== "GetResult") return;
  const slot = fieldName(object);
  if (slot) return { kind: "read", slot, binding: object.kind() === "identifier" ? lookup(slot, node)?.start : undefined };
  const array = object.field("argument");
  if (object.kind() !== "field_expression" || array?.kind() !== "subscript_expression") return;
  const container = array.field("argument");
  const collection = fieldName(container);
  const itemSlot = object.field("field")?.text();
  if (collection && itemSlot && !(container?.kind() === "identifier" && lookup(collection, node))) {
    return { kind: "read", collection, slot: itemSlot };
  }
}

export function replicationEvidence(node: SgNode, symbol: SymbolNode, serializers: Set<string>): Evidence | undefined {
  const owner = symbol.cppOwner;
  if (!owner) return;
  const target = node.field("function");
  const fn = target?.text();
  if (symbol.name === "GetLifetimeReplicatedProps" && fn === "DOREPLIFETIME") {
    const args = node.field("arguments")?.children().filter(n => n.isNamed()).map(n => n.text());
    if (args?.length === 2 && args[0] === owner) return { kind: "registration", property: args[1] };
  }
  if (fn === "MarkItemDirty") return { kind: "dirty" };
  if (symbol.name === "NetDeltaSerialize" && serializers.has(owner)
    && target?.field("name")?.text() === "FastArrayDeltaSerialize"
    && target.field("arguments")?.children().some(n => n.text() === owner)) return { kind: "delta" };
}

const containerOperations = new Set(["Enqueue", "Dequeue", "Add", "IsEmpty", "Reset"]);

export function containerEvidence(node: SgNode, lookup: Lookup): Evidence | undefined {
  const fn = node.field("function");
  const op = fn?.field("field")?.text();
  if (!op || !containerOperations.has(op)) return;
  let receiver = fn?.field("argument");
  const path: string[] = [];
  while (receiver?.kind() === "field_expression") {
    const field = receiver.field("field");
    if (!field || field.kind() !== "field_identifier") return;
    path.unshift(field.text());
    receiver = receiver.field("argument");
  }
  if (receiver?.kind() === "identifier") {
    if (lookup(receiver.text(), node)) return;
    path.unshift(receiver.text());
  } else if (receiver?.text() !== "this") return;
  if (path.length) return { kind: "container", op, path };
}

export function connectUnrealSites(sites: UnrealSite[], files: Map<string, SymbolNode[]>, edges: Map<string, SymbolEdge[]>, domains?: Map<string, string>) {
  if (!sites.length) return;
  connectFeatureSites(sites.flatMap(s => s.evidence.kind === "feature" ? [{ ...s, evidence: s.evidence.feature }] : []),
    files, edges, file => domains?.get(file) ?? cppProject(file));
  sites = sites.filter(s => s.evidence.kind !== "feature");
  if (!sites.length) return;
  const index = cppIndex(files);
  function connect(site: UnrealSite, target: SymbolNode, label: string, kind: "event" | "data_flow" = "event") {
    const outgoing = edges.get(site.symbol.file);
    if (!outgoing || outgoing.some(e => e.callerId === site.symbol.id && e.cpp?.label === label && e.calleeCandidates.includes(target.id))) return;
    outgoing.push({ callerId: site.symbol.id, calleeName: target.name, calleeCandidates: [target.id],
      confidence: "unique", kind, targetScope: "project", cpp: { label },
      callSite: { file: site.symbol.file, line: site.line } });
  }
  for (const launch of sites) {
    const origin = launch.evidence;
    if (origin.kind !== "launch") continue;
    connect(launch, origin.body, "UE::Tasks::Launch");
    if (!origin.slot) continue;
    const local = sites.filter(s => s.symbol.cppOwner === launch.symbol.cppOwner &&
      (launch.symbol.cppOwner ? cppProject(s.symbol.file) === cppProject(launch.symbol.file) : s.symbol.id === launch.symbol.id));
    const assignment = origin.object && local.find(s => s.evidence.kind === "store" && s.symbol.id === launch.symbol.id
      && s.line >= launch.line && s.evidence.object === origin.object);
    const collection = assignment && assignment.evidence.kind === "store" ? assignment.evidence.collection : undefined;
    if (origin.object && (!collection || !launch.symbol.cppOwner ||
      index.field(launch.symbol.file, launch.symbol.cppOwner, collection) !== "TArray")) continue;
    for (const read of local) {
      if (read.evidence.kind !== "read" || read.evidence.slot !== origin.slot || read.evidence.collection !== collection) continue;
      if (read.evidence.binding !== origin.binding || (origin.binding !== undefined && read.symbol.id !== launch.symbol.id)) continue;
      connect({ ...launch, symbol: origin.body }, read.symbol,
        `result read: GetResult ${[collection, origin.slot].filter(Boolean).join(".")}`, "data_flow");
    }
  }
  const containers = new Map<string, { type: string; records: { site: UnrealSite; op: string; path: string }[] }>();
  for (const site of sites) {
    const e = site.evidence;
    if (e.kind !== "container" || !site.symbol.cppOwner) continue;
    let owner: string | undefined = site.symbol.cppOwner;
    for (const field of e.path.slice(0, -1)) owner = owner && index.field(site.symbol.file, owner, field);
    if (!owner) continue;
    const field = e.path[e.path.length - 1];
    const type = index.field(site.symbol.file, owner, field);
    if (type !== "TQueue" && type !== "TSet" && type !== "TArray") continue;
    const key = JSON.stringify([cppProject(site.symbol.file), owner, field, type]);
    const group = containers.get(key) ?? { type, records: [] };
    group.records.push({ site, op: e.op, path: e.path.join(".") });
    containers.set(key, group);
  }
  for (const { type, records } of containers.values()) {
    const isQueue = type === "TQueue";
    for (const writer of records.filter(r => r.op === (isQueue ? "Enqueue" : "Add"))) {
      for (const reader of records.filter(r => r.op === (isQueue ? "Dequeue" : "Reset"))) {
        if (writer.site.symbol.id === reader.site.symbol.id) continue;
        if (writer.site.symbol.cppOwner === reader.site.symbol.cppOwner && writer.path !== reader.path) continue;
        if (!isQueue && !records.some(r => r.op === "IsEmpty" && r.site.symbol.id === reader.site.symbol.id &&
          r.path === reader.path && r.site.line <= reader.site.line)) continue;
        const relation = isQueue ? "queue: Enqueue / Dequeue" : "pending state: Add / IsEmpty + Reset";
        connect(writer.site, reader.site.symbol, `${relation} (${reader.path})`, "data_flow");
      }
    }
  }
  for (const reg of sites) {
    if (reg.evidence.kind !== "registration" || !reg.symbol.cppOwner) continue;
    const property = reg.evidence.property;
    const type = index.field(reg.symbol.file, reg.symbol.cppOwner, property);
    if (!type) continue;
    const local = sites.filter(s => cppProject(s.symbol.file) === cppProject(reg.symbol.file));
    const delta = local.filter(s => s.evidence.kind === "delta" && s.symbol.cppOwner === type);
    if (delta.length !== 1) continue;
    const serializer = delta[0];
    for (const site of local) {
      if (site.symbol.cppOwner !== type) continue;
      if (site.evidence.kind === "dirty") connect(site, serializer.symbol, "Fast Array replication");
    }
    for (const name of ["PostReplicatedAdd", "PostReplicatedChange", "PreReplicatedRemove"]) {
      const callbacks = index.methods(serializer.symbol.file, type, name);
      if (callbacks.length === 1) connect(serializer, callbacks[0], "Fast Array callback");
    }
  }
}
