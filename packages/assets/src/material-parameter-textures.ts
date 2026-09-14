import { environmentTextureContainer } from "./environment-texture";

/** Canonical loaded Texture assets eligible for a material's 2D sampler parameter. */
export function materialParameterTextureAssetGuids(textures: ReadonlyMap<string, Uint8Array> = new Map()): string[] {
  return [...textures].filter(([, bytes]) => !environmentTextureContainer(bytes)).map(([guid]) => guid);
}
