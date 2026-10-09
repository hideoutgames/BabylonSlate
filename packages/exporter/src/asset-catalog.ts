import { classIdForAssetPath, type RuntimeAssetCatalogEntry } from "@babylonslate/core";
import type { ExportIndexedAsset, GameAssetIndexEntry } from "./types";

const isClassType = (type: string): boolean => type === "Class" || type === "Graph";

/**
 * Catalog entries for indexed headers, such as the packaged set Editor Play
 * lists or the whole registry an editor graph host lists. Headers without a
 * storage path (a missing-asset placeholder) are not assets.
 */
export function runtimeAssetCatalogFromIndexed(
  assets: readonly ExportIndexedAsset[],
  /** Keeps only these guids; omitted keeps every asset. */
  include?: ReadonlySet<string>,
): RuntimeAssetCatalogEntry[] {
  const entries: RuntimeAssetCatalogEntry[] = [];
  for (const asset of assets) {
    if (!asset.path || (include && !include.has(asset.guid))) continue;
    const parentClass = asset.parentClass?.trim();
    entries.push({
      guid: asset.guid,
      name: asset.name,
      type: asset.type,
      path: asset.path,
      ...(isClassType(asset.type) ? { classId: classIdForAssetPath(asset.path) } : {}),
      ...(isClassType(asset.type) && parentClass ? { parentClass } : {}),
      dependencies: [...asset.dependencies],
      requiredDependencies: [...(asset.requiredDependencies ?? [])],
    });
  }
  return entries;
}

/**
 * Catalog entries for an exported game. Only exported authored assets carry
 * `assetPath`; compiled scripts, sidecars and other generated entries do not.
 */
export function runtimeAssetCatalogFromManifest(
  assets: readonly GameAssetIndexEntry[],
): RuntimeAssetCatalogEntry[] {
  const entries: RuntimeAssetCatalogEntry[] = [];
  for (const asset of assets) {
    if (!asset.assetPath) continue;
    entries.push({
      guid: asset.guid,
      name: asset.name ?? "",
      type: asset.type,
      path: asset.assetPath,
      ...(isClassType(asset.type) ? { classId: asset.classId ?? classIdForAssetPath(asset.assetPath) } : {}),
      ...(isClassType(asset.type) && asset.parentClass ? { parentClass: asset.parentClass } : {}),
      dependencies: [...(asset.dependencies ?? [])],
      requiredDependencies: [...(asset.requiredDependencies ?? [])],
    });
  }
  return entries;
}
