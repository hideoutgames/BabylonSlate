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

/**
 * Container suffixes of typed assets (`newAssetFileSuffix` and
 * `PLUGIN_FILE_SUFFIX`). Rename and Duplicate keep these; any other file name
 * only loses its trailing `.babasset`.
 */
const ASSET_FILE_SUFFIXES = [
  ".scenelayer.babasset",
  ".matinst.babasset",
  ".bt.babasset",
  ".blackboard.babasset",
  ".water.babasset",
  ".datadefinition.babasset",
  ".datatree.babasset",
  ".rendertargettexture.babasset",
  ".rendertarget.babasset",
  ".inputaction.babasset",
  ".inputaxis.babasset",
  ".savegame.babasset",
  ".scene.babasset",
  ".class.babasset",
  ".prefab.babasset",
  ".spriteanim.babasset",
  ".sprite.babasset",
  ".anim.babasset",
  ".material.babasset",
  ".matfunc.babasset",
  ".tileset.babasset",
  ".tilemap.babasset",
  ".mixer.babasset",
  ".channel.babasset",
  ".atten.babasset",
  ".plugin.babasset",
  ".skyboxcreator.babasset",
  ".emitter.babasset",
  ".particlegraph.babasset",
  ".particles.babasset",
] as const;

function containerSuffix(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  return ASSET_FILE_SUFFIXES.find((suffix) => lower.endsWith(suffix))
    ?? (lower.endsWith(".babasset") ? ".babasset" : undefined);
}

/** File stem without its container suffix (`main.scene.babasset` → `main`, `tex.babasset` → `tex`). */
export function stripAssetFileSuffix(fileName: string): string {
  const suffix = containerSuffix(fileName);
  return suffix ? fileName.slice(0, fileName.length - suffix.length) : fileName;
}

/** Container suffix to keep when renaming or duplicating; `.babasset` for untyped names. */
export function assetFileSuffix(fileName: string): string {
  return containerSuffix(fileName) ?? ".babasset";
}
