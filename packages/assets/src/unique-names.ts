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

/** File stem without `.scene.babasset` / `.graph.babasset` / `.class.babasset` / `.babasset`. */
export function stripAssetFileSuffix(fileName: string): string {
  return fileName
    .replace(/\.scene\.babasset$/i, "")
    .replace(/\.graph\.babasset$/i, "")
    .replace(/\.class\.babasset$/i, "")
    .replace(/\.eui\.babasset$/i, "")
    .replace(/\.ui\.babasset$/i, "")
    .replace(/\.sprite\.babasset$/i, "")
    .replace(/\.anim\.babasset$/i, "")
    .replace(/\.shader\.babasset$/i, "")
    .replace(/\.material\.babasset$/i, "")
    .replace(/\.matfunc\.babasset$/i, "")
    .replace(/\.tileset\.babasset$/i, "")
    .replace(/\.tilemap\.babasset$/i, "")
    .replace(/\.mixer\.babasset$/i, "")
    .replace(/\.channel\.babasset$/i, "")
    .replace(/\.atten\.babasset$/i, "")
    .replace(/\.plugin\.babasset$/i, "")
    .replace(/\.babasset$/i, "");
}

/** Preserve Scene/Graph/Class/P9 container suffixes when duplicating. */
export function assetFileSuffix(fileName: string): string {
  if (/\.scene\.babasset$/i.test(fileName)) return ".scene.babasset";
  if (/\.graph\.babasset$/i.test(fileName)) return ".graph.babasset";
  if (/\.class\.babasset$/i.test(fileName)) return ".class.babasset";
  if (/\.eui\.babasset$/i.test(fileName)) return ".eui.babasset";
  if (/\.ui\.babasset$/i.test(fileName)) return ".ui.babasset";
  if (/\.sprite\.babasset$/i.test(fileName)) return ".sprite.babasset";
  if (/\.anim\.babasset$/i.test(fileName)) return ".anim.babasset";
  if (/\.shader\.babasset$/i.test(fileName)) return ".shader.babasset";
  if (/\.material\.babasset$/i.test(fileName)) return ".material.babasset";
  if (/\.matfunc\.babasset$/i.test(fileName)) return ".matfunc.babasset";
  if (/\.tileset\.babasset$/i.test(fileName)) return ".tileset.babasset";
  if (/\.tilemap\.babasset$/i.test(fileName)) return ".tilemap.babasset";
  if (/\.mixer\.babasset$/i.test(fileName)) return ".mixer.babasset";
  if (/\.channel\.babasset$/i.test(fileName)) return ".channel.babasset";
  if (/\.atten\.babasset$/i.test(fileName)) return ".atten.babasset";
  if (/\.plugin\.babasset$/i.test(fileName)) return ".plugin.babasset";
  return ".babasset";
}
