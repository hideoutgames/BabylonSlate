import { describe, expect, it, vi } from "vitest";
import { ImportLimitError } from "../import-limits";
import { encodeGlbJsonBin, ingestGltfForImport, parseGlbForBrowse } from "./glb-parse";

// A small budget stands in for the real 256 MiB one, so the test never builds a string that large.
vi.mock("../import-limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../import-limits")>()),
  GLTF_MAX_DATA_URI_BYTES: 64,
}));

/** A base64 data URI of `bytes` zero bytes. */
function zeros(bytes: number): string {
  return `data:image/png;base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`;
}

describe("glTF data URI budget", () => {
  it("decodes data URIs that fit the budget together", () => {
    const glb = encodeGlbJsonBin({ asset: { version: "2.0" }, images: [{ uri: zeros(30) }, { uri: zeros(30) }] }, new Uint8Array(0));
    expect(parseGlbForBrowse(glb)!.images.map((image) => image.bytes.byteLength)).toEqual([30, 30]);
  });

  it("fails by name once the images' data URIs together pass the budget, before decoding the one that passes it", () => {
    const glb = encodeGlbJsonBin(
      { asset: { version: "2.0" }, images: [{ uri: zeros(30) }, { uri: zeros(30) }, { uri: zeros(30) }] },
      new Uint8Array(0),
    );
    expect(() => parseGlbForBrowse(glb)).toThrow(ImportLimitError);
    expect(() => parseGlbForBrowse(glb)).toThrow(/data: URIs is at least 90 bytes; the import limit is 64 bytes/);
  });

  it("applies the budget to a .gltf's buffer data URI", () => {
    const gltf = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: zeros(300), byteLength: 300 }] }));
    expect(() => ingestGltfForImport("big.gltf", gltf)).toThrow(ImportLimitError);
  });
});
