import { NullEngine, SphericalPolynomial } from "@babylonjs/core";
import { vi } from "vitest";

/** Keep Babylon wrappers and reference counts; NullEngine has no cube upload/readback driver. */
export function mockCubeTextureIO(engine: NullEngine): void {
  vi.spyOn(engine, "createCubeTexture").mockImplementation((url, _scene, _files, noMipmap) => {
    const internal = engine.createTexture(url, noMipmap ?? false, false, null);
    internal.isCube = true;
    internal._sphericalPolynomial = new SphericalPolynomial();
    return internal;
  });
}
