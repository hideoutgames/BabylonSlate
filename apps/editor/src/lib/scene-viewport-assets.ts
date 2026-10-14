import type { IndexedAsset } from "@babylonslate/assets";
import { areaEmissionTextureGuids, type SerializedScene } from "@babylonslate/core";
import {
  environmentTextureGuidsFromScenes, materialGuidsFromScenes, modelAssetGuidsFromScene,
  overlayTextureGuidsFromScene, playFontGuidsFromScenes, postProcessTextureGuidsFromScenes, materialInstanceTextureGuidsFromScenes,
  skyboxFaceGuidsFromScene, spriteAssetGuidsFromScene, tilemapAssetGuidsFromScene,
} from "./play-content";
import { assetHeaderDependencyMetadata } from "./content-browser-helpers";
import { textureContentSignature, textureEncodingSignature } from "./texture-upload-signature";

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
    if (asset && !asset.placeholder) pending.push(...asset.header.requiredDependencies);
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
    ...postProcessTextureGuidsFromScenes([scene]), ...materialInstanceTextureGuidsFromScenes([scene]), ...skyboxFaceGuidsFromScene(scene),
    ...overlayTextureGuidsFromScene(scene), ...areaEmissionTextureGuids(scene),
  ]);
  return `${JSON.stringify([...guids].sort())}\n${resourceRevisionKey(assets)}`;
}

type ResourceSource = readonly [asset: IndexedAsset, header: unknown, payload: unknown, chunks: unknown];
let resourceKeyCache: { sources: readonly ResourceSource[]; key: string } | null = null;

/** Scene edits recompute the asset key; reuse the resource part while the
 * registry still holds the same headers, payloads and chunk lists. */
function resourceRevisionKey(assets: readonly IndexedAsset[]): string {
  const resources = assets.filter(({ header }) => resourceTypes.has(header.type));
  const cached = resourceKeyCache;
  if (cached && cached.sources.length === resources.length && resources.every((asset, index) => {
    const [source, header, payload, chunks] = cached.sources[index]!;
    return source === asset && header === asset.header && payload === asset.header.payload && chunks === asset.header.chunks;
  })) return cached.key;
  const key = JSON.stringify([...resources]
    .sort((a, b) => a.header.guid.localeCompare(b.header.guid))
    // A Texture's stored encoding changes without touching what it shows; that is
    // `sceneViewportTextureEncodings`, so an encode never reloads the viewport.
    .map(({ header }) => header.type === "Texture"
      ? [header.guid, header.type, ...textureContentSignature(header)]
      : [header.guid, header.type, header.payload, header.chunks.map((chunk) => [chunk.id, chunk.sha256])]));
  resourceKeyCache = {
    sources: resources.map((asset): ResourceSource => [asset, asset.header, asset.header.payload, asset.header.chunks]),
    key,
  };
  return key;
}

/**
 * How each Texture is stored (committed KTX2 and retained encodes), by guid.
 * A change here with an unchanged `sceneViewportAssetKey` means only the stored
 * representation of the same pixels and settings changed.
 */
export function sceneViewportTextureEncodings(assets: readonly IndexedAsset[]): Map<string, string> {
  const encodings = new Map<string, string>();
  for (const { header } of assets) {
    if (header.type === "Texture") encodings.set(header.guid, textureEncodingSignature(header));
  }
  return encodings;
}

/** Installed Textures whose stored encoding differs from the one the viewport applied. */
export function changedTextureEncodings(applied: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): string[] {
  const changed: string[] = [];
  for (const [guid, signature] of applied) {
    if ((current.get(guid) ?? "") !== signature) changed.push(guid);
  }
  return changed;
}
