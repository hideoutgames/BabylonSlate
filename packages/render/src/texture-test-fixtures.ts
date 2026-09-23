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
    texture.isReady = true;
    engine.getLoadedTexturesCache().push(texture);
    return texture;
  });
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
