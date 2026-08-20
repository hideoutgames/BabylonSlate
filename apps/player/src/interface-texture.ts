import type { AbstractEngine, Texture } from "@babylonjs/core";
import { getMaterialTexture, type ResourceCache } from "@babylonslate/render";

/** Packed-player Interface materials reuse the Engine ResourceCache. */
export function resolvePlayerInterfaceTexture(
  cache: ResourceCache,
  engine: AbstractEngine,
  guid: string,
  bytes: Uint8Array | Blob,
): Texture | null {
  return getMaterialTexture(cache, guid, engine, bytes);
}
