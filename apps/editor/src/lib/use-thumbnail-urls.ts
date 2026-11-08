import { useCallback, useEffect, useRef, useState } from "react";
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
  // Each committed map's place in commit order.
  const commitCount = useRef(0);
  const commitOrder = useRef(new WeakMap<ThumbnailUrlMap, number>());
  // URLs a commit stopped showing, tagged with that commit's place. They are
  // revoked once that commit or a later one has rendered, so no <img> shows a
  // revoked URL; commits React batches into one render all release theirs.
  const retiredRef = useRef<Array<{ commit: number; urls: readonly string[] }>>([]);
  const show = useCallback((next: ThumbnailUrlMap) => {
    commitOrder.current.set(next, ++commitCount.current);
    urlsRef.current = next;
    setUrls(next);
  }, []);

  useEffect(() => {
    const rendered = commitOrder.current.get(urls);
    if (rendered === undefined) return;
    const retired = retiredRef.current;
    const released = retired.findIndex((entry) => entry.commit > rendered);
    for (const entry of retired.splice(0, released < 0 ? retired.length : released)) {
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
      show({});
      retiredRef.current.push({ commit: commitCount.current, urls: shown });
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
        // The commit just made dropped them.
        if (retiring.length > 0) retiredRef.current.push({ commit: commitCount.current, urls: retiring });
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
        if (!sameUrls(urlsRef.current, next)) show(next);
      },
    });
    return () => {
      cancelled = true;
    };
  }, [key, load, show]);

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
