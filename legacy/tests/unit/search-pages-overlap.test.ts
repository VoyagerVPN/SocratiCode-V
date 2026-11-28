import { expect, it } from "vitest";
import { createSearchPage } from "../../src/services/search-pages.js";

it("shows shared lines once per compact page and preserves complete JSON entries", () => {
  const base = { filePath: "/p/a", relativePath: "a", language: "text", score: 1 };
  const shared = "this complete shared line should appear exactly once";
  const results = [
    { ...base, startLine: 10, endLine: 11, content: "first\n" + shared + "\n" },
    { ...base, startLine: 11, endLine: 12, content: shared + "\nlast\n" },
  ];
  const scope = { status: "ok" as const, partial: false, searchedSources: ["/p"], failedSources: [], skippedSources: [], incompleteSources: [] };
  const page = (format: string) => createSearchPage({ projectPath: "/p", format }, results, scope, [], 0);
  const compact = page("compact");
  expect(compact.text.split(shared)).toHaveLength(2);
  expect(compact.text).toContain("L11 = #1");
  expect(compact.text).toContain("last");
  expect(page("json").structuredContent.entries?.map((entry) => entry.content)).toEqual(results.map((entry) => entry.content));
});

it("returns a labelled excerpt near the query and gives an actionable minimum for full records", () => {
  const lines = Array.from({ length: 80 }, (_, i) => i === 52 ? "void UpdateDepartures() {}" : "some surrounding source line with context");
  const result = { filePath: "/p/a.cpp", relativePath: "a.cpp", language: "cpp", score: 1, startLine: 10, endLine: 89, content: lines.join("\n") };
  const selection = { status: "ok" as const, partial: false, searchedSources: ["/p"], failedSources: [], skippedSources: [], incompleteSources: [] };
  const page = (format: string, maxChars: number) => createSearchPage({ projectPath: "/p", query: "UpdateDepartures", format, maxChars }, [result], selection, [], 0);
  const compact = page("compact", 1500);
  expect(compact.isError).toBe(false);
  expect(compact.text).toContain("void UpdateDepartures()");
  expect(compact.text).toMatch(/excerpt.*L\d+-\d+/);
  const error = page("json", 1500);
  expect(error.isError).toBe(true);
  expect(error.text).toContain(String(error.structuredContent.minimumChars));
  const minimum = error.structuredContent.minimumChars;
  if (!minimum) throw new Error("Missing budget");
  expect(page("json", minimum).structuredContent.entries?.[0].content).toBe(result.content);
});
