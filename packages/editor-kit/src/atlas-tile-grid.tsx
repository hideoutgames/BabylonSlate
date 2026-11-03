import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ImageIcon } from "lucide-react";
import {
  applyPointerPan,
  atlasCellAt,
  ensureTilesetTiles,
  tilesetTileRect,
  type TilesetCollision,
  type TilesetPayload,
} from "@haptic/assets";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import { cn } from "@haptic/ui/lib/utils";
import { zoomViewAbout, type PanZoomLimits, type PanZoomView } from "./pan-zoom-model";
import { CONTEXT_MENU_LONG_PRESS_MS } from "./use-context-menu";

export type AtlasTileGridTool = "move" | "select";

/** A drag that moves something drawn on the sheet instead of panning it. */
export interface AtlasTileDrag {
  /** A press on `tileId`: return true to drag from it (a template drawn there) instead of panning. */
  start: (tileId: number) => boolean;
  /** Each further tile the dragging pointer enters. */
  move: (tileId: number) => void;
}

export interface AtlasTileGridProps {
  tileset: TilesetPayload;
  imageUrl: string | null;
  selectedId: number;
  selectedIds?: readonly number[];
  onSelect: (tileId: number) => void;
  /** Completed rectangular selection in Select mode; pinch/cancel never commits it. */
  onSelectionChange?: (tileIds: number[]) => void;
  emptyLabel?: string;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  panZoom?: boolean;
  tool?: AtlasTileGridTool;
  /** Extra content inside each cell (badges, dimming); memoize it: a new function redraws every cell. */
  renderCellOverlay?: (tileId: number) => ReactNode;
  /** Content over the atlas, positioned in atlas pixels (a template preview). */
  overlay?: ReactNode;
  /** A right-click, or a touch or pen held still on a tile, opens its menu at the press; a hold never selects. */
  onTileContextMenu?: (tileId: number, clientX: number, clientY: number) => void;
  /** In Move, a one-pointer drag from a grabbed tile reports tiles instead of panning. */
  tileDrag?: AtlasTileDrag;
  /** Centres the view on `tileId` whenever `token` changes, keeping the zoom. */
  reveal?: { tileId: number; token: number };
  onImageSize?: (width: number, height: number) => void;
  "data-testid"?: string;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const ZOOM_LIMITS: PanZoomLimits = { minScale: MIN_ZOOM, maxScale: MAX_ZOOM };
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

/**
 * Clickable atlas with a pixel-aligned grid, collision overlay, and optional
 * pinch zoom. Hosts can decorate cells, draw over the atlas, open a tile menu
 * and drag content across the sheet.
 */
export function AtlasTileGrid({
  tileset,
  imageUrl,
  selectedId,
  selectedIds,
  onSelect,
  onSelectionChange,
  emptyLabel = "No Texture",
  emptyDescription,
  emptyAction,
  panZoom = false,
  tool: toolProp,
  renderCellOverlay,
  overlay,
  onTileContextMenu,
  tileDrag,
  reveal,
  onImageSize,
  "data-testid": testId = "atlas-tile-grid",
}: AtlasTileGridProps) {
  const filled = useMemo(() => ensureTilesetTiles(tileset), [tileset]);
  const tool = toolProp ?? (panZoom ? "move" : "select");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
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
  const tapRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    tileId: number;
  } | null>(null);
  const selectionDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    ids: number[] | null;
  } | null>(null);
  /** A `tileDrag` in progress and the last tile it reported. */
  const tileDragRef = useRef<{ pointerId: number; lastTileId: number } | null>(null);
  /** A touch or pen hold that opens the tile menu unless the press moves or ends first. */
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<{
    ids: number[];
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const highlightedIds = useMemo(
    () => new Set(selectionPreview?.ids ?? selectedIds ?? [selectedId]),
    [selectionPreview?.ids, selectedIds, selectedId],
  );
  // One state, so wheel steps and pans that arrive before a render build on each other.
  const [view, setView] = useState<PanZoomView>({ scale: 1, x: 0, y: 0 });
  const zoom = view.scale;
  // Set once the user pans or zooms; a later surface resize keeps their view.
  const userViewRef = useRef(false);

  useLayoutEffect(() => {
    if (!panZoom) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    userViewRef.current = false;
    let previousWidth = 0;
    let previousHeight = 0;
    const fit = () => {
      const width = surface.clientWidth;
      const height = surface.clientHeight;
      if (width <= 0 || height <= 0 || userViewRef.current) return;
      if (width === previousWidth && height === previousHeight) return;
      previousWidth = width;
      previousHeight = height;
      const next = fitAtlasView(
        width,
        height,
        filled.atlasWidth,
        filled.atlasHeight,
      );
      setView({ scale: next.zoom, x: next.panX, y: next.panY });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [filled.atlasHeight, filled.atlasWidth, imageUrl, panZoom]);

  const pointerIdOf = (event: ReactPointerEvent<HTMLDivElement>) => {
    const native = event.nativeEvent as { pointerId?: number };
    if (typeof native.pointerId === "number") return native.pointerId;
    return typeof event.pointerId === "number" ? event.pointerId : 0;
  };

  const tileAtPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return atlasCellAt({
      localX: event.clientX,
      localY: event.clientY,
      imageX: rect.left,
      imageY: rect.top,
      imageWidth: rect.width,
      imageHeight: rect.height,
      tileset: filled,
    });
  };

  const clearHold = () => {
    if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  };
  useEffect(() => clearHold, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // A right press belongs to the tile menu, never to a pan or a tap.
    if (event.button === 2 && onTileContextMenu) return;
    if (!panZoom && !(tool === "select" && onSelectionChange)) return;
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
      tapRef.current = null;
      selectionDragRef.current = null;
      tileDragRef.current = null;
      clearHold();
      setSelectionPreview(null);
      didPanRef.current = true;
      const points = [...pointersRef.current.values()];
      const spread = Math.hypot(
        points[0]!.x - points[1]!.x,
        points[0]!.y - points[1]!.y,
      );
      pinchRef.current = {
        panX: view.x,
        panY: view.y,
        zoom,
        spread: Math.max(1, spread),
        midX: (points[0]!.x + points[1]!.x) / 2,
        midY: (points[0]!.y + points[1]!.y) / 2,
      };
      return;
    }
    didPanRef.current = false;
    tapRef.current = {
      pointerId: pointerIdOf(event),
      x: event.clientX,
      y: event.clientY,
      tileId: tileAtPointer(event),
    };
    const pressedTileId = tapRef.current.tileId;
    if (tool === "move" && tileDrag && pressedTileId > 0 && tileDrag.start(pressedTileId)) {
      event.preventDefault();
      tileDragRef.current = { pointerId: pointerIdOf(event), lastTileId: pressedTileId };
      return;
    }
    if (onTileContextMenu && pressedTileId > 0 && event.pointerType !== "mouse") {
      const pointerId = pointerIdOf(event);
      const { clientX, clientY } = event;
      clearHold();
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        // Moving past the tap distance, a second finger or a release has already let go of the tap.
        if (tapRef.current?.pointerId !== pointerId) return;
        tapRef.current = null;
        panDragRef.current = null;
        selectionDragRef.current = null;
        // The release's click belongs to the menu, not to the cell.
        didPanRef.current = true;
        setSelectionPreview(null);
        onTileContextMenu(pressedTileId, clientX, clientY);
      }, CONTEXT_MENU_LONG_PRESS_MS);
    }
    if (tool === "move") {
      panDragRef.current = {
        pointerId: pointerIdOf(event),
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        panned: false,
      };
    } else if (onSelectionChange) {
      const rect = imageRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      selectionDragRef.current = {
        pointerId: pointerIdOf(event),
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: ((event.clientX - rect.left) / rect.width) * filled.atlasWidth,
        startY: ((event.clientY - rect.top) / rect.height) * filled.atlasHeight,
        ids: null,
      };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointerId = pointerIdOf(event);
    if (!pointersRef.current.has(pointerId)) return;
    pointersRef.current.set(pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const tap = tapRef.current;
    if (
      tap &&
      Math.hypot(event.clientX - tap.x, event.clientY - tap.y) >= TAP_SELECT_PX
    ) {
      tapRef.current = null;
      clearHold();
    }
    if (pointersRef.current.size >= 2) {
      if (!panZoom) return;
      event.preventDefault();
      const points = [...pointersRef.current.values()];
      const spread = Math.hypot(
        points[0]!.x - points[1]!.x,
        points[0]!.y - points[1]!.y,
      );
      const nextZoom = Math.min(
        MAX_ZOOM,
        Math.max(
          MIN_ZOOM,
          pinchRef.current.zoom * (spread / pinchRef.current.spread),
        ),
      );
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const originX = pinchRef.current.midX - rect.left;
      const originY = pinchRef.current.midY - rect.top;
      const scale = nextZoom / pinchRef.current.zoom;
      const midX = (points[0]!.x + points[1]!.x) / 2;
      const midY = (points[0]!.y + points[1]!.y) / 2;
      userViewRef.current = true;
      setView({
        scale: nextZoom,
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
    const tileDragState = tileDragRef.current;
    if (tileDragState?.pointerId === pointerId) {
      event.preventDefault();
      const tileId = tileAtPointer(event);
      if (tileId > 0 && tileId !== tileDragState.lastTileId) {
        tileDragState.lastTileId = tileId;
        // The press stays a tap until the pointer leaves the tile it started on.
        tapRef.current = null;
        didPanRef.current = true;
        tileDrag?.move(tileId);
      }
      return;
    }
    const selection = selectionDragRef.current;
    if (selection && selection.pointerId === pointerId && tool === "select") {
      if (
        Math.hypot(
          event.clientX - selection.startClientX,
          event.clientY - selection.startClientY,
        ) < TAP_SELECT_PX &&
        !selection.ids
      )
        return;
      const rect = imageRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      event.preventDefault();
      didPanRef.current = true;
      const endX =
        ((event.clientX - rect.left) / rect.width) * filled.atlasWidth;
      const endY =
        ((event.clientY - rect.top) / rect.height) * filled.atlasHeight;
      const x = Math.min(selection.startX, endX);
      const y = Math.min(selection.startY, endY);
      const right = Math.max(selection.startX, endX);
      const bottom = Math.max(selection.startY, endY);
      const ids = filled.tiles
        .filter((tile) => {
          const cell = tilesetTileRect(filled, tile.id);
          return (
            cell &&
            cell.x <= right &&
            cell.x + cell.width >= x &&
            cell.y <= bottom &&
            cell.y + cell.height >= y
          );
        })
        .map((tile) => tile.id);
      // Keep the same array while the covered tiles stay the same, so moving
      // inside them redraws the rectangle without rebuilding every tile.
      const previous = selection.ids;
      const unchanged =
        previous?.length === ids.length &&
        ids.every((id, index) => previous[index] === id);
      const nextIds = unchanged ? previous : ids;
      selection.ids = nextIds;
      setSelectionPreview({
        ids: nextIds,
        x,
        y,
        width: right - x,
        height: bottom - y,
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
      userViewRef.current = true;
    }
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    setView((current) => {
      const next = applyPointerPan({
        panX: current.x,
        panY: current.y,
        dx,
        dy,
      });
      return { ...current, x: next.panX, y: next.panY };
    });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointerId = pointerIdOf(event);
    pointersRef.current.delete(pointerId);
    clearHold();
    const tap = tapRef.current;
    if (tap?.pointerId === pointerId) {
      tapRef.current = null;
      if (
        event.type !== "pointercancel" &&
        tap.tileId > 0 &&
        Math.hypot(event.clientX - tap.x, event.clientY - tap.y) <
          TAP_SELECT_PX &&
        tileAtPointer(event) === tap.tileId
      ) {
        onSelect(tap.tileId);
        // Capture retargets the browser click to the surface; some hosts still
        // deliver it to the cell, so consume either path after selecting once.
        didPanRef.current = true;
      }
    }
    if (panDragRef.current?.pointerId === pointerId) {
      panDragRef.current = null;
    }
    if (tileDragRef.current?.pointerId === pointerId) {
      tileDragRef.current = null;
    }
    const selection = selectionDragRef.current;
    if (selection?.pointerId === pointerId) {
      selectionDragRef.current = null;
      setSelectionPreview(null);
      if (event.type !== "pointercancel" && selection.ids?.length) {
        onSelectionChange?.(selection.ids);
      }
    }
  };

  const onWheel = (event: WheelEvent) => {
    if (!panZoom) return;
    event.preventDefault();
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const pivot = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const factor = 2 ** (-event.deltaY / 120);
    userViewRef.current = true;
    setView((current) => zoomViewAbout(current, factor, pivot, ZOOM_LIMITS));
  };
  // React attaches wheel listeners as passive, which ignore preventDefault, so
  // the surface keeps a native non-passive listener that runs the latest handler.
  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const listener = (event: WheelEvent) => wheelRef.current(event);
    surface.addEventListener("wheel", listener, { passive: false });
    return () => surface.removeEventListener("wheel", listener);
  }, []);

  const revealToken = reveal?.token;
  const revealTileId = reveal?.tileId;
  useLayoutEffect(() => {
    if (revealToken === undefined || revealTileId === undefined) return;
    const surface = surfaceRef.current;
    const rect = tilesetTileRect(filled, revealTileId);
    if (!surface || !rect) return;
    const width = surface.clientWidth;
    const height = surface.clientHeight;
    if (width <= 0 || height <= 0) return;
    userViewRef.current = true;
    setView((current) => ({
      ...current,
      x: width / 2 - (rect.x + rect.width / 2) * current.scale,
      y: height / 2 - (rect.y + rect.height / 2) * current.scale,
    }));
    // Only a new token reveals again; tile edits keep the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken]);

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onTileContextMenu) return;
    event.preventDefault();
    // A positioned press names the tile under it; a keyboard menu (or jsdom) has only its target cell.
    const rect = imageRef.current?.getBoundingClientRect();
    const atPoint = rect
      ? atlasCellAt({
          localX: event.clientX,
          localY: event.clientY,
          imageX: rect.left,
          imageY: rect.top,
          imageWidth: rect.width,
          imageHeight: rect.height,
          tileset: filled,
        })
      : 0;
    const cell = event.target instanceof Element ? event.target.closest("[data-tile-id]") : null;
    const tileId = atPoint > 0 ? atPoint : Number(cell?.getAttribute("data-tile-id") ?? 0);
    if (tileId > 0) onTileContextMenu(tileId, event.clientX, event.clientY);
  };

  const tileButtons = useMemo(
    () =>
      filled.tiles.map((tile) => {
        const rect = tilesetTileRect(filled, tile.id);
        if (!rect) return null;
        const selected = highlightedIds.has(tile.id);
        return (
          <button
            key={tile.id}
            type="button"
            data-testid={`${testId}-cell-${tile.id}`}
            data-tile-id={tile.id}
            data-selected={selected ? "true" : "false"}
            data-collision={collisionAttr(tile.collision)}
            className={cn(
              "absolute box-border border-solid border-foreground/25 outline-none [border-width:calc(1px/var(--atlas-zoom,1))] hover:bg-foreground/10 focus-visible:z-10 focus-visible:shadow-[inset_0_0_0_calc(2px/var(--atlas-zoom,1))_var(--ring)]",
              selected
                ? "z-10 border-transparent shadow-[inset_0_0_0_calc(2px/var(--atlas-zoom,1))_var(--graph-state-selected),0_0_0_calc(1px/var(--atlas-zoom,1))_var(--background)]"
                : null,
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
            onKeyDown={() => {
              didPanRef.current = false;
            }}
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
            {renderCellOverlay?.(tile.id)}
          </button>
        );
      }),
    [filled, highlightedIds, onSelect, renderCellOverlay, testId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3" data-testid={testId}>
      <div
        ref={surfaceRef}
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md border border-border",
          panZoom || onSelectionChange ? "touch-none" : null,
        )}
        style={{
          backgroundImage:
            "conic-gradient(var(--muted) 0.25turn, var(--background) 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, var(--background) 0.75turn)",
          backgroundSize: "16px 16px",
        }}
        data-testid={`${testId}-surface`}
        data-tool={tool}
        data-zoom={String(zoom)}
        data-pan-x={String(view.x)}
        data-pan-y={String(view.y)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onTileContextMenu ? onContextMenu : undefined}
      >
        {!imageUrl ? (
          <Empty
            className="absolute inset-0 z-20 rounded-none border-0 bg-sidebar"
            data-testid={`${testId}-empty`}
          >
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ImageIcon />
              </EmptyMedia>
              {emptyLabel ? <EmptyTitle>{emptyLabel}</EmptyTitle> : null}
              {emptyDescription ? (
                <EmptyDescription>{emptyDescription}</EmptyDescription>
              ) : null}
            </EmptyHeader>
            {emptyAction ? <EmptyContent>{emptyAction}</EmptyContent> : null}
          </Empty>
        ) : null}
        <div
          ref={imageRef}
          className={cn(
            panZoom ? "absolute left-0 top-0" : "relative shrink-0",
          )}
          style={
            {
              width: Math.max(1, filled.atlasWidth),
              height: Math.max(1, filled.atlasHeight),
              transform: `translate(${view.x}px, ${view.y}px) scale(${zoom})`,
              transformOrigin: "0 0",
              "--atlas-zoom": panZoom ? zoom : 1,
            } as CSSProperties
          }
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
          {tileButtons}
          {overlay}
          {selectionPreview ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute border border-primary bg-primary/10"
              style={{
                left: selectionPreview.x,
                top: selectionPreview.y,
                width: selectionPreview.width,
                height: selectionPreview.height,
              }}
            />
          ) : null}
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
