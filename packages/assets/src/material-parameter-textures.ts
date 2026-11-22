import { assetSourceHeader } from "./installed-asset";
import { environmentTextureContainer } from "./environment-texture";

/** Canonical loaded Texture assets eligible for a material's 2D sampler parameter. */
export function materialParameterTextureAssetGuids(
  textures: ReadonlyMap<string, Uint8Array | Blob> = new Map(),
  renderTargetTextures: ReadonlyMap<string, unknown> = new Map(),
): string[] {
  return [...new Set([...textures]
    .filter(([, source]) => { const header = assetSourceHeader(source); return !header || !environmentTextureContainer(header); })
    .map(([guid]) => guid).concat([...renderTargetTextures.keys()]))];
}
