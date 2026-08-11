import { describe, expect, it } from "vitest";
import { MemoryProjectStorage } from "@babylonslate/vfs";
import {
  generateThumbnailBytes,
  readThumbnail,
  thumbnailPath,
  writeThumbnail,
} from "./thumbnails";

describe("thumbnails I/O", () => {
  it("writes and reads derived thumbnail bytes", async () => {
    const storage = new MemoryProjectStorage();
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
