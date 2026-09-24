import type { IndexedAsset } from "@babylonslate/assets";
import { areaEmissionTextureGuids, type SerializedScene } from "@babylonslate/core";
import {
  environmentTextureGuidsFromScenes, materialGuidsFromScenes, modelAssetGuidsFromScene,
  overlayTextureGuidsFromScene, playFontGuidsFromScenes, postProcessTextureGuidsFromScenes,
  skyboxFaceGuidsFromScene, spriteAssetGuidsFromScene, tilemapAssetGuidsFromScene,
} from "./play-content";

const resourceTypes = new Set(["Material", "MaterialFunction", "Model", "Texture", "Sprite",
  "SpriteAnimation", "Tilemap", "Tileset", "Font", "Animation", "Skeleton"]);

/** Match the viewport collectors. Transforms and scene autosaves do not alter
 * their inputs. Include saved resource revisions for transitive model slots,
 * material functions, fonts and late texture/emission publication. */
export function sceneViewportAssetKey(scene: SerializedScene | null, assets: readonly IndexedAsset[]): string {
  const guids = new Set([
    ...spriteAssetGuidsFromScene(scene), ...tilemapAssetGuidsFromScene(scene),
    ...modelAssetGuidsFromScene(scene), ...materialGuidsFromScenes([scene]),
    ...playFontGuidsFromScenes([scene]), ...environmentTextureGuidsFromScenes([scene]),
    ...postProcessTextureGuidsFromScenes([scene]), ...skyboxFaceGuidsFromScene(scene),
    ...overlayTextureGuidsFromScene(scene), ...areaEmissionTextureGuids(scene),
  ]);
  return JSON.stringify([
    [...guids].sort(),
    assets.filter(({ header }) => resourceTypes.has(header.type))
      .sort((a, b) => a.header.guid.localeCompare(b.header.guid))
      .map(({ header }) => [header.guid, header.type, header.payload,
        header.chunks.map((chunk) => [chunk.id, chunk.sha256])]),
  ]);
}
