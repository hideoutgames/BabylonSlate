import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBabasset, readBabassetHeader } from "./babasset";
import { ktx2ChunkId } from "./texture-compression";
import { selectTextureChunk } from "./texture-loader";

const editorKtx2 = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/editor/public/ktx2",
);

describe("transcoder unavailable / export-omitted smoke", () => {
  it("selectTextureChunk uses source when transcoder URLs are unavailable", async () => {
    const bytes = await encodeBabasset({
      header: {
        guid: "tex-1",
        type: "Texture",
        name: "Tex",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: { compressionState: "compressed", usage: "albedo" },
      },
      chunks: [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          data: new Uint8Array([1, 2, 3, 4]),
        },
        {
          id: ktx2ChunkId("deadbeef"),
          kind: "ktx2",
          mime: "image/ktx2",
          data: new Uint8Array([9, 9]),
        },
      ],
    });
    const header = readBabassetHeader(bytes);
    const selected = selectTextureChunk(header, { transcoderAvailable: false });
    expect(selected.kind).toBe("source");
    expect(selected.reason).toBe("transcoder-unavailable");
    expect(selected.chunk.id).toBe("pixels");
  });

  it("vendored editor ktx2 decoder module exists for offline boot", () => {
    const decoder = readFileSync(join(editorKtx2, "babylon.ktx2Decoder.js"), "utf8");
    expect(decoder.length).toBeGreaterThan(100);
    for (const name of [
      "msc_basis_transcoder.js",
      "msc_basis_transcoder.wasm",
      "uastc_astc.wasm",
      "uastc_bc7.wasm",
      "uastc_rgba8_unorm_v2.wasm",
      "uastc_rgba8_srgb_v2.wasm",
      "uastc_r8_unorm.wasm",
      "uastc_rg8_unorm.wasm",
      "zstddec.wasm",
    ]) {
      const fileBytes = readFileSync(join(editorKtx2, name));
      expect(fileBytes.byteLength).toBeGreaterThan(0);
    }
  });

  it("loader prefers KTX2 only when transcoder is available", async () => {
    const bytes = await encodeBabasset({
      header: {
        guid: "tex-2",
        type: "Texture",
        name: "Tex",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: { compressionState: "compressed" },
      },
      chunks: [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          data: new Uint8Array([1]),
        },
        {
          id: ktx2ChunkId("cafe"),
          kind: "ktx2",
          mime: "image/ktx2",
          data: new Uint8Array([2]),
        },
      ],
    });
    const header = readBabassetHeader(bytes);
    expect(selectTextureChunk(header).kind).toBe("ktx2");
    expect(
      selectTextureChunk(header, { transcoderAvailable: false }).kind,
    ).toBe("source");
  });
});
