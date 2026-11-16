import { describe, expect, it, vi } from "vitest";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture";
import { KhronosTextureContainer2 } from "@babylonjs/core/Misc/khronosTextureContainer2";
import { ktx2HeaderBytes } from "./texture-test-fixtures";

/**
 * Decoder options the patched `_uploadAsync` hands the transcoder for `bytes`.
 * The real container runs without its decoder module: decoding and the GPU
 * upload are stubbed, so only the per-texture RGBA decision executes.
 */
function stubbedContainer() {
  const container = Object.create(KhronosTextureContainer2.prototype) as KhronosTextureContainer2;
  Object.assign(container, { _engine: { getCaps: () => ({ astc: {}, bptc: {} }) } });
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

async function uploadDecodeOptions(bytes: Uint8Array): Promise<unknown> {
  const { container, decode, create } = stubbedContainer();
  await container._uploadAsync(bytes, liveTexture());
  expect(create).toHaveBeenCalledOnce();
  return decode.mock.calls[0]![1];
}

describe("KTX2 upload (Babylon patch)", () => {
  it.each([
    ["a 1x1 Basis texture", ktx2HeaderBytes(1, 1)],
  ])("leaves %s to the decoder's own choice", async (_case, bytes) => {
    expect(await uploadDecodeOptions(bytes)).toBeUndefined();
  });
});

describe("KTX2 upload of a texture disposed while it decodes (Babylon patch)", () => {
  it("skips the upload, since binding a released texture binds nothing", async () => {
    const { container, create } = stubbedContainer();
    const texture = liveTexture();
    const upload = container._uploadAsync(ktx2HeaderBytes(4, 4), texture);
    // InternalTexture.dispose releases the GPU texture while the transcoder still runs.
    texture._hardwareTexture = null;
    await upload;
    expect(create).not.toHaveBeenCalled();
  });
});
