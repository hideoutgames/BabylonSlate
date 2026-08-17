import { afterEach, describe, expect, it, vi } from "vitest";
import { collectUiImageUrls, mimeForUiTexture } from "./play-ui-images";

describe("collectUiImageUrls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds blob URLs from pixels with image MIME", async () => {
    const created: Array<{ bytes: Uint8Array; type: string }> = [];
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => {
        created.push({ bytes: new Uint8Array(), type: blob.type });
        return `blob:${blob.type}`;
      },
      revokeObjectURL: vi.fn(),
    });
    const urls = await collectUiImageUrls(
      ["tex-1"],
      [
        {
          guid: "tex-1",
          path: "assets/Logo.texture.babasset",
          type: "Texture",
          chunks: [{ id: "pixels", mime: "image/jpeg" }],
        },
      ],
      async () => new Uint8Array([1, 2, 3]),
    );
    expect(urls.get("tex-1")).toBe("blob:image/jpeg");
    expect(created[0]?.type).toBe("image/jpeg");
  });

  it("falls back to the source chunk and png when MIME is missing", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => `blob:${blob.type}`,
      revokeObjectURL: vi.fn(),
    });
    const urls = await collectUiImageUrls(
      ["tex-2"],
      [{ guid: "tex-2", path: "assets/Icon.texture.babasset", type: "Texture" }],
      async (_path, chunkId) =>
        chunkId === "source" ? new Uint8Array([9]) : null,
    );
    expect(urls.get("tex-2")).toBe("blob:image/png");
  });
});

describe("mimeForUiTexture", () => {
  it("prefers an image/* chunk MIME over a generic fallback", () => {
    expect(mimeForUiTexture("image/webp", "assets/a.texture.babasset")).toBe(
      "image/webp",
    );
    expect(mimeForUiTexture("application/octet-stream", "x")).toBe("image/png");
  });
});
