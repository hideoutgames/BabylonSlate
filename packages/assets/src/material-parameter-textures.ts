import { environmentTextureContainer } from "./environment-texture";

/** Canonical loaded Texture assets eligible for a material's 2D sampler parameter. */
export function materialParameterTextureAssetGuids(
  textures: ReadonlyMap<string, Uint8Array> = new Map(),
  renderTargetTextures: ReadonlyMap<string, unknown> = new Map(),
): string[] {
  return [...new Set([...textures]
    .filter(([, bytes]) => !environmentTextureContainer(bytes))
    .map(([guid]) => guid).concat([...renderTargetTextures.keys()]))];
}
