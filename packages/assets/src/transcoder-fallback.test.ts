import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectTextureChunk } from "./texture-loader";
import type { BabassetHeader } from "./babasset";

const editorKtx2 = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/editor/public/ktx2",
);

function textureHeader(withKtx2: boolean): BabassetHeader {
  const chunks = [
    {
      id: "pixels",
      kind: "pixels" as const,
      mime: "image/png",
      encoding: "raw" as const,
      byteLength: 4,
      locator: { kind: "inline" as const },
    },
  ];
  if (withKtx2) {
    chunks.push({
      id: "ktx2:uastc",
      kind: "ktx2" as const,
      mime: "image/ktx2",
      encoding: "raw" as const,
      byteLength: 8,
      locator: { kind: "inline" as const },
    });
  }
  return {
    guid: "tex-1",
    type: "Texture",
    name: "Tex",
    version: 1,
    dependencies: [],
    parentClass: null,
    payload: { compressionState: "compressed", usage: "albedo" },
    chunks,
  };
}

describe("transcoder unavailable / export-omitted smoke", () => {
  it("selectTextureChunk uses source when transcoder URLs are unavailable", () => {
    const header = textureHeader(true);
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
      "zstddec.wasm",
    ]) {
      const bytes = readFileSync(join(editorKtx2, name));
      expect(bytes.byteLength).toBeGreaterThan(0);
    }
  });

  it("loader prefers KTX2 only when transcoder is available", () => {
    const header = textureHeader(true);
    expect(selectTextureChunk(header).kind).toBe("ktx2");
    expect(
      selectTextureChunk(header, { transcoderAvailable: false }).kind,
    ).toBe("source");
  });
});
