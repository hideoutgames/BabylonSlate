/** Unique copy names for Duplicate / copy-into-folder (engineplan Content Browser). */

/** Strip a single trailing `_` + digits suffix (`Duplicate_1` → `Duplicate`). */
export function stripTrailingCopyIndex(name: string): string {
  return name.replace(/_\d+$/, "");
}

/**
 * Next unused name in `existingNames`. If the stripped stem is free, keep it
 * (copy into an empty folder). Otherwise allocate `stem_N` with the smallest
 * `n >= 1` that is unused — never `Duplicate_1_1`.
 */
export function nextCopyName(name: string, existingNames: string[]): string {
  const stem = stripTrailingCopyIndex(name);
  const used = new Set(existingNames);
  if (!used.has(stem)) return stem;
  let index = 1;
  while (used.has(`${stem}_${index}`)) {
    index += 1;
  }
  return `${stem}_${index}`;
}

/** File stem without `.scene.babasset` / `.graph.babasset` / `.babasset`. */
export function stripAssetFileSuffix(fileName: string): string {
  return fileName
    .replace(/\.scene\.babasset$/i, "")
    .replace(/\.graph\.babasset$/i, "")
    .replace(/\.babasset$/i, "");
}

/** Preserve Scene/Graph container suffixes when duplicating. */
export function assetFileSuffix(fileName: string): string {
  if (/\.scene\.babasset$/i.test(fileName)) return ".scene.babasset";
  if (/\.graph\.babasset$/i.test(fileName)) return ".graph.babasset";
  return ".babasset";
}
