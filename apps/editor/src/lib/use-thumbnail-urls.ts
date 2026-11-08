import { useEffect, useRef, useState } from "react";
import { syncContentBrowserThumbnailUrls, type ThumbnailUrlMap } from "./content-browser-thumbnails";

export type LoadThumbnail = (guid: string) => Promise<Uint8Array | null>;

function sameUrls(a: ThumbnailUrlMap, b: ThumbnailUrlMap): boolean {
  const guids = Object.keys(a);
  return guids.length === Object.keys(b).length && guids.every((guid) => a[guid] === b[guid]);
}

/**
 * Object URLs for asset thumbnails while `enabled`, keyed by guid; assets
 * without a thumbnail are absent. Unchanged thumbnails keep their URLs: only
 * new guids and guids whose `versions` entry changed load, a few at a time,
 * and a replaced URL is released only once its replacement has rendered. A
 * guid that leaves the list loses its URL; every URL is released when
 * disabled or unmounted.
 */
export function useThumbnailUrls(
  guids: readonly string[],
  load: LoadThumbnail | undefined,
  versions: Readonly<Record<string, number>> | undefined,
  enabled: boolean,
): ThumbnailUrlMap {
  const [urls, setUrls] = useState<ThumbnailUrlMap>({});
  // Written only with the state: a render that still shows an older map must
  // not put it back.
  const urlsRef = useRef(urls);
  // The versions behind the current URLs, and the loader that read them.
  const loadedRef = useRef<{ load?: LoadThumbnail; versions: Readonly<Record<string, number>> }>({ versions: {} });
  // URLs a commit stopped showing, tagged with the map that dropped them. Each
  // is revoked once that map has rendered, so no <img> shows a revoked URL.
  const retiredRef = useRef<Array<{ shown: ThumbnailUrlMap; urls: readonly string[] }>>([]);

  useEffect(() => {
    const retired = retiredRef.current;
    const rendered = retired.findLastIndex((entry) => entry.shown === urls);
    if (rendered < 0) return;
    for (const entry of retired.splice(0, rendered + 1)) {
      for (const url of entry.urls) URL.revokeObjectURL(url);
    }
  }, [urls]);

  const key = enabled && load
    ? guids.map((guid) => `${guid}:${versions?.[guid] ?? 0}`).join("|")
    : "";
  useEffect(() => {
    if (!key || !load) {
      loadedRef.current = { versions: {} };
      const shown = Object.values(urlsRef.current);
      if (shown.length === 0) return;
      const next: ThumbnailUrlMap = {};
      retiredRef.current.push({ shown: next, urls: shown });
      urlsRef.current = next;
      setUrls(next);
      return;
    }
    const wanted: Record<string, number> = {};
    for (const entry of key.split("|")) {
      const split = entry.lastIndexOf(":");
      wanted[entry.slice(0, split)] = Number(entry.slice(split + 1));
    }
    const listed = Object.keys(wanted);
    const loaded = loadedRef.current;
    let cancelled = false;
    void syncContentBrowserThumbnailUrls({
      mountedTextureGuids: listed,
      urls: urlsRef.current,
      hidden: false,
      // A new loader reads every thumbnail again; the old images stay until then.
      refreshGuids: new Set(
        listed.filter((guid) => loaded.load !== load || loaded.versions[guid] !== wanted[guid]),
      ),
      load,
      createObjectURL: (blob) => URL.createObjectURL(blob),
      revokeObjectURL: (url) => URL.revokeObjectURL(url),
      isCancelled: () => cancelled,
      retireObjectURLs: (retiring) => {
        if (retiring.length > 0) retiredRef.current.push({ shown: urlsRef.current, urls: retiring });
      },
      commit: (next, { loaded: read, done }) => {
        // A cancelled sync leaves later guids unloaded, so only a finished one
        // may claim every version; batches record just what they read.
        const previous = loadedRef.current.load === load ? loadedRef.current.versions : {};
        loadedRef.current = {
          load,
          versions: done
            ? wanted
            : { ...previous, ...Object.fromEntries(read.map((guid) => [guid, wanted[guid]!])) },
        };
        if (sameUrls(urlsRef.current, next)) return;
        urlsRef.current = next;
        setUrls(next);
      },
    });
    return () => {
      cancelled = true;
    };
  }, [key, load]);

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
