import { Constants, RawTexture, type AbstractEngine } from "@babylonjs/core";
import type { AreaEmissionPixels } from "@babylonslate/assets";
import { beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal, type ManagedRenderLease } from "./managed-render-resources";

// RGBA8 1024-square, complete native mip chain including 1x1.
export const AREA_EMISSION_TEXTURE_BYTES = 5_592_404;
type Entry = { texture: RawTexture; references: number; lease: ManagedRenderLease };
const caches = new WeakMap<AbstractEngine, Map<string, Entry>>();
export function areaEmissionResourceKey(pixels: AreaEmissionPixels): string {
  return `${pixels.metadata.processor}:${pixels.metadata.pixelsHash}`;
}

/** Upload validated, prepared bytes only. No image decoding or filtering in gameplay. */
export function retainAreaEmissionTexture(engine: AbstractEngine, pixels: AreaEmissionPixels): { texture: RawTexture; release: () => void } {
  const key = areaEmissionResourceKey(pixels);
  let cache = caches.get(engine);
  if (!cache) { cache = new Map(); caches.set(engine, cache); }
  let entry = cache.get(key);
  if (!entry) {
    const lease = beginManagedRenderAllocation(engine, AREA_EMISSION_TEXTURE_BYTES);
    if (!lease) throw new Error("Area emission texture exceeds the managed rendering memory budget.");
    let texture: RawTexture | undefined;
    try {
      texture = RawTexture.CreateRGBATexture(pixels.rgba, pixels.metadata.width, pixels.metadata.height, engine, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
      texture.name = `slate:areaEmission:${pixels.metadata.pixelsHash}`;
      texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
      texture.gammaSpace = true;
      lease.commit([{ handle: texture.getInternalTexture()!, bytes: AREA_EMISSION_TEXTURE_BYTES, category: "areaLight" }]);
      entry = { texture, references: 0, lease };
      cache.set(key, entry);
    } catch (error) { texture?.dispose(); void releaseManagedRenderLeaseAfterDisposal(engine, lease); throw error; }
  }
  entry.references++;
  let released = false;
  return { texture: entry.texture, release: () => {
    if (released) return;
    released = true;
    if (--entry!.references !== 0) return;
    cache!.delete(key);
    entry!.texture.dispose();
    void releaseManagedRenderLeaseAfterDisposal(engine, entry!.lease);
  } };
}
