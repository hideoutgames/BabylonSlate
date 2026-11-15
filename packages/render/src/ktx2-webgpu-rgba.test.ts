import { describe, expect, it, vi } from "vitest";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture";
import { KhronosTextureContainer2 } from "@babylonjs/core/Misc/khronosTextureContainer2";
import { ktx2HeaderBytes } from "./texture-test-fixtures";

/**
 * Decoder options the patched `_uploadAsync` hands the transcoder for `bytes`.
 * The real container runs without its decoder module: decoding and the GPU
 * upload are stubbed, so only the per-texture RGBA decision executes.
 */
function stubbedContainer(webgpu: boolean) {
  const container = Object.create(KhronosTextureContainer2.prototype) as KhronosTextureContainer2;
  Object.assign(container, { _engine: { isWebGPU: webgpu, getCaps: () => ({ astc: {}, bptc: {} }) } });
  const decode = vi.spyOn(container, "_decodeAsync").mockResolvedValue({} as Awaited<ReturnType<KhronosTextureContainer2["_decodeAsync"]>>);
  const create = vi
    .spyOn(container as unknown as { _createTexture: () => void }, "_createTexture")
    .mockImplementation(() => {});
  return { container, decode, create };
}

/** A texture that still owns its GPU texture, as a live one does. */
function liveTexture(): InternalTexture & { _hardwareTexture: unknown } {
  return { _hardwareTexture: {} } as unknown as InternalTexture & { _hardwareTexture: unknown };
}

async function uploadDecodeOptions(webgpu: boolean, bytes: Uint8Array): Promise<unknown> {
  const { container, decode, create } = stubbedContainer(webgpu);
  await container._uploadAsync(bytes, liveTexture());
  expect(create).toHaveBeenCalledOnce();
  return decode.mock.calls[0]![1];
}

/** `header` at a non-zero offset inside a larger buffer, as a loader's view may be. */
function offsetView(header: Uint8Array): Uint8Array {
  const buffer = new Uint8Array(header.byteLength + 16);
  buffer.set(header, 16);
  return buffer.subarray(16);
}

describe("KTX2 upload on WebGPU (Babylon patch)", () => {
  it.each([
    ["a 1x1 Basis texture", true, ktx2HeaderBytes(1, 1)],
    ["a Basis texture with one edge off the grid", true, ktx2HeaderBytes(8, 6)],
  ])("decodes %s to RGBA", async (_case, webgpu, bytes) => {
    expect(await uploadDecodeOptions(webgpu, bytes)).toEqual({ forceRGBA: true });
  });

  it.each([
    ["a Basis texture in whole 4x4 blocks on WebGPU", true, ktx2HeaderBytes(4, 8)],
    ["a 4x4 Basis view at a buffer offset", true, offsetView(ktx2HeaderBytes(4, 4))],
    ["a 1x1 Basis texture on WebGL2", false, ktx2HeaderBytes(1, 1)],
    // VK_FORMAT_R8G8B8A8_UNORM: an uncompressed KTX2 uploads as authored.
    ["a 1x1 uncompressed KTX2 on WebGPU", true, ktx2HeaderBytes(1, 1, 37)],
    ["a header too short to size", true, ktx2HeaderBytes(1, 1).subarray(0, 24)],
  ])("leaves %s to the decoder's own choice", async (_case, webgpu, bytes) => {
    expect(await uploadDecodeOptions(webgpu, bytes)).toBeUndefined();
  });
});

describe("KTX2 upload of a texture disposed while it decodes (Babylon patch)", () => {
  it("skips the upload, since binding a released texture binds nothing", async () => {
    const { container, create } = stubbedContainer(false);
    const texture = liveTexture();
    const upload = container._uploadAsync(ktx2HeaderBytes(4, 4), texture);
    // InternalTexture.dispose releases the GPU texture while the transcoder still runs.
    texture._hardwareTexture = null;
    await upload;
    expect(create).not.toHaveBeenCalled();
  });
});
