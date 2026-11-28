import { beforeEach, describe, expect, it, vi } from "vitest";

const { scroll, remove } = vi.hoisted(() => ({ scroll: vi.fn(), remove: vi.fn() }));
vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class { scroll = scroll; delete = remove; },
}));
vi.mock("../../src/services/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { deleteFileChunks } from "../../src/services/qdrant.js";

describe("retained chunks at the Qdrant request boundary", () => {
  beforeEach(() => {
    scroll.mockReset();
    remove.mockReset().mockResolvedValue({ status: "completed" });
  });
  it("sends no deletion when the file already contains only retained chunks", async () => {
    scroll.mockResolvedValue({ points: [{ id: "retained" }], next_page_offset: null });
    await deleteFileChunks("codebase_fixture", "kept.ts", true, ["retained"]);
    expect(remove).not.toHaveBeenCalled();
    expect(scroll).toHaveBeenCalledWith("codebase_fixture", {
      filter: { must: [{ key: "relativePath", match: { value: "kept.ts" } }] },
      limit: 256, with_payload: false, with_vector: false,
    });
  });
  it("requires confirmed explicit ID deletion even if the caller did not request completion", async () => {
    scroll.mockResolvedValue({ points: [{ id: "retained" }, { id: "obsolete" }, { id: 12 }], next_page_offset: null });
    await deleteFileChunks("codebase_fixture", "changed.ts", false, ["retained"]);
    expect(remove).toHaveBeenCalledWith("codebase_fixture", { points: ["obsolete", 12], wait: true });
  });
  it("keeps all chunks when scrolling fails before every obsolete ID is known", async () => {
    scroll.mockResolvedValueOnce({ points: [{ id: "obsolete" }], next_page_offset: "next" })
      .mockRejectedValue(new Error("Qdrant scroll failed"));
    await expect(deleteFileChunks("codebase_fixture", "changed.ts", true, ["retained"])).rejects.toThrow("Qdrant scroll failed");
    expect(remove).not.toHaveBeenCalled();
  });
});
