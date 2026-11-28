import { expect, it, vi } from "vitest";
import { readTextPage } from "../../src/services/text-pages.js";

it("reads the rest of the same result without rerunning the graph or losing text", async () => {
  const source = "stack frame 🍋\n".repeat(110);
  const load = vi.fn(async () => source);
  const args = { projectPath: "/work", entrypoint: "main", maxChars: 512 };
  let page = await readTextPage("flow", args, load);
  let collected = page.content[0].text;
  const first = page.structuredContent?.nextCursor;
  expect(first).toBeTruthy();
  while (page.structuredContent?.nextCursor) {
    page = await readTextPage("flow", { ...args, cursor: page.structuredContent.nextCursor }, load);
    expect(page.content[0].text.length).toBeLessThanOrEqual(512);
    collected += page.content[0].text;
  }
  expect(collected).toBe(source);
  expect(load).toHaveBeenCalledTimes(1);
  expect((await readTextPage("impact", { ...args, cursor: first }, load)).isError).toBe(true);
});
