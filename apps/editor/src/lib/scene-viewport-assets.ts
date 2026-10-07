import { getRequiredDependencies, type IndexedAsset } from "@babylonslate/assets";
import { areaEmissionTextureGuids, type SerializedScene } from "@babylonslate/core";
import {
  environmentTextureGuidsFromScenes, materialGuidsFromScenes, modelAssetGuidsFromScene,
  overlayTextureGuidsFromScene, playFontGuidsFromScenes, postProcessTextureGuidsFromScenes,
  skyboxFaceGuidsFromScene, spriteAssetGuidsFromScene, tilemapAssetGuidsFromScene,
} from "./play-content";
import { assetHeaderDependencyMetadata } from "./content-browser-helpers";

const resourceTypes = new Set(["Water", "Material", "MaterialInstance", "MaterialFunction", "RenderTarget", "RenderTargetTexture", "Model", "Texture", "Sprite",
  "SpriteAnimation", "Tilemap", "Tileset", "Font", "Animation", "Skeleton"]);

/** Live authored values choose roots; deferred Scene/prefab references stay cold. */
export function sceneViewportRequiredAssets(scene: SerializedScene, assets: readonly IndexedAsset[], extraGuids: readonly string[] = []): Set<string> {
  const byGuid = new Map(assets.map((asset) => [asset.header.guid, asset]));
  const pending = [...assetHeaderDependencyMetadata("Scene", scene as unknown as Record<string, unknown>, assets).requiredDependencies, ...extraGuids];
  const result = new Set<string>();
  while (pending.length) {
    const guid = pending.pop()!;
    if (result.has(guid)) continue;
    result.add(guid);
    const asset = byGuid.get(guid);
    if (asset && !asset.placeholder) pending.push(...getRequiredDependencies(asset.header));
  }
  return result;
}

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
