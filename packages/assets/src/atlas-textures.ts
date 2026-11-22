import { parseSpriteAnimationPayload, spriteAnimationTextureGuids } from "./sprite-animation-payload";
import { normalizeTilesetPayload } from "./tileset-payload";

/**
 * Asset types that sample a Texture as an atlas (tile cells, sprite frames).
 * Those textures encode at their own size: padding them to the 4-texel grid
 * would resample the image under their pixel rects.
 */
export const ATLAS_REFERRER_TYPES: ReadonlySet<string> = new Set(["Tileset", "Sprite", "SpriteAnimation"]);

/** Header meta listing a referrer's atlas textures, written on every save. */
export const ATLAS_TEXTURES_META = "atlasTextures";

/** Texture guids an asset of `type` samples as an atlas. Every Sprite counts, even a whole-texture frame. */
export function atlasTextureGuids(type: string, payload: Record<string, unknown>): string[] {
  if (type === "Tileset") {
    const guid = normalizeTilesetPayload(payload).textureGuid;
    return guid ? [guid] : [];
  }
  if (type === "Sprite") {
    const guid = payload.textureGuid;
    return typeof guid === "string" && guid.length > 0 ? [guid] : [];
  }
  if (type === "SpriteAnimation") {
    return spriteAnimationTextureGuids(parseSpriteAnimationPayload(payload));
  }
  return [];
}

/** Atlas textures a referrer's header lists; every write of a referrer lists them. */
export function headerAtlasTextureGuids(payload: Record<string, unknown>): string[] {
  const listed = payload[ATLAS_TEXTURES_META];
  if (!Array.isArray(listed)) return [];
  return listed.filter((guid): guid is string => typeof guid === "string" && guid.length > 0);
}
