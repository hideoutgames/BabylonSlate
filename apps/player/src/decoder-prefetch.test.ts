import { describe, expect, it, vi } from "vitest";
import { createDecoderPrefetch, glbDecoderFiles, ktx2DecoderFiles } from "./decoder-prefetch";

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/** A KTX2 header with its supercompression scheme (0 none, 1 BasisLZ/ETC1S, 2 Zstd). */
function ktx2(scheme: number): Uint8Array {
  const bytes = new Uint8Array(80);
  bytes.set(KTX2_IDENTIFIER);
  new DataView(bytes.buffer).setUint32(44, scheme, true);
  return bytes;
}

/** A GLB whose JSON chunk is `json`, padded to four bytes. */
function glb(json: object): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const length = Math.ceil(text.byteLength / 4) * 4;
  const bytes = new Uint8Array(20 + length).fill(0x20, 20);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(text, 20);
  return bytes;
}

describe("decoder prefetch", () => {
  it("picks the transcoder files a KTX2 texture decodes with, never the ETC1S transcoder for UASTC", () => {
    const uastc = ["ktx2/babylon.ktx2Decoder.js", "ktx2/uastc_astc.wasm", "ktx2/uastc_bc7.wasm", "ktx2/uastc_rgba8_unorm_v2.wasm",
      "ktx2/uastc_rgba8_srgb_v2.wasm", "ktx2/uastc_r8_unorm.wasm", "ktx2/uastc_rg8_unorm.wasm"];
    expect(ktx2DecoderFiles(ktx2(2))).toEqual([...uastc, "ktx2/zstddec.wasm"]);
    expect(ktx2DecoderFiles(ktx2(0))).toEqual(uastc);
    expect(ktx2DecoderFiles(ktx2(1))).toEqual(["ktx2/babylon.ktx2Decoder.js", "ktx2/msc_basis_transcoder.js", "ktx2/msc_basis_transcoder.wasm"]);
    expect(ktx2DecoderFiles(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toEqual([]);
  });

  it("picks a mesh decoder only for the compression a GLB lists in extensionsUsed", () => {
    expect(glbDecoderFiles(glb({ asset: { version: "2.0" }, extensionsUsed: ["KHR_draco_mesh_compression"] })))
      .toEqual(["draco/draco_wasm_wrapper_gltf.js", "draco/draco_decoder_gltf.wasm"]);
    expect(glbDecoderFiles(glb({ asset: { version: "2.0" }, extensionsUsed: ["EXT_meshopt_compression"] }))).toEqual(["meshopt/meshopt_decoder.js"]);
    // Named elsewhere (a node name), not used: nothing to fetch.
    expect(glbDecoderFiles(glb({ asset: { version: "2.0" }, nodes: [{ name: "KHR_draco_mesh_compression" }] }))).toEqual([]);
    expect(glbDecoderFiles(glb({ asset: { version: "2.0" } }))).toEqual([]);
  });

  it("fetches each file once against the page's base URL and ignores a failed fetch", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(".wasm")
      ? Promise.reject(new TypeError("offline")) : new Response(new Uint8Array([1])));
    const prefetch = createDecoderPrefetch("https://example.test/game/index.html", fetchImpl as unknown as typeof fetch);
    prefetch.texture(ktx2(1));
    prefetch.texture(ktx2(1));
    prefetch.model(glb({ asset: { version: "2.0" } }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://example.test/game/ktx2/babylon.ktx2Decoder.js",
      "https://example.test/game/ktx2/msc_basis_transcoder.js",
      "https://example.test/game/ktx2/msc_basis_transcoder.wasm",
    ]);
  });
});
