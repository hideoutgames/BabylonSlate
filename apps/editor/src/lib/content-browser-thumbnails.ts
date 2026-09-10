import { thumbnailMime } from "@babylonslate/assets";

export type ThumbnailUrlMap = Record<string, string>;

export type SyncContentBrowserThumbnailUrlsInput = {
  mountedTextureGuids: readonly string[];
  urls: ThumbnailUrlMap;
  hidden: boolean;
  load: (guid: string) => Promise<Uint8Array | null>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  isCancelled?: () => boolean;
  commit: (urls: ThumbnailUrlMap) => void;
};

/**
 * Decode Texture JPEG and Model/Animation PNG thumbs for mounted grid cells only.
 * Blob URLs for tiles that left the window are revoked. A CSS-hidden
 * Content Browser skips decode. Cancelled loads release only their new URLs.
 */
export async function syncContentBrowserThumbnailUrls({
  mountedTextureGuids,
  urls,
  hidden,
  load,
  createObjectURL,
  revokeObjectURL,
  isCancelled = () => false,
  commit,
}: SyncContentBrowserThumbnailUrlsInput): Promise<void> {
  if (hidden || isCancelled()) return;
  const mounted = new Set(mountedTextureGuids);
  const next: ThumbnailUrlMap = {};
  const evicted: string[] = [];
  for (const [guid, url] of Object.entries(urls)) {
    if (mounted.has(guid)) {
      next[guid] = url;
    } else {
      evicted.push(url);
    }
  }
  const created: string[] = [];
  let committed = false;
  try {
    for (const guid of mountedTextureGuids) {
      if (next[guid]) continue;
      const bytes = await load(guid);
      if (isCancelled()) return;
      if (!bytes) continue;
      const url = createObjectURL(
        new Blob([bytes], { type: thumbnailMime(bytes) }),
      );
      created.push(url);
      next[guid] = url;
    }
    if (isCancelled()) return;
    commit(next);
    committed = true;
    for (const url of evicted) revokeObjectURL(url);
  } finally {
    if (!committed) {
      for (const url of created) revokeObjectURL(url);
    }
  }
}
