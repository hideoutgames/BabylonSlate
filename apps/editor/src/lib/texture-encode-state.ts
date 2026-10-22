import type { IndexedAsset } from "@haptic/assets";

/**
 * The compression state to show for a Texture. A running encode is known only
 * to the editor's memory (`ProjectService.textureEncodingGuids`): the file
 * stays `pending` until the encode commits, so a running encode overrides it.
 */
export function shownCompressionState(saved: unknown, encoding: boolean): string | null {
  if (encoding) return "encoding";
  return typeof saved === "string" ? saved : null;
}

/**
 * Paths of Textures whose encode has not finished: waiting (saved `pending`),
 * interrupted by an older editor (saved `encoding`), or running now, which
 * covers a re-encode of a compressed Texture before its pending mark lands.
 */
export function unfinishedTextureEncodePaths(
  assets: readonly IndexedAsset[],
  encoding: ReadonlySet<string>,
): string[] {
  return assets
    .filter((asset) => {
      if (asset.header.type !== "Texture") return false;
      const state = shownCompressionState(asset.header.payload.compressionState, encoding.has(asset.header.guid));
      return state === "pending" || state === "encoding";
    })
    .map((asset) => asset.path);
}
