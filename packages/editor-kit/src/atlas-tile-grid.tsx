import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
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

export interface AtlasTileGridProps {
  tileset: TilesetPayload;
  imageUrl: string | null;
  selectedId: number;
  onSelect: (tileId: number) => void;
  emptyLabel?: string;
  panZoom?: boolean;
  onImageSize?: (width: number, height: number) => void;
  "data-testid"?: string;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;

/** Clickable atlas with a pixel-aligned grid, collision overlay, and optional pinch zoom. */
export function AtlasTileGrid({
  tileset,
  imageUrl,
  selectedId,
  onSelect,
  emptyLabel = "No Texture",
  panZoom = false,
  onImageSize,
  "data-testid": testId = "atlas-tile-grid",
}: AtlasTileGridProps) {
  const filled = ensureTilesetTiles(tileset);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef({
    panX: 0,
    panY: 0,
    zoom: 1,
    spread: 1,
  });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  const pointerIdOf = (event: ReactPointerEvent<HTMLDivElement>) => {
    const native = event.nativeEvent as { pointerId?: number };
    if (typeof native.pointerId === "number") return native.pointerId;
    return typeof event.pointerId === "number" ? event.pointerId : 0;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panZoom) return;
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(pointerIdOf(event));
    }
    pointersRef.current.set(pointerIdOf(event), {
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
      pinchRef.current = {
        panX: pan.x,
        panY: pan.y,
        zoom,
        spread: Math.max(1, spread),
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
    if (pointersRef.current.size < 2) return;
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
    const originX = (points[0]!.x + points[1]!.x) / 2 - rect.left;
    const originY = (points[0]!.y + points[1]!.y) / 2 - rect.top;
    const scale = nextZoom / pinchRef.current.zoom;
    setZoom(nextZoom);
    setPan({
      x: originX - (originX - pinchRef.current.panX) * scale,
      y: originY - (originY - pinchRef.current.panY) * scale,
    });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(pointerIdOf(event));
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
        data-zoom={String(zoom)}
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
          className="relative max-h-full max-w-full"
          style={{
            aspectRatio: `${Math.max(1, filled.atlasWidth)} / ${Math.max(1, filled.atlasHeight)}`,
            width: "100%",
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              className="absolute inset-0 size-full"
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
                  onSelect(tile.id);
                }}
              >
                {selected &&
                tile.collision &&
                typeof tile.collision === "object" ? (
                  <svg
                    className="absolute inset-0 size-full"
                    viewBox="0 0 1 1"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polyline
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="0.04"
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
