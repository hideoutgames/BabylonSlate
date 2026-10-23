import type {
  CubeTexture,
  InternalTexture,
  SphericalPolynomial,
} from "@babylonjs/core";
import { CubeMapToSphericalPolynomialTools } from "@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial";
import type { TextureResources } from "./resource-cache";
import { readEnvironmentBaseRadiance } from "./environment-base-radiance";

interface Preparation {
  hardware: InternalTexture["_hardwareTexture"];
  polynomial: SphericalPolynomial | null;
  error: Error | null;
  pending: boolean;
  listeners: Set<() => void>;
}

const preparations = new WeakMap<InternalTexture, Preparation>();

/**
 * Pinned Babylon 9.29 adapter: inspect existing coefficients without invoking
 * BaseTexture's lazy getter. That getter captures a disposable wrapper across
 * asynchronous readback and dereferences its cleared InternalTexture afterward.
 * Only these owned views override the getter; no prototype or shared data changes.
 */
export function ownEnvironmentIrradiance(
  view: CubeTexture,
  source: CubeTexture,
  cache: TextureResources,
  changed: () => void,
): { isReady(): boolean; dispose(): void } {
  let current: Preparation | undefined;
  let disposed = false;
  Object.defineProperty(view, "sphericalPolynomial", {
    configurable: true,
    get: () => {
      const internal = view.getInternalTexture();
      return (
        internal?._sphericalPolynomial ??
        (current?.hardware === internal?._hardwareTexture
          ? current?.polynomial
          : null) ??
        null
      );
    },
  });
  return {
    isReady() {
      if (disposed) return true;
      const internal = source.getInternalTexture();
      if (!internal?.isReady) return false;
      if (internal._sphericalPolynomial) return true;
      let request = preparations.get(internal);
      if (!request || request.hardware !== internal._hardwareTexture) {
        request = prepare(source, internal, cache);
        preparations.set(internal, request);
      }
      if (current !== request) {
        current?.listeners.delete(changed);
        current = request;
        current.listeners.add(changed);
      }
      if (request.error) throw request.error;
      return !request.pending;
    },
    dispose() {
      disposed = true;
      current?.listeners.delete(changed);
      current = undefined;
    },
  };
}

function prepare(
  source: CubeTexture,
  internal: InternalTexture,
  cache: TextureResources,
): Preparation {
  const request: Preparation = {
    hardware: internal._hardwareTexture,
    polynomial: null,
    error: null,
    pending: true,
    listeners: new Set(),
  };
  const rgbd = source.isRGBD;
  const gamma = source.gammaSpace;
  const exactSrgb = internal.getEngine().useExactSrgbConversions;
  const preparationLease = cache.acquireExisting(source);
  const current = () =>
    source.getInternalTexture() === internal &&
    internal._hardwareTexture === request.hardware;
  void environmentPolynomial(source, current, { rgbd, gamma, exactSrgb })
    .then((polynomial) => {
      if (polynomial) request.polynomial = polynomial;
    })
    .catch((cause) => {
      request.error = new Error("Environment irradiance preparation failed.", {
        cause,
      });
    })
    .finally(() => {
      request.pending = false;
      preparationLease.release();
      for (const notify of request.listeners) notify();
    });
  return request;
}

/**
 * Irradiance coefficients of a cube's base radiance, or null when `current`
 * turned false meanwhile. Encoding flags describe the source as sampled.
 */
export async function environmentPolynomial(
  source: CubeTexture,
  current: () => boolean,
  encoding: { rgbd: boolean; gamma: boolean; exactSrgb: boolean } = {
    rgbd: source.isRGBD,
    gamma: source.gammaSpace,
    exactSrgb: source.getInternalTexture()?.getEngine().useExactSrgbConversions ?? false,
  },
): Promise<SphericalPolynomial | null> {
  // The helper awaits every submitted read before settling, including failures.
  const result = await readEnvironmentBaseRadiance(source, current);
  if (!current() || !result) return null;
  const { size } = result;
  const faces = result.faces.map((pixels) => {
    if (
      !(pixels instanceof Uint8Array || pixels instanceof Float32Array) ||
      pixels.length !== size * size * 4
    )
      throw new Error(
        "Environment irradiance readback returned invalid cube pixels.",
      );
    return linearPixels(
      pixels,
      result.linear ? false : encoding.rgbd,
      result.linear ? false : encoding.gamma,
      encoding.exactSrgb,
    );
  });
  const [right, left, up, down, front, back] = faces;
  return CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial({
    size,
    right,
    left,
    up,
    down,
    front,
    back,
    format: 5,
    type: 1,
    gammaSpace: false,
  });
}

function linearPixels(
  pixels: Uint8Array | Float32Array,
  rgbd: boolean,
  gamma: boolean,
  exactSrgb: boolean,
): Float32Array {
  const result = new Float32Array(pixels.length);
  const scale = pixels instanceof Uint8Array ? 1 / 255 : 1;
  for (let i = 0; i < pixels.length; i += 4) {
    const divisor = rgbd ? pixels[i + 3] * scale : 1;
    if (!(divisor > 0))
      throw new Error("Environment RGBD pixels have a zero divisor.");
    for (let c = 0; c < 3; c++) {
      const encoded = pixels[i + c] * scale;
      // Match the owning Engine's shader decoder, including the editor's
      // exact sRGB setting. Software fallbacks can retain packed RGBD uploads.
      const linear =
        rgbd || gamma
          ? exactSrgb
            ? encoded <= 0.04045
              ? encoded / 12.92
              : ((encoded + 0.055) / 1.055) ** 2.4
            : encoded ** 2.2
          : encoded;
      result[i + c] = linear / divisor;
      if (!Number.isFinite(result[i + c]))
        throw new Error("Environment irradiance contains non-finite radiance.");
    }
    result[i + 3] = 1;
  }
  return result;
}
