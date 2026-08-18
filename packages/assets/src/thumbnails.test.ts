import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  generateThumbnailBytes,
  readThumbnail,
  thumbnailPath,
  writeThumbnail,
} from "./thumbnails";

describe("thumbnails I/O", () => {
  it("writes and reads derived thumbnail bytes", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("thumbs-root");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await writeThumbnail(storage, "proj-1", "asset-1", bytes);
    expect(thumbnailPath("proj-1", "asset-1")).toBe(
      "derived/proj-1/thumbnails/asset-1.bin",
    );
    await expect(readThumbnail(storage, "proj-1", "asset-1")).resolves.toEqual(
      bytes,
    );
    await expect(readThumbnail(storage, "proj-1", "missing")).resolves.toBeNull();
  });

  it("passes the source MIME type into the thumbnail Blob", async () => {
    const createImageBitmap = vi.fn<(image: Blob) => Promise<ImageBitmap>>(
      async () => {
        throw new Error("stop-after-blob");
      },
    );
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    try {
      await expect(
        generateThumbnailBytes(
          new Uint8Array([0x52, 0x49, 0x46, 0x46]),
          128,
          "image/webp",
        ),
      ).resolves.toBeNull();
      expect(createImageBitmap).toHaveBeenCalledTimes(1);
      const firstCall = createImageBitmap.mock.calls[0];
      expect(firstCall).toBeDefined();
      if (!firstCall) return;
      const [blob] = firstCall;
      expect(blob.type).toBe("image/webp");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns null from generateThumbnailBytes without createImageBitmap", async () => {
    const original = globalThis.createImageBitmap;
    // @ts-expect-error deliberate unset for Node coverage
    delete globalThis.createImageBitmap;
    try {
      await expect(
        generateThumbnailBytes(new Uint8Array([1, 2, 3])),
      ).resolves.toBeNull();
    } finally {
      if (original) globalThis.createImageBitmap = original;
    }
  });
});
