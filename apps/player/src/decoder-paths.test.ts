import { describe, expect, it, vi } from "vitest";
import { createDecoderPrefetch, modelDecoders, textureDecoder } from "./decoder-paths";

/** A KTX2 header (48 bytes) with `supercompressionScheme` at byte 44. */
function ktx2(scheme: number): Uint8Array {
  const bytes = new Uint8Array(80);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(44, scheme, true);
  return bytes;
}

/** A GLB whose JSON chunk is `json`, padded with spaces as glTF requires. */
function glb(json: object): Uint8Array {
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const chunk = new TextEncoder().encode(text);
  const bytes = new Uint8Array(20 + chunk.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, chunk.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(chunk, 20);
  return bytes;
}

const paths = {
  ktx2BasePath: "https://game.example/my-game/ktx2/",
  dracoBasePath: "https://game.example/my-game/draco/",
  meshoptBasePath: "https://game.example/my-game/meshopt/",
};

describe("player decoder prefetch", () => {
  it("names the KTX2 transcoders a Texture needs by its supercompression, and none for another container", () => {
    expect([ktx2(2), ktx2(1), ktx2(0)].map(textureDecoder)).toEqual(["ktx2-zstd", "ktx2-basislz", "ktx2"]);
    expect(textureDecoder(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
  });

  it("names Draco or meshopt only for a GLB whose JSON uses that compression", () => {
    expect(modelDecoders(glb({ asset: { version: "2.0" }, extensionsUsed: ["KHR_draco_mesh_compression"] }))).toEqual(["draco"]);
    expect(modelDecoders(glb({ asset: { version: "2.0" }, extensionsUsed: ["EXT_meshopt_compression"] }))).toEqual(["meshopt"]);
    expect(modelDecoders(glb({ asset: { version: "2.0" }, extensionsUsed: ["KHR_materials_emissive_strength"] }))).toEqual([]);
    expect(modelDecoders(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3]))).toEqual([]);
  });

  it("downloads each needed decoder file once, and never the ETC1S transcoder for a UASTC game", async () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(new Uint8Array([1])));
    const prefetch = createDecoderPrefetch(fetchImpl as unknown as typeof fetch, paths);
    prefetch("ktx2-zstd");
    prefetch("ktx2-zstd");
    prefetch("ktx2");
    prefetch("draco");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://game.example/my-game/ktx2/babylon.ktx2Decoder.js",
      "https://game.example/my-game/ktx2/zstddec.wasm",
      "https://game.example/my-game/draco/draco_wasm_wrapper_gltf.js",
      "https://game.example/my-game/draco/draco_decoder_gltf.wasm",
    ]);
  });

  it("ignores a decoder file that cannot be fetched", async () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => { throw new TypeError("offline"); });
    createDecoderPrefetch(fetchImpl as unknown as typeof fetch, paths)("meshopt");
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledWith("https://game.example/my-game/meshopt/meshopt_decoder.js", expect.anything());
  });
});
