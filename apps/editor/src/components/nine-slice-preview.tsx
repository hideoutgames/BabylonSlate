import { useEffect, useState } from "react";
import {
  overlayNineSliceSourceFractions,
  type OverlayNineSliceSourceFractions,
  type SceneLayerPanelSource,
} from "@babylonslate/core";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { useDocuments } from "../context/document-context";
import { objectContainRect } from "../lib/object-contain";

export function firstSampledTextureGuid(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const nodes = (content as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const type = (node as { type?: unknown }).type;
    if (type !== "texture.sample" && type !== "texture.sampleLod") continue;
    const guid = (node as { properties?: { textureGuid?: unknown } }).properties
      ?.textureGuid;
    if (typeof guid === "string" && guid.trim()) return guid;
  }
  return null;
}

export function NineSliceMarginOverlay({
  left,
  right,
  top,
  bottom,
}: OverlayNineSliceSourceFractions) {
  const dots = [
    { id: "nw", left, top },
    { id: "ne", left: right, top },
    { id: "sw", left, top: bottom },
    { id: "se", left: right, top: bottom },
  ] as const;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10"
      data-testid="panel-nine-slice-overlay"
    >
      <span
        className="absolute top-0 bottom-0 border-l border-dashed border-[var(--pin-transform)]"
        data-testid="panel-nine-slice-line-left"
        style={{ left: `${left * 100}%` }}
      />
      <span
        className="absolute top-0 bottom-0 border-l border-dashed border-[var(--pin-transform)]"
        data-testid="panel-nine-slice-line-right"
        style={{ left: `${right * 100}%` }}
      />
      <span
        className="absolute right-0 left-0 border-t border-dashed border-[var(--pin-transform)]"
        data-testid="panel-nine-slice-line-top"
        style={{ top: `${top * 100}%` }}
      />
      <span
        className="absolute right-0 left-0 border-t border-dashed border-[var(--pin-transform)]"
        data-testid="panel-nine-slice-line-bottom"
        style={{ top: `${bottom * 100}%` }}
      />
      {dots.map((dot) => (
        <span
          key={dot.id}
          className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--pin-transform)]"
          data-testid={`panel-nine-slice-dot-${dot.id}`}
          style={{ left: `${dot.left * 100}%`, top: `${dot.top * 100}%` }}
        />
      ))}
    </div>
  );
}

export function NineSlicePreview({
  source,
  textureGuid,
  materialGuid,
  marginLeft,
  marginRight,
  marginTop,
  marginBottom,
  sourceWidthPx,
  sourceHeightPx,
}: {
  source: SceneLayerPanelSource;
  textureGuid: string | null;
  materialGuid: string | null;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  sourceWidthPx?: number;
  sourceHeightPx?: number;
}) {
  const { assetRegistry, readAssetChunk, loadAssetDocument } = useDocuments();
  const [url, setUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [emptyReason, setEmptyReason] = useState<
    "none" | "no-material-texture" | "loading"
  >("none");

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setNaturalSize(null);
    void (async () => {
      const assets = assetRegistry?.list() ?? [];
      let guid =
        source === "texture" ? textureGuid : null;
      if (source === "material") {
        if (!materialGuid) {
          if (!cancelled) setEmptyReason("none");
          return;
        }
        const material = assets.find(
          (asset) => asset.header.guid === materialGuid,
        );
        if (!material || !loadAssetDocument) {
          if (!cancelled) setEmptyReason("no-material-texture");
          return;
        }
        const content = await loadAssetDocument("material", material.path);
        guid = firstSampledTextureGuid(content);
        if (!guid) {
          if (!cancelled) setEmptyReason("no-material-texture");
          return;
        }
      }
      if (!guid) {
        if (!cancelled) setEmptyReason("none");
        return;
      }
      const texture = assets.find((asset) => asset.header.guid === guid);
      if (!texture || !readAssetChunk) {
        if (!cancelled) setEmptyReason("none");
        return;
      }
      if (!cancelled) setEmptyReason("loading");
      const bytes = await readAssetChunk(texture.path, "pixels");
      if (!bytes || cancelled || bytes.byteLength === 0) {
        if (!cancelled) setEmptyReason("none");
        return;
      }
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      if (!cancelled) {
        setEmptyReason("loading");
        setUrl(objectUrl);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    assetRegistry,
    loadAssetDocument,
    materialGuid,
    readAssetChunk,
    source,
    textureGuid,
  ]);

  const width = sourceWidthPx ?? naturalSize?.width ?? 0;
  const height = sourceHeightPx ?? naturalSize?.height ?? 0;
  const contain =
    width > 0 && height > 0 ? objectContainRect(1, 1, width, height) : null;
  const splits =
    width > 0 && height > 0
      ? overlayNineSliceSourceFractions({
          srcWidthPx: width,
          srcHeightPx: height,
          marginLeft,
          marginRight,
          marginTop,
          marginBottom,
        })
      : null;
  const showOverlay = Boolean(url && contain && splits);
  const emptyTitle =
    emptyReason === "no-material-texture"
      ? "No Texture On Material"
      : source === "material"
        ? "No Material"
        : "No Texture";

  return (
    <div className="p-2" data-testid="panel-nine-slice-preview">
      <div
        className="relative aspect-square w-full overflow-hidden rounded-md border border-border"
        style={{
          backgroundImage:
            "conic-gradient(#808080 0.25turn, #c0c0c0 0.25turn 0.5turn, #808080 0.5turn 0.75turn, #c0c0c0 0.75turn)",
          backgroundSize: "16px 16px",
        }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            className="absolute inset-0 size-full object-contain"
            onLoad={(event) =>
              setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
        ) : (
          <Empty className="absolute inset-0 border-0 p-3">
            <EmptyHeader>
              <EmptyTitle>{emptyTitle}</EmptyTitle>
              <EmptyDescription>
                {emptyReason === "no-material-texture"
                  ? "Sample a Texture on the Material to preview 9-slice margins."
                  : "Pick a Texture or Material to preview 9-slice margins."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {showOverlay && contain && splits ? (
          <div
            className="absolute z-10"
            data-testid="panel-nine-slice-image-box"
            style={{
              left: `${contain.left * 100}%`,
              top: `${contain.top * 100}%`,
              width: `${contain.width * 100}%`,
              height: `${contain.height * 100}%`,
            }}
          >
            <NineSliceMarginOverlay {...splits} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
