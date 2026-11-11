import { useEffect, useRef, useState } from "react";
import { cn } from "@haptic/ui/lib/utils";
import { useDocumentActions, useRegistryState, useThumbnailVersions } from "../context/document-context";
import { appIconTextureProblem, readAppIconSource, renderAppIconPreview } from "../lib/app-icon";
import type { PackagingTarget } from "../lib/packaging-targets";
import { PLATFORM_MARKS } from "./platform-marks";

/**
 * An object URL of the App Icon as packages draw it (the source's centre
 * square), or null with no usable App Icon Texture. Read from the Texture's
 * source pixels again when its asset or thumbnail changes (a reimport).
 */
export function useAppIconPreviewUrl(guid: string | null | undefined): string | null {
  const { assetRegistry } = useRegistryState();
  const { readAssetChunk } = useDocumentActions();
  // The reader's identity is not a reason to read again; the asset and its version are.
  const readRef = useRef(readAssetChunk);
  useEffect(() => {
    readRef.current = readAssetChunk;
  }, [readAssetChunk]);
  const asset = guid ? assetRegistry?.getByGuid(guid) : undefined;
  const versions = useThumbnailVersions();
  const version = guid ? (versions[guid] ?? 0) : 0;
  const usable = Boolean(guid && asset && !appIconTextureProblem(asset));
  const [shown, setShown] = useState<{ asset: object; version: number; url: string } | null>(null);
  useEffect(() => {
    if (!usable || !guid || !asset) return;
    let current = true;
    let url: string | null = null;
    void readAppIconSource({ getByGuid: () => asset, readAssetChunk: (path, chunkId) => readRef.current(path, chunkId) }, guid)
      .then((source) => renderAppIconPreview(source))
      .then(
        (preview) => {
          if (!current) return;
          url = URL.createObjectURL(preview);
          setShown({ asset, version, url });
        },
        () => {},
      );
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [asset, guid, usable, version]);
  return usable && shown && shown.asset === asset && shown.version === version ? shown.url : null;
}

export type AppIconShape = "ios" | "android" | "square";

/** The shape a platform shows the App Icon in. */
export function appIconShape(target: PackagingTarget["id"]): AppIconShape {
  return target === "ios" ? "ios" : target === "android" ? "android" : "square";
}

/**
 * The App Icon as a platform shows it: iOS flattens it over black in its
 * rounded square; Android's adaptive icon fills the launcher's circle mask
 * over white; Web and desktop carry it unmasked.
 */
export function AppIconImage({ url, shape, className }: { url: string; shape: AppIconShape; className?: string }) {
  return (
    <span
      data-slot="app-icon-image"
      data-shape={shape}
      className={cn(
        "block shrink-0 overflow-hidden",
        shape === "ios" && "rounded-[22.37%] bg-black shadow-xs",
        shape === "android" && "rounded-full bg-white shadow-xs ring-1 ring-border",
        className,
      )}
    >
      <img src={url} alt="" draggable={false} className="size-full" />
    </span>
  );
}

function Caption({ marks, label }: { marks: PackagingTarget["id"][]; label: string }) {
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      {marks.map((id) => {
        const { Mark } = PLATFORM_MARKS[id];
        return <Mark key={id} aria-hidden title="" className="size-3 shrink-0" />;
      })}
      {label}
    </span>
  );
}

/** Project Settings → Export: the App Icon on iOS, Android, desktop and the web. */
export function AppIconPlatformPreviews({ url, displayName }: { url: string; displayName: string }) {
  const stage = "grid h-16 w-full place-items-center rounded-md bg-muted";
  return (
    <div className="grid grid-cols-4 gap-2 rounded-lg border bg-card p-2.5 max-sm:grid-cols-2" data-testid="app-icon-previews">
      <div className="flex min-w-0 flex-col items-center gap-1.5" data-testid="app-icon-preview-ios">
        <div className={stage}><AppIconImage url={url} shape="ios" className="size-12" /></div>
        <Caption marks={["ios"]} label="iOS" />
      </div>
      <div className="flex min-w-0 flex-col items-center gap-1.5" data-testid="app-icon-preview-android">
        <div className={stage}><AppIconImage url={url} shape="android" className="size-12" /></div>
        <Caption marks={["android"]} label="Android" />
      </div>
      <div className="flex min-w-0 flex-col items-center gap-1.5" data-testid="app-icon-preview-desktop">
        <div className={stage}><AppIconImage url={url} shape="square" className="size-11" /></div>
        <Caption marks={["windows", "linux", "macos"]} label="Desktop" />
      </div>
      <div className="flex min-w-0 flex-col items-center gap-1.5" data-testid="app-icon-preview-web">
        <div className="flex h-16 w-full items-end justify-center rounded-md bg-muted px-2">
          <span className="flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-t-md border border-b-0 bg-popover px-2 text-xs">
            <AppIconImage url={url} shape="square" className="size-4" />
            <span className="truncate">{displayName}</span>
          </span>
        </div>
        <Caption marks={["web"]} label="Web" />
      </div>
    </div>
  );
}
