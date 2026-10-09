/**
 * Storage folder paths (`assets/Weapons`) as the Asset Registry nodes and the
 * Always Package Folders project setting spell them. Matching is exact and
 * case-sensitive.
 */

/** Trim, drop leading and trailing `/`, and collapse repeated `/`. */
export function normalizeAssetFolderPath(path: string): string {
  return path
    .trim()
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/** Parent directory of an asset's storage path; empty when it has none. */
export function assetFolderOfPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** True when `folder` is `ancestor` or lies below it. Both are normalized paths. */
export function isFolderWithin(folder: string, ancestor: string): boolean {
  if (ancestor === "") return true;
  return folder === ancestor || folder.startsWith(`${ancestor}/`);
}

/** Normalized, de-duplicated Always Package Folders in their saved order. */
export function normalizeAlwaysPackageFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const folders: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const folder = normalizeAssetFolderPath(entry);
    if (folder !== "" && !folders.includes(folder)) folders.push(folder);
  }
  return folders;
}

/** Follow a folder rename or move: entries at or below `from` now live under `to`. */
export function remapAlwaysPackageFolders(
  folders: readonly string[],
  from: string,
  to: string,
): string[] {
  const source = normalizeAssetFolderPath(from);
  const target = normalizeAssetFolderPath(to);
  if (source === "") return [...folders];
  return normalizeAlwaysPackageFolders(
    folders.map((folder) =>
      isFolderWithin(folder, source) ? `${target}${folder.slice(source.length)}` : folder,
    ),
  );
}

/** Drop the entries at or below any deleted folder. */
export function removeAlwaysPackageFolders(
  folders: readonly string[],
  deleted: readonly string[],
): string[] {
  const gone = deleted.map(normalizeAssetFolderPath).filter((folder) => folder !== "");
  return folders.filter((folder) => !gone.some((path) => isFolderWithin(folder, path)));
}
