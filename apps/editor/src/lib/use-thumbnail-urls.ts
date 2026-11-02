import { useEffect, useState } from "react";
import { thumbnailMime } from "@haptic/assets";

export type LoadThumbnail = (guid: string) => Promise<Uint8Array | null>;

/**
 * Object URLs for asset thumbnails while `enabled`, keyed by guid; assets
 * without a thumbnail are absent. A changed `versions` entry reloads; the
 * URLs are released when disabled, changed or unmounted.
 */
export function useThumbnailUrls(
  guids: readonly string[],
  load: LoadThumbnail | undefined,
  versions: Readonly<Record<string, number>> | undefined,
  enabled: boolean,
): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = enabled
    ? guids.map((guid) => `${guid}:${versions?.[guid] ?? 0}`).join("|")
    : "";
  useEffect(() => {
    if (!key || !load) return;
    let cancelled = false;
    const created: string[] = [];
    void (async () => {
      const next: Record<string, string> = {};
      for (const guid of key.split("|").map((entry) => entry.split(":")[0]!)) {
        const bytes = await load(guid).catch(() => null);
        if (cancelled) return;
        if (!bytes) continue;
        const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: thumbnailMime(bytes) }));
        created.push(url);
        next[guid] = url;
      }
      if (!cancelled) setUrls(next);
    })();
    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
      setUrls({});
    };
  }, [key, load]);
  return urls;
}
