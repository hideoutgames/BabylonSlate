import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  applyPointerPan,
  ensureTilesetTiles,
  tilesetTileRect,
  type TilesetCollision,
  type TilesetPayload,
} from "@babylonslate/assets";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { cn } from "@babylonslate/ui/lib/utils";

export type AtlasTileGridTool = "move" | "select";

export interface AtlasTileGridProps {
  tileset: TilesetPayload;
  imageUrl: string | null;
  selectedId: number;
  onSelect: (tileId: number) => void;
  emptyLabel?: string;
  panZoom?: boolean;
  tool?: AtlasTileGridTool;
  onImageSize?: (width: number, height: number) => void;
  "data-testid"?: string;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const TAP_SELECT_PX = 8;

function fitAtlasView(
  surfaceWidth: number,
  surfaceHeight: number,
  atlasWidth: number,
  atlasHeight: number,
): { zoom: number; panX: number; panY: number } {
  if (
    surfaceWidth <= 0 ||
    surfaceHeight <= 0 ||
    atlasWidth <= 0 ||
    atlasHeight <= 0
  ) {
    return { zoom: 1, panX: 0, panY: 0 };
  }
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(
      MIN_ZOOM,
      Math.min(surfaceWidth / atlasWidth, surfaceHeight / atlasHeight) * 0.92,
    ),
  );
  return {
    zoom,
    panX: (surfaceWidth - atlasWidth * zoom) / 2,
    panY: (surfaceHeight - atlasHeight * zoom) / 2,
  };
}

/** Clickable atlas with a pixel-aligned grid, collision overlay, and optional pinch zoom. */
export function AtlasTileGrid({
  tileset,
  imageUrl,
  selectedId,
  onSelect,
  emptyLabel = "No Texture",
  panZoom = false,
  tool: toolProp,
  onImageSize,
  "data-testid": testId = "atlas-tile-grid",
}: AtlasTileGridProps) {
  const filled = ensureTilesetTiles(tileset);
  const tool = toolProp ?? (panZoom ? "move" : "select");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fittedKeyRef = useRef<string | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef({
    panX: 0,
    panY: 0,
    zoom: 1,
    spread: 1,
    midX: 0,
    midY: 0,
  });
  const panDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    panned: boolean;
  } | null>(null);
  const didPanRef = useRef(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  useLayoutEffect(() => {
    if (!panZoom) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const key = `${filled.atlasWidth}x${filled.atlasHeight}:${imageUrl ?? ""}`;
    if (fittedKeyRef.current === key) return;
    const rect = surface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    fittedKeyRef.current = key;
    const next = fitAtlasView(
      rect.width,
      rect.height,
      filled.atlasWidth,
      filled.atlasHeight,
    );
    setZoom(next.zoom);
    setPan({ x: next.panX, y: next.panY });
  }, [filled.atlasHeight, filled.atlasWidth, imageUrl, panZoom]);

  const pointerIdOf = (event: ReactPointerEvent<HTMLDivElement>) => {
    const native = event.nativeEvent as { pointerId?: number };
    if (typeof native.pointerId === "number") return native.pointerId;
    return typeof event.pointerId === "number" ? event.pointerId : 0;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panZoom) return;
    try {
      event.currentTarget.setPointerCapture?.(pointerIdOf(event));
    } catch {
      // Synthetic PointerEvents (Playwright / jsdom) have no active pointer.
    }
    pointersRef.current.set(pointerIdOf(event), {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointersRef.current.size >= 2) {
      event.preventDefault();
      panDragRef.current = null;
      didPanRef.current = true;
      const points = [...pointersRef.current.values()];
      const spread = Math.hypot(
        points[0]!.x - points[1]!.x,
        points[0]!.y - points[1]!.y,
      );
      pinchRef.current = {
        panX: pan.x,
        panY: pan.y,
        zoom,
        spread: Math.max(1, spread),
        midX: (points[0]!.x + points[1]!.x) / 2,
        midY: (points[0]!.y + points[1]!.y) / 2,
      };
      return;
    }
    didPanRef.current = false;
    if (tool === "move") {
      panDragRef.current = {
        pointerId: pointerIdOf(event),
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        panned: false,
      };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointerId = pointerIdOf(event);
    if (!panZoom || !pointersRef.current.has(pointerId)) return;
    pointersRef.current.set(pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointersRef.current.size >= 2) {
      event.preventDefault();
      const points = [...pointersRef.current.values()];
      const spread = Math.hypot(
        points[0]!.x - points[1]!.x,
        points[0]!.y - points[1]!.y,
      );
      const nextZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, pinchRef.current.zoom * (spread / pinchRef.current.spread)),
      );
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const originX = pinchRef.current.midX - rect.left;
      const originY = pinchRef.current.midY - rect.top;
      const scale = nextZoom / pinchRef.current.zoom;
      const midX = (points[0]!.x + points[1]!.x) / 2;
      const midY = (points[0]!.y + points[1]!.y) / 2;
      setZoom(nextZoom);
      setPan({
        x:
          originX -
          (originX - pinchRef.current.panX) * scale +
          (midX - pinchRef.current.midX),
        y:
          originY -
          (originY - pinchRef.current.panY) * scale +
          (midY - pinchRef.current.midY),
      });
      return;
    }
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== pointerId || tool !== "move") return;
    if (!drag.panned) {
      const distance = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (distance < TAP_SELECT_PX) return;
      drag.panned = true;
      didPanRef.current = true;
    }
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    setPan((current) => {
      const next = applyPointerPan({
        panX: current.x,
        panY: current.y,
        dx,
        dy,
      });
      return { x: next.panX, y: next.panY };
    });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointerId = pointerIdOf(event);
    pointersRef.current.delete(pointerId);
    if (panDragRef.current?.pointerId === pointerId) {
      panDragRef.current = null;
    }
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!panZoom) return;
    event.preventDefault();
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const originX = event.clientX - rect.left;
    const originY = event.clientY - rect.top;
    const nextZoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, zoom * 2 ** (-event.deltaY / 120)),
    );
    const scale = nextZoom / zoom;
    setZoom(nextZoom);
    setPan({
      x: originX - (originX - pan.x) * scale,
      y: originY - (originY - pan.y) * scale,
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3" data-testid={testId}>
      <div
        ref={surfaceRef}
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md border border-border",
          panZoom ? "touch-none" : null,
        )}
        style={{
          backgroundImage:
            "conic-gradient(#808080 0.25turn, #c0c0c0 0.25turn 0.5turn, #808080 0.5turn 0.75turn, #c0c0c0 0.75turn)",
          backgroundSize: "16px 16px",
        }}
        data-testid={`${testId}-surface`}
        data-tool={tool}
        data-zoom={String(zoom)}
        data-pan-x={String(pan.x)}
        data-pan-y={String(pan.y)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        {!imageUrl ? (
          <Empty
            className="pointer-events-none absolute inset-0 z-10 border-0 bg-transparent"
            data-testid={`${testId}-empty`}
          >
            <EmptyHeader>
              <EmptyTitle>Tileset</EmptyTitle>
              <EmptyDescription>{emptyLabel}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        <div
          className="relative shrink-0"
          style={{
            width: Math.max(1, filled.atlasWidth),
            height: Math.max(1, filled.atlasHeight),
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              className="absolute inset-0 size-full object-contain"
              style={{ imageRendering: "pixelated" }}
              onLoad={(event) => {
                onImageSize?.(
                  event.currentTarget.naturalWidth,
                  event.currentTarget.naturalHeight,
                );
              }}
            />
          ) : null}
          {filled.tiles.map((tile) => {
            const rect = tilesetTileRect(filled, tile.id);
            if (!rect) return null;
            const selected = tile.id === selectedId;
            return (
              <button
                key={tile.id}
                type="button"
                data-testid={`${testId}-cell-${tile.id}`}
                data-selected={selected ? "true" : "false"}
                data-collision={collisionAttr(tile.collision)}
                className={cn(
                  "absolute box-border border border-foreground/60",
                  selected ? "ring-2 ring-primary ring-inset" : null,
                  tile.collision === "full"
                    ? "bg-primary/20 [background-image:repeating-linear-gradient(45deg,transparent,transparent_4px,oklch(0.65_0.12_250/0.4)_4px,oklch(0.65_0.12_250/0.4)_8px)]"
                    : null,
                )}
                style={{
                  left: `${(rect.x / filled.atlasWidth) * 100}%`,
                  top: `${(rect.y / filled.atlasHeight) * 100}%`,
                  width: `${(rect.width / filled.atlasWidth) * 100}%`,
                  height: `${(rect.height / filled.atlasHeight) * 100}%`,
                }}
                aria-label={`Tile ${tile.id}`}
                aria-pressed={selected}
                onClick={(event) => {
                  event.stopPropagation();
                  if (didPanRef.current) {
                    event.preventDefault();
                    return;
                  }
                  onSelect(tile.id);
                }}
              >
                {tile.collision &&
                typeof tile.collision === "object" &&
                tile.collision.points.length > 1 ? (
                  <svg
                    className="pointer-events-none absolute inset-0 size-full text-primary"
                    viewBox="0 0 1 1"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polyline
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="0.06"
                      points={tile.collision.points
                        .map((point) => `${point.x},${1 - point.y}`)
                        .join(" ")}
                    />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function collisionAttr(value: TilesetCollision): string {
  if (value === "full") return "full";
  if (value && typeof value === "object") return "chain";
  return "none";
}
