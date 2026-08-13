import { describe, expect, it, vi } from "vitest";
import { decodeSourceToRgba } from "./decode-source-rgba";

describe("decodeSourceToRgba", () => {
  it("passes the source MIME type into the image Blob", async () => {
    const createImageBitmap = vi.fn(async () => {
      throw new Error("stop-after-blob");
    });
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    await expect(
      decodeSourceToRgba(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 64, "image/png"),
    ).rejects.toThrow("stop-after-blob");
    const blob = createImageBitmap.mock.calls[0]?.[0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
    vi.unstubAllGlobals();
  });
});
