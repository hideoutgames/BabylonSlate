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
 * only loses its trailing `.hasset`.
 */
const ASSET_FILE_SUFFIXES = [
  ".scenelayer.hasset",
  ".matinst.hasset",
  ".bt.hasset",
  ".blackboard.hasset",
  ".water.hasset",
  ".datadefinition.hasset",
  ".datatree.hasset",
  ".rendertargettexture.hasset",
  ".rendertarget.hasset",
  ".inputaction.hasset",
  ".inputaxis.hasset",
  ".savegame.hasset",
  ".scene.hasset",
  ".class.hasset",
  ".prefab.hasset",
  ".spriteanim.hasset",
  ".sprite.hasset",
  ".anim.hasset",
  ".material.hasset",
  ".matfunc.hasset",
  ".tileset.hasset",
  ".tilemap.hasset",
  ".mixer.hasset",
  ".channel.hasset",
  ".atten.hasset",
  ".plugin.hasset",
  ".skyboxcreator.hasset",
  ".emitter.hasset",
  ".particlegraph.hasset",
  ".particles.hasset",
] as const;

function containerSuffix(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  return ASSET_FILE_SUFFIXES.find((suffix) => lower.endsWith(suffix))
    ?? (lower.endsWith(".hasset") ? ".hasset" : undefined);
}

/** File stem without its container suffix (`main.scene.hasset` → `main`, `tex.hasset` → `tex`). */
export function stripAssetFileSuffix(fileName: string): string {
  const suffix = containerSuffix(fileName);
  return suffix ? fileName.slice(0, fileName.length - suffix.length) : fileName;
}

/** Container suffix to keep when renaming or duplicating; `.hasset` for untyped names. */
export function assetFileSuffix(fileName: string): string {
  return containerSuffix(fileName) ?? ".hasset";
}
