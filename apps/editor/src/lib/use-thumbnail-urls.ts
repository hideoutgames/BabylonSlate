import { useEffect, useRef, useState } from "react";
import {
  syncContentBrowserThumbnailUrls,
  type ThumbnailUrlMap,
} from "./content-browser-thumbnails";
import { useStableBy } from "./use-stable-by";

export type LoadThumbnail = (guid: string) => Promise<Uint8Array | null>;

function sameGuids(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((guid, index) => guid === b[index]);
}

/** Same guids with the same URLs: committing it would only re-render the cards. */
function sameUrls(a: ThumbnailUrlMap, b: ThumbnailUrlMap): boolean {
  const guids = Object.keys(a);
  return guids.length === Object.keys(b).length && guids.every((guid) => a[guid] === b[guid]);
}

/**
 * Object URLs for asset thumbnails while `enabled`, keyed by guid; assets
 * without a thumbnail are absent. Synced like the Content Browser grid
 * (`syncContentBrowserThumbnailUrls`): unchanged guids keep their URLs, a
 * guid whose `versions` entry changed keeps its old URL until the new
 * thumbnail is read, and the rest load four at a time, each batch shown as
 * soon as it is read. A URL is released once a map without it has rendered
 * (replaced, or its guid left the list), and on disable or unmount. A new
 * `guids` array with the same guids, or a version change of an asset not
 * listed, reads nothing.
 */
export function useThumbnailUrls(
  guids: readonly string[],
  load: LoadThumbnail | undefined,
  versions: Readonly<Record<string, number>> | undefined,
  enabled: boolean,
): Record<string, string> {
  // Callers rebuild the list on registry changes that leave it as it was.
  const listed = useStableBy(guids, sameGuids);
  const listedVersions = useStableBy(versions, (previous, next) =>
    listed.every((guid) => previous?.[guid] === next?.[guid]),
  );
  const [urls, setUrls] = useState<ThumbnailUrlMap>({});
  // Written only with the state, by a commit: a render that still shows an
  // older map must not put it back.
  const urlsRef = useRef(urls);
  // The version each guid's thumbnail was last read at.
  const loadedVersionsRef = useRef<Readonly<Record<string, number | undefined>>>({});
  // URLs a commit stopped showing, tagged with that commit's map. A URL is
  // revoked only after the map that dropped it has rendered; revoking it when
  // the commit is scheduled would leave an <img> pointing at a revoked URL.
  const retiredRef = useRef<Array<{ shown: ThumbnailUrlMap; urls: readonly string[] }>>([]);

  useEffect(() => {
    const retired = retiredRef.current;
    const rendered = retired.findLastIndex((entry) => entry.shown === urls);
    if (rendered < 0) return;
    for (const entry of retired.splice(0, rendered + 1)) {
      for (const url of entry.urls) URL.revokeObjectURL(url);
    }
  }, [urls]);

  useEffect(() => {
    if (!enabled || !load) {
      loadedVersionsRef.current = {};
      const shown = Object.values(urlsRef.current);
      if (shown.length === 0) return;
      const cleared: ThumbnailUrlMap = {};
      retiredRef.current.push({ shown: cleared, urls: shown });
      urlsRef.current = cleared;
      setUrls(cleared);
      return;
    }
    let cancelled = false;
    void syncContentBrowserThumbnailUrls({
      mountedTextureGuids: listed,
      urls: urlsRef.current,
      refreshGuids: new Set(listed.filter((guid) => listedVersions?.[guid] !== loadedVersionsRef.current[guid])),
      hidden: false,
      load,
      createObjectURL: (blob) => URL.createObjectURL(blob),
      revokeObjectURL: (url) => URL.revokeObjectURL(url),
      isCancelled: () => cancelled,
      retireObjectURLs: (retiring) => {
        if (retiring.length > 0) retiredRef.current.push({ shown: urlsRef.current, urls: retiring });
      },
      commit: (next, { loaded, done }) => {
        // A cancelled sync leaves later guids unread, so only a finished one
        // may claim every version; batches record just what they read.
        loadedVersionsRef.current = done
          ? (listedVersions ?? {})
          : {
              ...loadedVersionsRef.current,
              ...Object.fromEntries(loaded.map((guid) => [guid, listedVersions?.[guid]])),
            };
        // A sync whose reads all found no thumbnail still ends in a commit.
        if (sameUrls(next, urlsRef.current)) return;
        urlsRef.current = next;
        setUrls(next);
      },
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, listed, listedVersions, load]);

  useEffect(() => {
    // The queue is only ever mutated in place, so this is the list the syncs fill.
    const retired = retiredRef.current;
    return () => {
      for (const url of Object.values(urlsRef.current)) URL.revokeObjectURL(url);
      for (const entry of retired.splice(0)) {
        for (const url of entry.urls) URL.revokeObjectURL(url);
      }
    };
  }, []);

  return urls;
}
