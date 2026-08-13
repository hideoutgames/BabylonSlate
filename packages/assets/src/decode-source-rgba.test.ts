import { describe, expect, it, vi } from "vitest";
import { decodeSourceToRgba } from "./decode-source-rgba";

describe("decodeSourceToRgba", () => {
  it("passes the source MIME type into the image Blob", async () => {
    const createImageBitmap = vi.fn(async (image: Blob) => {
      expect(image.type).toBe("image/png");
      throw new Error("stop-after-blob");
    });
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    try {
      await expect(
        decodeSourceToRgba(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 64, "image/png"),
      ).rejects.toThrow("stop-after-blob");
      expect(createImageBitmap).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
