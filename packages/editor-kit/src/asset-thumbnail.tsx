import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { thumbnailMime } from "@haptic/assets";
import { cn } from "@haptic/ui/lib/utils";
import { TypeVisualIcon, resolveTypeVisual } from "./type-visuals";

/** Reads asset thumbnails for closed pickers: the project's stored thumbnail bytes and a version that changes when one is rewritten. */
export type AssetThumbnailApi = {
  load: (guid: string) => Promise<Uint8Array | null>;
  versions: Readonly<Record<string, number>>;
};

const AssetThumbnailContext = createContext<AssetThumbnailApi | null>(null);

export function AssetThumbnailProvider({ value, children }: { value: AssetThumbnailApi | null; children: ReactNode }) {
  return <AssetThumbnailContext.Provider value={value}>{children}</AssetThumbnailContext.Provider>;
}

/** The asset a closed picker shows, set by `AssetPickerControl` for the `PickerIdentity` inside its trigger. */
export const PickerAssetGuidContext = createContext<string | null>(null);

/**
 * An object URL of the asset's stored thumbnail, or null while it loads, when
 * it has none, or without an `AssetThumbnailProvider`. The URL is released
 * when the guid or its thumbnail version changes and on unmount.
 */
export function useAssetThumbnailUrl(guid: string | null | undefined): string | null {
  const api = useContext(AssetThumbnailContext);
  const load = api?.load;
  const version = guid ? (api?.versions[guid] ?? 0) : 0;
  const key = guid && load ? `${guid}:${version}` : null;
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!key || !guid || !load) return;
    let current = true;
    let url: string | null = null;
    void load(guid).then(
      (bytes) => {
        if (!current || !bytes) return;
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: thumbnailMime(bytes) }));
        setShown({ key, url });
      },
      () => {},
    );
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [guid, key, load]);
  return shown && shown.key === key ? shown.url : null;
}

const CHECKERBOARD = {
  backgroundImage: "conic-gradient(var(--muted) 0.25turn, var(--background) 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, var(--background) 0.75turn)",
  backgroundSize: "8px 8px",
};

/** A square thumbnail, the image scaled to fit over a checkerboard wherever it is transparent or letterboxed. */
export function AssetThumbnail({ url, className, "data-testid": testId }: { url: string; className?: string; "data-testid"?: string }) {
  return (
    <span
      data-slot="asset-thumbnail"
      data-testid={testId}
      className={cn("grid shrink-0 place-items-center overflow-hidden rounded-[3px]", className)}
      style={CHECKERBOARD}
    >
      <img src={url} alt="" draggable={false} className="size-full object-contain" />
    </span>
  );
}

/**
 * A Pick Asset row's glyph: a Texture's thumbnail once it loads, otherwise the
 * asset type's icon. Only Textures show a thumbnail, as their closed pickers do.
 */
export function AssetRowGlyph({ guid, type }: { guid: string; type: string }) {
  const url = useAssetThumbnailUrl(type === "Texture" ? guid : null);
  return url
    ? <AssetThumbnail url={url} className="size-[22px]" data-testid={`asset-row-thumbnail-${guid}`} />
    : <TypeVisualIcon visual={resolveTypeVisual({ assetType: type })} />;
}
