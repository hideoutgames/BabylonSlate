import { describe, expect, it } from "vitest";
import {
  mimeForGuiTextureBytes,
  selectGuiImageChunk,
  selectTextureChunk,
} from "./texture-loader";
import type { BabassetHeader } from "./babasset";

const KTX2_PREFIX = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function textureHeader(
  chunks: BabassetHeader["chunks"],
): BabassetHeader {
  return {
    guid: "tex-1",
    type: "Texture",
    name: "Hero",
    engineVersion: "0.0.0",
    version: 1,
    mode: "thin",
    dependencies: [],
    payload: {},
    chunks,
  };
}

describe("mimeForGuiTextureBytes", () => {
  it("recognizes JPEG, PNG, GIF, and WebP and rejects KTX2", () => {
    expect(mimeForGuiTextureBytes(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(
      "image/jpeg",
    );
    expect(
      mimeForGuiTextureBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("image/png");
    expect(mimeForGuiTextureBytes(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(
      "image/gif",
    );
    expect(
      mimeForGuiTextureBytes(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        ]),
      ),
    ).toBe("image/webp");
    expect(mimeForGuiTextureBytes(KTX2_PREFIX)).toBeNull();
    expect(mimeForGuiTextureBytes(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("selectGuiImageChunk", () => {
  it("prefers pixels then source and never picks KTX2", () => {
    const both = textureHeader([
      {
        id: "pixels",
        kind: "pixels",
        mime: "image/png",
        sha256: "aa",
        locator: { inline: { offset: 0, length: 1 } },
      },
      {
        id: "source",
        kind: "bytes",
        mime: "image/jpeg",
        sha256: "cc",
        locator: { inline: { offset: 2, length: 1 } },
      },
      {
        id: "ktx2:hash",
        kind: "ktx2",
        mime: "image/ktx2",
        sha256: "bb",
        locator: { inline: { offset: 1, length: 1 } },
      },
    ]);
    expect(selectTextureChunk(both).kind).toBe("ktx2");
    expect(selectGuiImageChunk(both)).toEqual(
      expect.objectContaining({ kind: "source", reason: "gui-pixels" }),
    );
    expect(selectGuiImageChunk(both)?.chunk.id).toBe("pixels");

    const sourceOnly = textureHeader([
      {
        id: "source",
        kind: "bytes",
        mime: "image/png",
        sha256: "cc",
        locator: { inline: { offset: 0, length: 1 } },
      },
      {
        id: "ktx2:hash",
        kind: "ktx2",
        mime: "image/ktx2",
        sha256: "bb",
        locator: { inline: { offset: 1, length: 1 } },
      },
    ]);
    expect(selectGuiImageChunk(sourceOnly)?.chunk.id).toBe("source");
    expect(selectGuiImageChunk(sourceOnly)?.reason).toBe("gui-source");

    const ktx2Only = textureHeader([
      {
        id: "ktx2:hash",
        kind: "ktx2",
        mime: "image/ktx2",
        sha256: "bb",
        locator: { inline: { offset: 0, length: 1 } },
      },
    ]);
    expect(selectGuiImageChunk(ktx2Only)).toBeNull();
  });
});
