import type {
  CubeTexture,
  InternalTexture,
  SphericalPolynomial,
} from "@babylonjs/core";
import { CubeMapToSphericalPolynomialTools } from "@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial";
import type { ResourceCache } from "./resource-cache";

interface Preparation {
  hardware: InternalTexture["_hardwareTexture"];
  polynomial: SphericalPolynomial | null;
  error: Error | null;
  pending: boolean;
  listeners: Set<() => void>;
}

const preparations = new WeakMap<InternalTexture, Preparation>();

/**
 * Pinned Babylon 9.20 adapter: inspect existing coefficients without invoking
 * BaseTexture's lazy getter. That getter captures a disposable wrapper across
 * asynchronous readback and dereferences its cleared InternalTexture afterward.
 * Only these owned views override the getter; no prototype or shared data changes.
 */
export function ownEnvironmentIrradiance(
  view: CubeTexture,
  source: CubeTexture,
  cache: ResourceCache,
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
  cache: ResourceCache,
): Preparation {
  const request: Preparation = {
    hardware: internal._hardwareTexture,
    polynomial: null,
    error: null,
    pending: true,
    listeners: new Set(),
  };
  // Import validates a complete authored roughness mip chain. Reading an
  // existing <=32px mip bounds temporary CPU memory independently of asset size.
  const width = source.getSize().width;
  const level = Math.max(0, Math.ceil(Math.log2(width / 32)));
  const size = Math.max(1, width / 2 ** level);
  const rgbd = source.isRGBD;
  const gamma = source.gammaSpace;
  cache.retain(source);
  const reads = Array.from({ length: 6 }, (_, face) =>
    Promise.resolve().then(() =>
      source.readPixels(face, level, undefined, false),
    ),
  );
  // Await every submitted read, including after one fails, before releasing the
  // upload lease. Closing both Scenes cannot evict an in-flight GPU readback.
  void Promise.allSettled(reads).then((results) => {
    try {
      if (
        source.getInternalTexture() !== internal ||
        internal._hardwareTexture !== request.hardware
      )
        return;
      const faces = results.map((result) => {
        if (result.status === "rejected") throw result.reason;
        const pixels = result.value;
        if (
          !(pixels instanceof Uint8Array || pixels instanceof Float32Array) ||
          pixels.length !== size * size * 4
        )
          throw new Error(
            "Environment irradiance readback returned invalid cube pixels.",
          );
        return linearPixels(pixels, rgbd, gamma);
      });
      const [right, left, up, down, front, back] = faces;
      request.polynomial =
        CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial({
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
    } catch (cause) {
      request.error = new Error("Environment irradiance preparation failed.", {
        cause,
      });
    } finally {
      request.pending = false;
      cache.release(source);
      for (const notify of request.listeners) notify();
    }
  });
  return request;
}

function linearPixels(
  pixels: Uint8Array | Float32Array,
  rgbd: boolean,
  gamma: boolean,
): Float32Array {
  const result = new Float32Array(pixels.length);
  const scale = pixels instanceof Uint8Array ? 1 / 255 : 1;
  for (let i = 0; i < pixels.length; i += 4) {
    const divisor = rgbd ? pixels[i + 3] * scale : 1;
    if (!(divisor > 0))
      throw new Error("Environment RGBD pixels have a zero divisor.");
    for (let c = 0; c < 3; c++) {
      const encoded = pixels[i + c] * scale;
      // Babylon's ENV RGBD decoder uses its default 2.2 gamma conversion.
      const linear = rgbd || gamma ? encoded ** 2.2 : encoded;
      result[i + c] = linear / divisor;
      if (!Number.isFinite(result[i + c]))
        throw new Error("Environment irradiance contains non-finite radiance.");
    }
    result[i + 3] = 1;
  }
  return result;
}
