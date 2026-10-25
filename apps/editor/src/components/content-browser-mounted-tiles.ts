import { useEffect, useMemo, useRef, useState } from "react";
import { isThumbnailableAssetType } from "@haptic/assets";
import type { useDocumentActions, useEditorShellState } from "../context/document-context";
import { classDocumentShowsPrefab } from "../lib/content-browser-helpers";
import {
  THUMBNAIL_SYNC_DEBOUNCE_MS,
  syncContentBrowserThumbnailUrls,
} from "../lib/content-browser-thumbnails";
import { useContentBrowserGridWindow } from "../lib/use-content-browser-grid-window";
import type { ContentBrowserGridItem, ContentBrowserTileLock } from "./content-browser-grid-tiles";

/**
 * Locks of the mounted asset tiles, serialized so the memoized grid sees a new
 * value only when one of them changes (the service mutates its locks in place).
 */
function mountedTileLocksKey(
  items: readonly ContentBrowserGridItem[],
  firstIndex: number,
  lastIndex: number,
  sourceControl: {
    lockStateForPath: (path: string) => "mine" | "theirs" | null;
    lockForPath: (path: string) => { ownerName?: string } | null | undefined;
  },
): string {
  const locks: Record<string, ContentBrowserTileLock> = {};
  const end = Math.min(lastIndex, items.length);
  for (let index = firstIndex; index < end; index++) {
    const item = items[index];
    if (item?.kind !== "asset") continue;
    const path = item.asset.path;
    const state = sourceControl.lockStateForPath(path);
    if (!state) continue;
    const ownerName = sourceControl.lockForPath(path)?.ownerName;
    locks[path] = ownerName === undefined ? { state } : { state, ownerName };
  }
  return JSON.stringify(locks);
}

/** What the mounted grid window, its thumbnails and its tile locks read. */
export interface ContentBrowserMountedTilesDeps {
  gridItems: readonly ContentBrowserGridItem[];
  hidden: boolean;
  classParentOf: (id: string) => string | null;
  sourceControl: Parameters<typeof mountedTileLocksKey>[3];
  thumbnailsEnabled: boolean;
  thumbnailVersions: ReturnType<typeof useEditorShellState>["thumbnailVersions"];
  loadAssetThumbnail: ReturnType<typeof useDocumentActions>["loadAssetThumbnail"];
}

/**
 * The windowed range of mounted grid tiles, the thumbnail URLs synced for
 * them, and their source control locks.
 */
export function useContentBrowserMountedTiles(deps: ContentBrowserMountedTilesDeps) {
  const {
    gridItems,
    hidden,
    classParentOf,
    sourceControl,
    thumbnailsEnabled,
    thumbnailVersions,
    loadAssetThumbnail,
  } = deps;
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>(
    {},
  );
  // Written only with the state, by the thumbnail sync's commit: a render
  // that still shows an older map must not put it back.
  const thumbnailUrlsRef = useRef(thumbnailUrls);

  const { scrollerRef, slice, spacerHeight } = useContentBrowserGridWindow(
    gridItems.length,
    hidden,
  );

  const mountedTextureGuids = useMemo(() => {
    const guids: string[] = [];
    for (let index = slice.firstIndex; index < slice.lastIndex; index++) {
      const item = gridItems[index];
      if (item?.kind === "asset" && isThumbnailableAssetType(item.asset.header.type)) {
        const { type, parentClass } = item.asset.header;
        if (type === "Class" && !classDocumentShowsPrefab(parentClass, classParentOf)) continue;
        guids.push(item.asset.header.guid);
      }
    }
    return guids;
  }, [classParentOf, gridItems, slice.firstIndex, slice.lastIndex]);

  const tileLocksKey = mountedTileLocksKey(
    gridItems,
    slice.firstIndex,
    slice.lastIndex,
    sourceControl,
  );
  const tileLocks = useMemo(
    () => JSON.parse(tileLocksKey) as Record<string, ContentBrowserTileLock>,
    [tileLocksKey],
  );

  const loadedThumbnailVersionsRef = useRef<Readonly<Record<string, number>>>({});

  const thumbnailSyncStartedRef = useRef(false);
  // URLs a commit stopped showing, tagged with that commit's URL map. A URL is
  // revoked only after the map that dropped it has rendered; revoking it when
  // the commit is scheduled would leave an <img> pointing at a revoked URL.
  const lastThumbnailCommitRef = useRef<Record<string, string> | null>(null);
  const retiredThumbnailUrlsRef = useRef<Array<{ shown: Record<string, string> | null; urls: readonly string[] }>>([]);
  useEffect(() => {
    const retired = retiredThumbnailUrlsRef.current;
    const rendered = retired.findLastIndex((entry) => entry.shown === thumbnailUrls);
    if (rendered < 0) return;
    for (const entry of retired.splice(0, rendered + 1)) {
      for (const url of entry.urls) URL.revokeObjectURL(url);
    }
  }, [thumbnailUrls]);
  useEffect(() => {
    if (!thumbnailsEnabled) return;
    let cancelled = false;
    const sync = () => {
      if (!hidden) thumbnailSyncStartedRef.current = true;
      void syncContentBrowserThumbnailUrls({
        mountedTextureGuids,
        urls: thumbnailUrlsRef.current,
        refreshGuids: new Set(mountedTextureGuids.filter((guid) =>
          thumbnailVersions[guid] !== loadedThumbnailVersionsRef.current[guid],
        )),
        hidden,
        load: loadAssetThumbnail,
        createObjectURL: (blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
        isCancelled: () => cancelled,
        retireObjectURLs: (urls) => {
          if (urls.length > 0) {
            retiredThumbnailUrlsRef.current.push({ shown: lastThumbnailCommitRef.current, urls });
          }
        },
        commit: (next, { loaded, done }) => {
          // A cancelled sync leaves later guids unloaded, so only a finished
          // one may claim every version; batches record just what they read.
          loadedThumbnailVersionsRef.current = done
            ? thumbnailVersions
            : {
                ...loadedThumbnailVersionsRef.current,
                ...Object.fromEntries(loaded.map((guid) => [guid, thumbnailVersions[guid]])),
              };
          thumbnailUrlsRef.current = next;
          lastThumbnailCommitRef.current = next;
          setThumbnailUrls(next);
        },
      });
    };
    // The first sync runs at once. Scrolling changes the mounted tiles with
    // every row, and each change cancels the sync before it; later syncs wait
    // for the window to settle so a fast scroll reads only the tiles it stops on.
    if (!thumbnailSyncStartedRef.current) {
      sync();
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setTimeout(sync, THUMBNAIL_SYNC_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hidden, loadAssetThumbnail, mountedTextureGuids, thumbnailVersions, thumbnailsEnabled]);

  useEffect(() => {
    // The queue is only ever mutated in place, so this is the list the sync fills.
    const retired = retiredThumbnailUrlsRef.current;
    return () => {
      for (const url of Object.values(thumbnailUrlsRef.current)) {
        URL.revokeObjectURL(url);
      }
      for (const entry of retired.splice(0)) {
        for (const url of entry.urls) URL.revokeObjectURL(url);
      }
    };
  }, []);

  return { scrollerRef, slice, spacerHeight, thumbnailUrls, tileLocks };
}
