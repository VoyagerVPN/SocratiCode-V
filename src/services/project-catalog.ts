// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { collectionName, projectIdFromPath } from "../config.js";
import { QDRANT_COLLECTION_PREFIX } from "../constants.js";
import { ensureQdrantReady } from "./docker.js";
import { readProjectCatalogRecords } from "./qdrant.js";

export const catalogEntrySchema = z.object({
  path: z.string(),
  collection: z.string().nullable(),
  index: z.enum(["missing", "available", "incomplete", "legacy", "unknown"]),
  files: z.number().int().nonnegative(),
  indexedAt: z.string().nullable(),
  graph: z.enum(["available", "missing"]),
  association: z.enum(["explicit", "nested"]).optional(),
});
export const projectCatalogSchema = z.object({
  scope: z.enum(["project", "all"]),
  project: catalogEntrySchema.nullable(),
  sources: z.array(catalogEntrySchema),
  projects: z.array(catalogEntrySchema).optional(),
  total: z.number().int().nonnegative().optional(),
  nextCursor: z.string().nullable().optional(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export type ProjectCatalog = z.infer<typeof projectCatalogSchema>;

/** Одинаковые пути на Windows могут различаться регистром и видом разделителей. */
function pathKey(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryFromRecord(row: Record<string, unknown>, rows: Array<Record<string, unknown>>): CatalogEntry {
  const name = typeof row.collectionName === "string" ? row.collectionName : null;
  let index: CatalogEntry["index"] = row.indexingStatus === "in-progress" ? "incomplete" : row.indexingStatus === "completed" ? "available" : "unknown";
  try {
    const raw: unknown = typeof row.effectiveIndexProfile === "string"
      ? JSON.parse(row.effectiveIndexProfile) : row.effectiveIndexProfile;
    if (!record(raw) || raw.source !== "fresh" ||
      (Array.isArray(raw.legacyUnverifiedFields) && raw.legacyUnverifiedFields.length > 0)) index = "legacy";
  } catch { index = "unknown"; }
  const graphName = name?.replace(`${QDRANT_COLLECTION_PREFIX}codebase_`, `${QDRANT_COLLECTION_PREFIX}codegraph_`);
  return {
    path: typeof row.projectPath === "string" ? row.projectPath : "(unknown)",
    collection: name,
    index,
    files: typeof row.filesIndexed === "number" && row.filesIndexed >= 0 ? row.filesIndexed : 0,
    indexedAt: typeof row.lastIndexedAt === "string" ? row.lastIndexedAt : null,
    graph: rows.some((candidate) => candidate.collectionName === graphName) ? "available" : "missing",
  };
}

function missingEntry(projectPath: string): CatalogEntry {
  return { path: projectPath, collection: null, index: "missing", files: 0, indexedAt: null, graph: "missing" };
}

/** Отсутствующий каталог остаётся видимым явно подключённым источником. */
function declaredSources(root: string): string[] {
  const configPath = path.join(root, ".socraticode.json");
  const config: unknown = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  if (!record(config)) throw new Error("The project .socraticode.json must contain an object");
  if (config.linkedProjects !== undefined && (!Array.isArray(config.linkedProjects) ||
    !config.linkedProjects.every((value: unknown) => typeof value === "string"))) {
    throw new Error("linkedProjects must be an array of paths");
  }
  const links = Array.isArray(config.linkedProjects) ? config.linkedProjects.filter((value: unknown): value is string => typeof value === "string") : [];
  return [...links, ...(process.env.SOCRATICODE_LINKED_PROJECTS?.split(",") ?? [])]
    .filter((candidate) => candidate.trim().length > 0).map((candidate) => path.resolve(root, candidate.trim()));
}

/** Привязка источника сохраняет существующую конфигурацию и не теряется при параллельных вызовах. */
export async function attachProjectSource(parentPath: string, sourcePath: string): Promise<void> {
  const parent = path.resolve(parentPath);
  const source = path.resolve(sourcePath);
  if (pathKey(parent) === pathKey(source)) throw new Error("A project cannot be its own source");
  if (!fs.statSync(parent).isDirectory() || !fs.statSync(source).isDirectory()) throw new Error("Parent and source must be directories");
  const configPath = path.join(parent, ".socraticode.json");
  const release = await lockfile.lock(configPath, { realpath: false,
    retries: { retries: 20, minTimeout: 25, maxTimeout: 100 }, stale: 30_000 });
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    const config: unknown = fs.existsSync(configPath) ? JSON.parse(await fsp.readFile(configPath, "utf8")) : {};
    if (!record(config)) throw new Error("The parent .socraticode.json must contain an object");
    if (config.linkedProjects !== undefined && (!Array.isArray(config.linkedProjects) ||
      !config.linkedProjects.every((value: unknown) => typeof value === "string"))) {
      throw new Error("The parent linkedProjects must be an array of paths");
    }
    const links: string[] = Array.isArray(config.linkedProjects) ? config.linkedProjects.filter((value: unknown): value is string => typeof value === "string") : [];
    if (links.some((linked) => pathKey(path.resolve(parent, linked)) === pathKey(source))) return;
    const relative = path.relative(parent, source).split(path.sep).join("/");
    config.linkedProjects = [...links, relative || source];
    await fsp.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await fsp.rename(temporary, configPath);
  } finally {
    await fsp.rm(temporary, { force: true });
    await release();
  }
}

/** Только зарегистрированные индексы и явно подключённые пути; дерево кандидатов не обходится. */
export async function getProjectCatalog(args: Record<string, unknown>): Promise<ProjectCatalog> {
  const root = path.resolve(typeof args.projectPath === "string" ? args.projectPath : process.cwd());
  await ensureQdrantReady();
  const rows = await readProjectCatalogRecords();
  const codeRows = rows.filter((row) => typeof row.collectionName === "string" &&
    row.collectionName.startsWith(`${QDRANT_COLLECTION_PREFIX}codebase_`));
  if (args.scope === "all") {
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const offset = typeof args.cursor === "string" ? Number(args.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid catalog cursor");
    const projects = codeRows.map((row) => entryFromRecord(row, rows))
      .sort((a, b) => a.path.localeCompare(b.path) || (a.collection ?? "").localeCompare(b.collection ?? ""));
    return { scope: "all", project: null, sources: [], projects: projects.slice(offset, offset + limit),
      total: projects.length, nextCursor: offset + limit < projects.length ? String(offset + limit) : null };
  }
  const current = codeRows.find((row) => row.collectionName === collectionName(projectIdFromPath(root))) ??
    codeRows.find((row) => typeof row.projectPath === "string" && pathKey(row.projectPath) === pathKey(root));
  const sources: CatalogEntry[] = [];
  const seen = new Set<string>([pathKey(root)]);
  for (const linked of declaredSources(root)) {
    const key = pathKey(linked);
    if (seen.has(key)) continue;
    seen.add(key);
    const row = codeRows.find((candidate) => typeof candidate.projectPath === "string" && pathKey(candidate.projectPath) === key);
    sources.push({ ...(row ? entryFromRecord(row, rows) : missingEntry(linked)), association: "explicit" });
  }
  for (const row of codeRows) {
    if (typeof row.projectPath !== "string" || !isDescendant(root, row.projectPath) || seen.has(pathKey(row.projectPath))) continue;
    seen.add(pathKey(row.projectPath));
    sources.push({ ...entryFromRecord(row, rows), association: "nested" });
  }
  return { scope: "project", project: current ? entryFromRecord(current, rows) : missingEntry(root),
    sources: sources.sort((a, b) => a.path.localeCompare(b.path)) };
}
