import { Constants, InternalTexture, InternalTextureSource, NullEngine, SphericalPolynomial } from "@babylonjs/core";
import { vi } from "vitest";

/** Replace only the missing GPU depth allocator; RTT wrappers retain ownership. */
export function mockDepthTextureIO(engine: NullEngine): void {
  vi.spyOn(engine, "createDepthStencilTexture").mockImplementation((size, options) => {
    const texture = new InternalTexture(engine, InternalTextureSource.DepthStencil);
    const dimensions = typeof size === "number" ? { width: size, height: size } : size;
    texture.width = texture.baseWidth = dimensions.width;
    texture.height = texture.baseHeight = dimensions.height;
    texture.format = options.depthTextureFormat ?? Constants.TEXTUREFORMAT_DEPTH24;
    texture.samples = options.samples ?? 1;
    texture.isReady = true;
    engine.getLoadedTexturesCache().push(texture);
    return texture;
  });
}

/** KTX2 header only: identifier, vkFormat (0 = Basis Universal) and base size. */
export function ktx2HeaderBytes(width: number, height: number, vkFormat = 0): Uint8Array {
  const bytes = new Uint8Array(48);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, vkFormat, true);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  return bytes;
}

/** Keep Babylon wrappers and reference counts; NullEngine has no cube upload/readback driver. */
export function mockCubeTextureIO(engine: NullEngine): void {
  vi.spyOn(engine, "createCubeTexture").mockImplementation((url, _scene, _files, noMipmap) => {
    const internal = engine.createTexture(url, noMipmap ?? false, false, null);
    internal.isCube = true;
    internal._sphericalPolynomial = new SphericalPolynomial();
    return internal;
  });
}
