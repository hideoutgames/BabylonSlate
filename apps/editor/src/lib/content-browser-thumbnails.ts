import { thumbnailMime } from "@haptic/assets";

export type ThumbnailUrlMap = Record<string, string>;

/** Thumbnails read at once; each batch of this many is committed together. */
export const THUMBNAIL_LOAD_CONCURRENCY = 4;

/** How long the mounted tiles must stay unchanged before a re-sync reads thumbnails. */
export const THUMBNAIL_SYNC_DEBOUNCE_MS = 100;

/** What a `commit` call reports about the loads behind it. */
export type ThumbnailCommitProgress = {
  /** Guids attempted (found or not) since the previous commit. */
  loaded: readonly string[];
  /** True for the last commit of a sync: every requested thumbnail was attempted. */
  done: boolean;
};

export type SyncContentBrowserThumbnailUrlsInput = {
  mountedTextureGuids: readonly string[];
  urls: ThumbnailUrlMap;
  hidden: boolean;
  refreshGuids?: ReadonlySet<string>;
  load: (guid: string) => Promise<Uint8Array | null>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  isCancelled?: () => boolean;
  /** Loads in flight at once, and the most tiles one commit adds. */
  concurrency?: number;
  /**
   * Releases URLs a commit stopped showing. Revoking is immediate by default;
   * a host whose commit renders later must revoke only once it has rendered,
   * or the DOM still shows a revoked URL.
   */
  retireObjectURLs?: (urls: readonly string[]) => void;
  commit: (urls: ThumbnailUrlMap, progress: ThumbnailCommitProgress) => void;
};

/**
 * Decode PNG/JPEG thumbs for mounted grid cells only.
 * Blob URLs for tiles that left the window are revoked. A CSS-hidden
 * Content Browser skips decode. Recaptures retain the old image until commit;
 * unrelated cells keep their URLs.
 *
 * Thumbnails load `concurrency` at a time and each batch is committed as soon
 * as it is read, so the first tiles appear without waiting for the last. The
 * first commit also drops tiles that left the window, and the last one is
 * marked `done`. A cancelled sync stops requesting loads and releases only
 * the URLs it created but did not commit; committed batches stay with the
 * caller. A load that throws leaves that cell unchanged and does not stop
 * the rest. A `commit` that throws owns its batch's URLs from the call on:
 * they are not revoked (the host may already show them) and nothing the
 * batch replaced is retired.
 */
export async function syncContentBrowserThumbnailUrls({
  mountedTextureGuids,
  urls,
  hidden,
  refreshGuids = new Set(),
  load,
  createObjectURL,
  revokeObjectURL,
  isCancelled = () => false,
  concurrency = THUMBNAIL_LOAD_CONCURRENCY,
  retireObjectURLs = (urls) => {
    for (const url of urls) revokeObjectURL(url);
  },
  commit,
}: SyncContentBrowserThumbnailUrlsInput): Promise<void> {
  if (hidden || isCancelled()) return;
  const mounted = new Set(mountedTextureGuids);
  const next: ThumbnailUrlMap = {};
  // URLs `next` no longer holds; released once a commit has dropped them.
  let dropped: string[] = [];
  for (const [guid, url] of Object.entries(urls)) {
    if (mounted.has(guid)) {
      next[guid] = url;
    } else {
      dropped.push(url);
    }
  }
  const wanted = [...mounted].filter((guid) => !next[guid] || refreshGuids.has(guid));
  const batchSize = Math.max(1, Math.floor(concurrency));
  // URLs created for a commit that has not happened yet.
  let uncommitted: string[] = [];
  let attempted: string[] = [];
  try {
    let start = 0;
    do {
      const batch = wanted.slice(start, start + batchSize);
      start += batchSize;
      const bytes = batch.length
        ? await Promise.all(
            batch.map(async (guid) => {
              try {
                return await load(guid);
              } catch {
                // One unreadable thumbnail keeps its tile as it was; the rest still load.
                return null;
              }
            }),
          )
        : [];
      if (isCancelled()) return;
      batch.forEach((guid, index) => {
        attempted.push(guid);
        const data = bytes[index];
        if (!data) return;
        const url = createObjectURL(
          new Blob([data as Uint8Array<ArrayBuffer>], { type: thumbnailMime(data) }),
        );
        if (next[guid]) dropped.push(next[guid]);
        uncommitted.push(url);
        next[guid] = url;
      });
      const done = start >= wanted.length;
      if (!done && uncommitted.length === 0 && dropped.length === 0) continue;
      const retiring = dropped;
      const loaded = attempted;
      dropped = [];
      attempted = [];
      // The commit owns this batch's URLs from here, even if it throws.
      uncommitted = [];
      commit({ ...next }, { loaded, done });
      retireObjectURLs(retiring);
    } while (start < wanted.length);
  } finally {
    for (const url of uncommitted) revokeObjectURL(url);
  }
}
