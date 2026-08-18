export type ThumbnailUrlMap = Record<string, string>;

export type SyncContentBrowserThumbnailUrlsInput = {
  mountedTextureGuids: readonly string[];
  urls: ThumbnailUrlMap;
  hidden: boolean;
  load: (guid: string) => Promise<Uint8Array | null>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
};

/**
 * Decode JPEG thumbnails for mounted Texture cells only. Blob URLs for tiles
 * that left the window are revoked. A CSS-hidden Content Browser skips decode.
 */
export async function syncContentBrowserThumbnailUrls({
  mountedTextureGuids,
  urls,
  hidden,
  load,
  createObjectURL,
  revokeObjectURL,
}: SyncContentBrowserThumbnailUrlsInput): Promise<ThumbnailUrlMap> {
  if (hidden) return { ...urls };
  const mounted = new Set(mountedTextureGuids);
  const next: ThumbnailUrlMap = {};
  for (const [guid, url] of Object.entries(urls)) {
    if (mounted.has(guid)) {
      next[guid] = url;
    } else {
      revokeObjectURL(url);
    }
  }
  for (const guid of mountedTextureGuids) {
    if (next[guid]) continue;
    const bytes = await load(guid);
    if (!bytes) continue;
    next[guid] = createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  }
  return next;
}
