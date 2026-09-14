import {
  Constants,
  RawTexture,
  Texture,
  type AbstractEngine,
} from "@babylonjs/core";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { BakedIrradianceAtlas } from "@babylonslate/core";

/** Only managed bake atlas/geometry allocations, not total Engine or driver memory. */
const MAX_BYTES = 64 * 1024 * 1024;
interface AtlasEntry {
  refs: number;
  ready: Promise<RawTexture>;
}
interface Pool {
  bytes: number;
  quarantined: boolean;
  atlases: Map<string, AtlasEntry>;
}
const pools = new WeakMap<AbstractEngine, Pool>();
function poolFor(engine: AbstractEngine): Pool {
  let pool = pools.get(engine);
  if (!pool) {
    pool = { bytes: 0, quarantined: false, atlases: new Map() };
    pools.set(engine, pool);
  }
  return pool;
}

export function reserveBakedGpuBytes(
  engine: AbstractEngine,
  bytes: number,
  ceiling = MAX_BYTES,
) {
  const pool = poolFor(engine);
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    !Number.isSafeInteger(ceiling) ||
    ceiling < 0 ||
    ceiling > MAX_BYTES
  )
    throw new Error("Invalid managed bake GPU allocation budget.");
  if (engine.isDisposed || pool.quarantined)
    throw new Error(
      "Baked graphics resources are unavailable until the Engine is recreated.",
    );
  if (pool.bytes + bytes > ceiling)
    throw new Error(
      "Baked lighting exceeds the managed GPU allocation budget, including the previous binding.",
    );
  pool.bytes += bytes;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      pool.bytes -= bytes;
    },
    quarantine() {
      pool.quarantined = true;
    },
  };
}

export function bakedGpuAllocationStatus(engine: AbstractEngine) {
  const pool = poolFor(engine);
  return { managedBytes: pool.bytes, quarantined: pool.quarantined };
}

/** Synchronous scope closure keeps unrelated Scene work outside WebGPU error scopes. */
export function beginBakedUpload(engine: AbstractEngine): () => Promise<void> {
  if (engine.isWebGPU) {
    // Pinned Babylon 9.20 adapter: the owning device is exposed by WebGPUEngine.
    const device = (engine as WebGPUEngine)._device;
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    return () => {
      const validation = device.popErrorScope();
      const memory = device.popErrorScope();
      return Promise.all([
        validation,
        memory,
        device.queue.onSubmittedWorkDone(),
      ]).then(([invalid, oom]) => {
        if (invalid || oom)
          throw new Error(
            `Baked lighting upload failed: ${(invalid ?? oom)!.message}`,
          );
      });
    };
  }
  const gl = (engine as AbstractEngine & { _gl?: WebGL2RenderingContext })._gl;
  if (!gl) return async () => {}; // NullEngine has no GPU; real backend proofs cover upload.
  if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR)
    throw new Error(
      "Baked lighting cannot upload while the owning graphics context has an error.",
    );
  return async () => {
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR)
      throw new Error("Baked lighting GPU upload failed.");
  };
}

/** One Engine-owned linear RGBA32F allocation for each validated content generation. */
export async function acquireBakedAtlas(
  engine: AbstractEngine,
  atlas: BakedIrradianceAtlas,
  bytes: Uint8Array,
  ceiling?: number,
): Promise<{ texture: RawTexture; release(): void }> {
  const caps = engine.getCaps();
  if (
    !caps.textureFloat ||
    !caps.textureFloatLinearFiltering ||
    atlas.width > caps.maxTextureSize ||
    atlas.height > caps.maxTextureSize
  )
    throw new Error(
      "This graphics device cannot sample the bake's linear floating-point atlas.",
    );
  const key = `${atlas.sha256}:${atlas.width}:${atlas.height}`;
  const pool = poolFor(engine);
  if (pool.quarantined)
    throw new Error(
      "Baked graphics resources are quarantined until the Engine is recreated.",
    );
  let entry = pool.atlases.get(key);
  if (!entry) {
    const reservation = reserveBakedGpuBytes(
      engine,
      atlas.width * atlas.height * 16,
      ceiling,
    );
    let texture: RawTexture | undefined;
    let constructorStarted = false;
    const ready = Promise.resolve()
      .then(async () => {
        if (engine.isDisposed)
          throw new Error("The baked upload Engine was disposed.");
        if (bytes.byteLength !== atlas.width * atlas.height * 16)
          throw new Error("Baked atlas byte length changed.");
        const values = new Float32Array(bytes.byteLength / 4);
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        for (let index = 0; index < values.length; index++)
          values[index] = view.getFloat32(index * 4, true);
        const complete = beginBakedUpload(engine);
        let failure: unknown;
        try {
          constructorStarted = true;
          texture = new RawTexture(
            values,
            atlas.width,
            atlas.height,
            Constants.TEXTUREFORMAT_RGBA,
            engine,
            false,
            false,
            Texture.BILINEAR_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT,
            0,
            false,
          );
          texture.name = `Baked irradiance ${atlas.sha256}`;
          texture.gammaSpace = false;
          texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
        } catch (error) {
          failure = error;
        }
        await complete();
        if (failure) throw failure;
        if (
          !texture?.isReady() ||
          texture.getInternalTexture()?.type !== Constants.TEXTURETYPE_FLOAT
        )
          throw new Error(
            "The baked irradiance upload is not ready in its required format.",
          );
        return texture;
      })
      .catch((error: unknown) => {
        try {
          if (texture) texture.dispose();
          else if (constructorStarted) {
            // A throwing native constructor may hide a partially created handle.
            reservation.quarantine();
            throw error;
          }
          reservation.release();
        } catch (cleanup) {
          reservation.quarantine();
          if (cleanup !== error)
            throw new AggregateError(
              [error, cleanup],
              "Baked atlas cleanup failed.",
            );
        }
        throw error;
      });
    entry = { refs: 0, ready };
    pool.atlases.set(key, entry);
    const owned = entry;
    // The successful texture owns this reservation until the final sampling lease.
    releases.set(owned, () => {
      try {
        texture!.dispose();
        reservation.release();
      } catch (error) {
        reservation.quarantine();
        throw error;
      }
    });
  }
  entry.refs++;
  let texture: RawTexture;
  try {
    texture = await entry.ready;
  } catch (error) {
    if (--entry.refs === 0 && pool.atlases.get(key) === entry)
      pool.atlases.delete(key);
    throw error;
  }
  const owned = entry;
  let released = false;
  return {
    texture,
    release() {
      if (released) return;
      released = true;
      if (--owned.refs !== 0) return;
      if (pool.atlases.get(key) === owned) pool.atlases.delete(key);
      releases.get(owned)!();
      releases.delete(owned);
    },
  };
}
const releases = new WeakMap<AtlasEntry, () => void>();
