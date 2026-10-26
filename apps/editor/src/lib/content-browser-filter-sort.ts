/**
 * Content Browser grid search, type filter options and sort orders.
 * `content-browser-helpers.ts` re-exports the public names.
 */
import type { IndexedAsset } from "@haptic/assets";

type AssetSearchHaystack = {
  sourceName: string;
  sourcePath: string;
  sourceType: string;
  name: string;
  path: string;
  type: string;
};

/**
 * Lowercased search fields per indexed asset, built on the first non-empty
 * search. The registry replaces an asset object when its name, path, or type
 * changes; the source strings still guard against an in-place edit.
 */
const assetSearchHaystacks = new WeakMap<IndexedAsset, AssetSearchHaystack>();

function assetSearchHaystack(asset: IndexedAsset): AssetSearchHaystack {
  const { name, type } = asset.header;
  const cached = assetSearchHaystacks.get(asset);
  if (
    cached &&
    cached.sourceName === name &&
    cached.sourcePath === asset.path &&
    cached.sourceType === type
  ) {
    return cached;
  }
  const haystack: AssetSearchHaystack = {
    sourceName: name,
    sourcePath: asset.path,
    sourceType: type,
    name: name.toLowerCase(),
    path: asset.path.toLowerCase(),
    type: type.toLowerCase(),
  };
  assetSearchHaystacks.set(asset, haystack);
  return haystack;
}

function assetMatchesNeedle(asset: IndexedAsset, needle: string): boolean {
  const haystack = assetSearchHaystack(asset);
  return (
    haystack.name.includes(needle) ||
    haystack.path.includes(needle) ||
    haystack.type.includes(needle)
  );
}

/**
 * Keeps the input order, so filtering a list already sorted by `sortAssets`
 * yields the same order as sorting the filtered list.
 */
export function filterAssets(
  assets: readonly IndexedAsset[],
  options: {
    folderGuids: Set<string> | null;
    typeFilters: string[] | null;
    search: string;
  },
): IndexedAsset[] {
  const types = options.typeFilters ?? [];
  const needle = options.search.trim().toLowerCase();
  return assets.filter((asset) => {
    if (options.folderGuids && !options.folderGuids.has(asset.header.guid)) {
      return false;
    }
    if (types.length > 0 && !types.includes(asset.header.type)) {
      return false;
    }
    return !needle || assetMatchesNeedle(asset, needle);
  });
}

export type ContentBrowserSortMode =
  | "name-asc"
  | "name-desc"
  | "type-asc"
  | "type-desc"
  | "date-desc"
  | "date-asc";

export const CONTENT_BROWSER_SORT_OPTIONS: ReadonlyArray<{
  mode: ContentBrowserSortMode;
  label: string;
}> = [
  { mode: "name-asc", label: "Name A–Z" },
  { mode: "name-desc", label: "Name Z–A" },
  { mode: "type-asc", label: "Type A–Z" },
  { mode: "type-desc", label: "Type Z–A" },
  { mode: "date-desc", label: "Date Modified (Newest)" },
  { mode: "date-asc", label: "Date Modified (Oldest)" },
];

/**
 * Same ordering as `localeCompare(b, undefined, { sensitivity: "base" })`,
 * without building a collator per comparison.
 */
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });
const compareNames = NAME_COLLATOR.compare;

function compareAssetNames(a: IndexedAsset, b: IndexedAsset): number {
  return compareNames(a.header.name, b.header.name);
}

function assetMtime(asset: IndexedAsset): number {
  return asset.mtime ?? 0;
}

/**
 * Total order ending in a guid tiebreak, so sorting once and then filtering
 * matches filtering first and sorting the matches.
 */
export function sortAssets(
  assets: readonly IndexedAsset[],
  mode: ContentBrowserSortMode,
): IndexedAsset[] {
  return [...assets].sort((left, right) => {
    let primary = 0;
    switch (mode) {
      case "name-asc":
      case "name-desc":
        primary = compareAssetNames(left, right);
        if (mode === "name-desc") primary = -primary;
        break;
      case "type-asc":
      case "type-desc":
        primary = compareNames(left.header.type, right.header.type);
        if (mode === "type-desc") primary = -primary;
        break;
      case "date-asc":
      case "date-desc":
        primary = assetMtime(left) - assetMtime(right);
        if (mode === "date-desc") primary = -primary;
        break;
    }
    if (primary !== 0) return primary;
    if (mode !== "name-asc" && mode !== "name-desc") {
      const byName = compareAssetNames(left, right);
      if (byName !== 0) return byName;
    }
    return left.header.guid.localeCompare(right.header.guid);
  });
}

export function sortChildFolders<T extends { name: string }>(
  folders: readonly T[],
  mode: ContentBrowserSortMode,
): T[] {
  const descending = mode === "name-desc";
  return [...folders].sort((left, right) => {
    const byName = compareNames(left.name, right.name);
    if (byName !== 0) return descending ? -byName : byName;
    return 0;
  });
}

export function uniqueAssetTypes(assets: IndexedAsset[]): string[] {
  return [...new Set(assets.map((asset) => asset.header.type))].sort();
}
