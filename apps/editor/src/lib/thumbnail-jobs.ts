import { isThumbnailableAssetType, type IndexedAsset } from "@haptic/assets";
import { createAssetThumbnailRevisionIndex } from "./asset-thumbnail-revision";
import type { ModelThumbnailJob } from "./model-thumbnail-queue";

/** Textures first: they draw without the Engine, so a new project's grid fills fastest. */
const ORDER: Record<string, number> = { Texture: 0, Tileset: 1, Tilemap: 1 };

/**
 * Generation jobs for those of `guids` that have thumbnails: Textures, Models,
 * Animations, Materials, Tilesets, Tilemaps and actor Classes that show a
 * Prefab. Each carries its saved revision, so a later edit supersedes it.
 */
export async function thumbnailJobsFor(
  assets: readonly IndexedAsset[],
  guids: readonly string[],
  projectGuid: string,
  pixelsPerUnit?: number,
  options: { onlyIfMissing?: boolean } = {},
): Promise<ModelThumbnailJob[]> {
  const byGuid = new Map(assets.map((asset) => [asset.header.guid, asset]));
  const revisions = createAssetThumbnailRevisionIndex(assets, pixelsPerUnit);
  const jobs: ModelThumbnailJob[] = [];
  for (const guid of guids) {
    const asset = byGuid.get(guid);
    if (!asset || asset.placeholder) continue;
    const type = asset.header.type as NonNullable<ModelThumbnailJob["type"]>;
    if (!isThumbnailableAssetType(type)) continue;
    // A Class without a Prefab (a component, an interface) has nothing to draw.
    if (type === "Class" && revisions.revision(guid) === null) continue;
    jobs.push({
      guid, path: asset.path, type, payload: asset.header.payload,
      projectGuid, cacheKey: await revisions.cacheKey(guid) ?? guid,
      ...(options.onlyIfMissing ? { onlyIfMissing: true } : {}),
    });
  }
  return jobs.sort((a, b) => (ORDER[a.type!] ?? 2) - (ORDER[b.type!] ?? 2));
}
