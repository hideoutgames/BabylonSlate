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

  it("falls back to Image.decode when createImageBitmap rejects", async () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("bitmap unsupported");
      }),
    );
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:fallback",
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      "Image",
      class {
        width = 0;
        height = 0;
        src = "";
        async decode() {
          this.width = 2;
          this.height = 1;
        }
      },
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return {
            drawImage: vi.fn(),
            getImageData: () => ({ data: rgba }),
          };
        }
      },
    );
    try {
      const decoded = await decodeSourceToRgba(
        new Uint8Array([0xff, 0xd8]),
        64,
        "image/jpeg",
      );
      expect(decoded.width).toBe(2);
      expect(decoded.height).toBe(1);
      expect(Array.from(decoded.rgba)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
