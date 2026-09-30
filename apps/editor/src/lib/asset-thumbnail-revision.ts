import { sha256Hex, stableStringify, type IndexedAsset } from "@babylonslate/assets";
import { DEFAULT_TWO_D_PROJECT_SETTINGS } from "@babylonslate/core";
import {
  classDocumentShowsPrefab,
  classIdFromClassAsset,
  classParentLookup,
} from "./content-browser-helpers";

export type AssetThumbnailWriteIdentity = { projectGuid: string; cacheKey: string };

/** Header-only revision lookup. Payloads and source bytes are loaded only for capture. */
export function createAssetThumbnailRevisionIndex(
  assets: readonly IndexedAsset[],
  pixelsPerUnit = DEFAULT_TWO_D_PROJECT_SETTINGS.pixelsPerUnit,
) {
  const byGuid = new Map(assets.map((asset) => [asset.header.guid, asset]));
  const classes = assets.filter((asset) => asset.header.type === "Class" || asset.header.type === "Graph");
  const byClassId = new Map(classes.flatMap((asset) => [
    [classIdFromClassAsset(asset), asset] as const,
    [asset.header.name, asset] as const,
  ]));
  const parentOf = classParentLookup(assets);
  const revisions = new Map<string, string | null>();
  const keys = new Map<string, Promise<string | null>>();
  function remember(guid: string, value: string | null) {
    revisions.set(guid, value);
    // Keep dependency signatures bounded as users browse large projects.
    if (revisions.size > 256) {
      const oldest = revisions.keys().next().value!;
      revisions.delete(oldest);
      keys.delete(oldest);
    }
    return value;
  }

  function revision(guid: string): string | null {
    if (revisions.has(guid)) return revisions.get(guid)!;
    const asset = byGuid.get(guid);
    const type = asset?.header.type;
    if (!asset || (type !== "Material" && !(
      (type === "Class" || type === "Graph") &&
      classDocumentShowsPrefab(asset.header.parentClass, parentOf, { assetType: type })
    ))) {
      return remember(guid, null);
    }

    const visited = new Set<string>();
    const pending = [guid];
    const entries: Array<[string, unknown]> = [];
    while (pending.length) {
      const dependency = pending.pop()!;
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      const current = byGuid.get(dependency);
      if (!current || current.placeholder) {
        entries.push([dependency, null]);
        continue;
      }
      const { header } = current;
      entries.push([dependency, {
        type: header.type,
        version: header.version,
        parentClass: header.parentClass ?? null,
        payload: header.payload,
        chunks: header.chunks.map(({ id, kind, mime, sha256 }) => ({ id, kind, mime, sha256 }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }]);
      pending.push(...header.dependencies);
      // Older saved classes may omit their parent from dependencies[].
      if (header.type === "Class" || header.type === "Graph") {
        const parent = header.parentClass ? byClassId.get(header.parentClass) : undefined;
        if (parent) pending.push(parent.header.guid);
      }
    }
    entries.sort(([a], [b]) => a.localeCompare(b));
    const value = stableStringify(type === "Material" ? entries : { pixelsPerUnit, assets: entries });
    return remember(guid, value);
  }

  function cacheKey(guid: string): Promise<string | null> {
    const cached = keys.get(guid);
    if (cached) return cached;
    const value = revision(guid);
    const key = value === null ? Promise.resolve(null) :
      sha256Hex(new TextEncoder().encode(value)).then((digest) => `${guid}.preview-v1.${digest}`);
    keys.set(guid, key);
    return key;
  }

  const matches = (current: readonly IndexedAsset[], currentPixelsPerUnit = DEFAULT_TWO_D_PROJECT_SETTINGS.pixelsPerUnit): boolean =>
    currentPixelsPerUnit === pixelsPerUnit && current.length === byGuid.size &&
    current.every((asset) => byGuid.get(asset.header.guid) === asset);
  return { revision, cacheKey, matches };
}
