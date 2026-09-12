import { describe, expect, it } from "vitest";
import {
  sniffRasterImageMime,
  selectTextureChunk,
  playerFilesHaveKtx2Transcoder,
  KTX2_TRANSCODER_RELATIVE_FILES,
  copyTextureBytesForUpload,
} from "./texture-loader";
import type { BabassetHeader } from "./babasset";

const KTX2_PREFIX = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe("texture upload compatibility", () => {
  function legacyUastc() {
    const bytes = new Uint8Array(132);
    bytes.set(KTX2_PREFIX);
    const view = new DataView(bytes.buffer);
    view.setUint32(44, 2, true);
    view.setUint32(48, 80, true);
    view.setUint32(52, 44, true);
    view.setUint16(88, 2, true);
    view.setUint16(90, 40, true);
    bytes[92] = 166;
    bytes[96] = bytes[97] = 3;
    bytes.fill(123, 124);
    return bytes;
  }

  it("normalizes legacy UASTC blocks without changing stored bytes or encoded pixels", () => {
    const source = legacyUastc();
    const original = source.slice();
    const upload = copyTextureBytesForUpload(source);
    expect(source).toEqual(original);
    expect(upload[100]).toBe(16);
    upload[100] = 0;
    expect(upload).toEqual(original);
  });

  it("leaves sized, unrelated and truncated descriptors unchanged in an independent copy", () => {
    const sized = legacyUastc();
    sized[100] = 16;
    const otherFormat = legacyUastc();
    otherFormat[92] = 163;
    const invalidOffset = legacyUastc();
    new DataView(invalidOffset.buffer).setUint32(48, 0xfffffff0, true);
    for (const source of [sized, otherFormat, invalidOffset, legacyUastc().slice(0, 110), KTX2_PREFIX, new Uint8Array([1, 2, 3])]) {
      const upload = copyTextureBytesForUpload(source);
      expect(upload).toEqual(source);
      expect(upload).not.toBe(source);
    }
  });
});

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

describe("sniffRasterImageMime", () => {
  it("recognizes JPEG, PNG, GIF, and WebP and rejects KTX2", () => {
    expect(sniffRasterImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(
      "image/jpeg",
    );
    expect(
      sniffRasterImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("image/png");
    expect(sniffRasterImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(
      "image/gif",
    );
    expect(
      sniffRasterImageMime(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        ]),
      ),
    ).toBe("image/webp");
    expect(sniffRasterImageMime(KTX2_PREFIX)).toBeNull();
    expect(sniffRasterImageMime(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("player KTX2 transcoder files", () => {
  it("requires every decoder and wasm file in the player map", () => {
    expect(KTX2_TRANSCODER_RELATIVE_FILES).toEqual([
      "ktx2/babylon.ktx2Decoder.js",
      "ktx2/msc_basis_transcoder.js",
      "ktx2/msc_basis_transcoder.wasm",
      "ktx2/uastc_astc.wasm",
      "ktx2/uastc_bc7.wasm",
      "ktx2/uastc_rgba8_unorm_v2.wasm",
      "ktx2/uastc_rgba8_srgb_v2.wasm",
      "ktx2/uastc_r8_unorm.wasm",
      "ktx2/uastc_rg8_unorm.wasm",
      "ktx2/zstddec.wasm",
    ]);
    const files = new Map<string, Uint8Array>([
      ["ktx2/babylon.ktx2Decoder.js", new Uint8Array([1])],
      ["ktx2/msc_basis_transcoder.js", new Uint8Array([1])],
      ["ktx2/msc_basis_transcoder.wasm", new Uint8Array([1])],
    ]);
    expect(playerFilesHaveKtx2Transcoder(files)).toBe(false);
    files.set("ktx2/uastc_astc.wasm", new Uint8Array([1]));
    files.set("ktx2/uastc_bc7.wasm", new Uint8Array([1]));
    files.set("ktx2/zstddec.wasm", new Uint8Array([1]));
    expect(playerFilesHaveKtx2Transcoder(files)).toBe(false);
    files.set("ktx2/uastc_rgba8_unorm_v2.wasm", new Uint8Array([1]));
    files.set("ktx2/uastc_rgba8_srgb_v2.wasm", new Uint8Array([1]));
    files.set("ktx2/uastc_r8_unorm.wasm", new Uint8Array([1]));
    files.set("ktx2/uastc_rg8_unorm.wasm", new Uint8Array([1]));
    expect(playerFilesHaveKtx2Transcoder(files)).toBe(true);
  });
});

describe("HUD GUI Image packing", () => {
  it("does not export a GUI Image chunk picker", async () => {
    const mod = await import("./texture-loader");
    expect("selectGuiImageChunk" in mod).toBe(false);
    expect("mimeForGuiTextureBytes" in mod).toBe(false);
  });
});

describe("selectTextureChunk authored variant", () => {
  it("picks the preferred ktx2 chunk instead of the first ktx2", () => {
    const header = textureHeader([
      {
        id: "pixels",
        kind: "pixels",
        mime: "image/png",
        sha256: "aa",
        locator: { inline: { offset: 0, length: 1 } },
      },
      {
        id: "ktx2:stale",
        kind: "ktx2",
        mime: "image/ktx2",
        sha256: "old",
        locator: { inline: { offset: 1, length: 1 } },
      },
      {
        id: "ktx2:authored",
        kind: "ktx2",
        mime: "image/ktx2",
        sha256: "new",
        locator: { inline: { offset: 2, length: 1 } },
      },
    ]);
    header.payload = { ktx2ChunkId: "ktx2:authored" };
    expect(selectTextureChunk(header).chunk.id).toBe("ktx2:authored");
    expect(
      selectTextureChunk(header, { preferredChunkId: "ktx2:stale" }).chunk.id,
    ).toBe("ktx2:stale");
  });

  it("falls back to another ktx2 when the preferred variant is missing", () => {
    const header = textureHeader([
      {
        id: "pixels",
        kind: "pixels",
        mime: "image/png",
        sha256: "aa",
        locator: { inline: { offset: 0, length: 1 } },
      },
      {
        id: "ktx2:other",
        kind: "ktx2",
        mime: "image/ktx2",
        sha256: "bb",
        locator: { inline: { offset: 1, length: 1 } },
      },
    ]);
    expect(
      selectTextureChunk(header, { preferredChunkId: "ktx2:missing" }).chunk.id,
    ).toBe("ktx2:other");
  });
});
