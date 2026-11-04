import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ImageIcon } from "lucide-react";
import {
  applyPointerPan,
  atlasCellAt,
  ensureTilesetTiles,
  tilesetAtlasColumns,
  tilesetTileRect,
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
import {
  atlasTileAt,
  atlasTileCell,
  atlasTilesInRect,
  drawAtlasTileGrid,
  type AtlasGridColors,
  type AtlasTileMark,
} from "./atlas-tile-grid-canvas";

export type { AtlasTileMark } from "./atlas-tile-grid-canvas";

export type AtlasTileGridTool = "move" | "select";

/**
 * A mouse drag that carries a tile off the sheet (onto a drop target the host
 * finds under the pointer) instead of panning. Touch and pen always pan.
 */
export interface AtlasTileDrag {
  /** A left mouse press on `tileId`: return true to drag the tile once the pointer moves past the tap distance. */
  start: (tileId: number) => boolean;
  /** Each move of the drag, in client pixels. */
  move: (clientX: number, clientY: number) => void;
  /** The release, in client pixels, or `null` when the drag is cancelled (a second pointer, a pointer cancel). */
  end: (drop: { clientX: number; clientY: number } | null) => void;
}

/** Imperative view controls (`ref`). */
export interface AtlasTileGridHandle {
  /** Zoom about the surface's centre by `factor` (above 1 zooms in). */
  zoomBy: (factor: number) => void;
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
  /** Marks drawn on tiles (a corner dot, dimming); keep the same map while the marks are the same. */
  cellMarks?: ReadonlyMap<number, AtlasTileMark>;
  /** Content over the atlas, positioned in atlas pixels (a block outline). */
  overlay?: ReactNode;
  /** In Move, a left mouse drag from a tile the host accepts carries it off the sheet instead of panning. */
  tileDrag?: AtlasTileDrag;
  /** The tile under a hovering mouse (0 off the atlas or when the mouse leaves); touch and pen never hover. */
  onTileHover?: (tileId: number) => void;
  onImageSize?: (width: number, height: number) => void;
  ref?: Ref<AtlasTileGridHandle>;
  "data-testid"?: string;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const ZOOM_LIMITS: PanZoomLimits = { minScale: MIN_ZOOM, maxScale: MAX_ZOOM };
const TAP_SELECT_PX = 8;
const NO_MARKS: ReadonlyMap<number, AtlasTileMark> = new Map();

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

/** Theme colours the canvas draws with, read when it draws so a theme switch shows on the next draw. */
function gridColors(element: Element): AtlasGridColors {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    foreground: read("--foreground", "#fafafa"),
    background: read("--background", "#0a0a0a"),
    primary: read("--primary", "#3b82f6"),
    selected: read("--graph-state-selected", "#f59e0b"),
  };
}

const HATCH_TILE = 11;
/** The hatch's repeating tile, drawn once. */
let hatchTile: HTMLCanvasElement | null = null;

/** The Full collision hatch: diagonal stripes in atlas pixels, so they scale with the atlas. */
function hatchPattern(ctx: CanvasRenderingContext2D, scale: number, x: number, y: number): CanvasPattern | null {
  if (typeof document === "undefined" || typeof ctx.createPattern !== "function") return null;
  if (!hatchTile) {
    // 11 px across at 45° is a stripe every ~8 px, ~4 px wide, as the stylesheet hatch was.
    const tile = document.createElement("canvas");
    tile.width = HATCH_TILE;
    tile.height = HATCH_TILE;
    const paint = tile.getContext("2d");
    if (!paint) return null;
    paint.fillStyle = "oklch(0.65 0.12 250 / 0.4)";
    paint.beginPath();
    // One stripe through the tile and its wrap-around copies, so it repeats seamlessly.
    for (const offset of [-HATCH_TILE, 0, HATCH_TILE]) {
      paint.moveTo(offset, 0);
      paint.lineTo(offset + HATCH_TILE / 2, 0);
      paint.lineTo(offset + HATCH_TILE * 1.5, HATCH_TILE);
      paint.lineTo(offset + HATCH_TILE, HATCH_TILE);
      paint.closePath();
    }
    paint.fill();
    hatchTile = tile;
  }
  const pattern = ctx.createPattern(hatchTile, "repeat");
  if (pattern && typeof DOMMatrix === "function" && typeof pattern.setTransform === "function") {
    pattern.setTransform(new DOMMatrix([scale, 0, 0, scale, x, y]));
  }
  return pattern;
}

/**
 * Clickable atlas with a pixel-aligned grid, collision overlay, and optional
 * pinch zoom. The grid, selection, collision and host marks draw on one canvas
 * over the image, only for the cells in view; taps hit-test by column and row;
 * one roving cell button carries keyboard focus. Hosts can mark tiles, draw
 * over the atlas, follow the hovering mouse and drag tiles off the sheet.
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
  cellMarks = NO_MARKS,
  overlay,
  tileDrag,
  onTileHover,
  onImageSize,
  ref,
  "data-testid": testId = "atlas-tile-grid",
}: AtlasTileGridProps) {
  const filled = useMemo(() => ensureTilesetTiles(tileset), [tileset]);
  const tool = toolProp ?? (panZoom ? "move" : "select");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
  /** A `tileDrag` press, and whether it has moved far enough to be a drag. */
  const tileDragRef = useRef<{ pointerId: number; startX: number; startY: number; dragging: boolean } | null>(null);
  /** The last tile reported to `onTileHover`. */
  const reportedTileRef = useRef(0);
  /** The tile under a hovering mouse, drawn highlighted. */
  const [hoverTile, setHoverTile] = useState(0);
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
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  // The tile the roving cell stands on: keyboard focus moves it, a tap or the selection sets it.
  const [focusChoice, setFocusChoice] = useState<number | null>(null);
  // A new selection from the host brings the focus cell to it; an emptied one leaves it where it is.
  const leadSelected = selectedIds !== undefined ? selectedIds[0] ?? 0 : selectedId;
  const [seenLead, setSeenLead] = useState(leadSelected);
  if (leadSelected !== seenLead) {
    setSeenLead(leadSelected);
    if (leadSelected > 0) setFocusChoice(null);
  }
  const tileCount = filled.tiles.length;
  const focusedId = focusChoice !== null && focusChoice >= 1 && focusChoice <= tileCount
    ? focusChoice
    : Math.min(Math.max(1, selectedIds?.[0] ?? selectedId), Math.max(1, tileCount));

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    if (panZoom) userViewRef.current = false;
    let previousWidth = 0;
    let previousHeight = 0;
    const fit = () => {
      const width = surface.clientWidth;
      const height = surface.clientHeight;
      setSurfaceSize((current) => (current.width === width && current.height === height ? current : { width, height }));
      if (!panZoom || width <= 0 || height <= 0 || userViewRef.current) return;
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
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [filled.atlasHeight, filled.atlasWidth, imageUrl, panZoom]);

  // Draw after every change of what the canvas shows; a frame draws only the cells in view.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const surface = surfaceRef.current;
    if (!canvas || !surface) return;
    // Without pan and zoom the canvas covers the atlas box at its own size.
    const { width, height } = panZoom ? surfaceSize : { width: filled.atlasWidth, height: filled.atlasHeight };
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const pixelWidth = Math.max(1, Math.floor(width * dpr));
    const pixelHeight = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx || width <= 0 || height <= 0) return;
    const mapping = panZoom ? view : { scale: 1, x: 0, y: 0 };
    drawAtlasTileGrid(ctx, {
      tileset: filled,
      view: mapping,
      width,
      height,
      dpr,
      selected: highlightedIds,
      marks: cellMarks,
      hover: hoverTile,
      colors: gridColors(surface),
      hatch: hatchPattern(ctx, mapping.scale, mapping.x, mapping.y),
    });
  }, [cellMarks, filled, highlightedIds, hoverTile, panZoom, surfaceSize, view]);

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

  const reportHover = (tileId: number) => {
    setHoverTile(tileId);
    // A host that starts listening again hears the tile under the mouse on its next move.
    if (!onTileHover) {
      reportedTileRef.current = 0;
      return;
    }
    if (reportedTileRef.current === tileId) return;
    reportedTileRef.current = tileId;
    onTileHover(tileId);
  };

  /** Ends a tile drag; a press that never moved past the tap distance reports nothing. */
  const endTileDrag = (drop: { clientX: number; clientY: number } | null) => {
    const drag = tileDragRef.current;
    tileDragRef.current = null;
    if (drag?.dragging) tileDrag?.end(drop);
  };

  useImperativeHandle(ref, () => ({
    zoomBy: (factor) => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const pivot = { x: surface.clientWidth / 2, y: surface.clientHeight / 2 };
      userViewRef.current = true;
      setView((current) => zoomViewAbout(current, factor, pivot, ZOOM_LIMITS));
    },
  }), []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Every sheet selects a tapped tile; only a sheet that pans, zooms or drags a selection keeps the pointer.
    if (panZoom || (tool === "select" && onSelectionChange)) {
      try {
        event.currentTarget.setPointerCapture?.(pointerIdOf(event));
      } catch {
        // Synthetic PointerEvents (Playwright / jsdom) have no active pointer.
      }
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
      endTileDrag(null);
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
    if (
      tool === "move" &&
      tileDrag &&
      event.pointerType === "mouse" &&
      event.button === 0 &&
      pressedTileId > 0 &&
      tileDrag.start(pressedTileId)
    ) {
      event.preventDefault();
      tileDragRef.current = {
        pointerId: pointerIdOf(event),
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
      };
      return;
    }
    if (tool === "move") {
      if (!panZoom) return;
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
    if (!pointersRef.current.has(pointerId)) {
      if (event.pointerType === "mouse") reportHover(tileAtPointer(event));
      return;
    }
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
      if (!tileDragState.dragging) {
        // The press stays a tap until the pointer moves past the tap distance.
        if (
          Math.hypot(
            event.clientX - tileDragState.startX,
            event.clientY - tileDragState.startY,
          ) < TAP_SELECT_PX
        )
          return;
        tileDragState.dragging = true;
        didPanRef.current = true;
      }
      tileDrag?.move(event.clientX, event.clientY);
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
      // The covered columns and rows name the tiles; no tile is visited to find them.
      const ids = atlasTilesInRect(filled, { x, y, right, bottom });
      // Keep the same array while the covered tiles stay the same, so moving
      // inside them redraws only the rectangle.
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
        setFocusChoice(tap.tileId);
        onSelect(tap.tileId);
        // A tap on the focus cell is followed by its click; consume it after selecting once.
        didPanRef.current = true;
      }
    }
    if (panDragRef.current?.pointerId === pointerId) {
      panDragRef.current = null;
    }
    if (tileDragRef.current?.pointerId === pointerId) {
      endTileDrag(
        event.type === "pointercancel"
          ? null
          : { clientX: event.clientX, clientY: event.clientY },
      );
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

  /** Arrow keys move the focus cell a column or a row (Home / End to the row's ends); the view follows it. */
  const onCellKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    didPanRef.current = false;
    const cell = atlasTileCell(filled, focusedId);
    if (!cell) return;
    const columns = tilesetAtlasColumns(filled);
    const steps: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    let next = 0;
    if (event.key in steps) {
      const [dx, dy] = steps[event.key]!;
      next = atlasTileAt(filled, cell.column + dx, cell.row + dy);
    } else if (event.key === "Home") next = atlasTileAt(filled, 0, cell.row);
    else if (event.key === "End") next = atlasTileAt(filled, columns - 1, cell.row);
    else return;
    event.preventDefault();
    if (next <= 0) return;
    setFocusChoice(next);
    if (panZoom) setView((current) => viewShowing(current, filled, next, surfaceSize));
  };

  const focusRect = tilesetTileRect(filled, focusedId);
  const focusSelected = highlightedIds.has(focusedId);
  const dotTiles: number[] = [];
  const dimTiles: number[] = [];
  for (const [id, mark] of cellMarks) (mark === "dot" ? dotTiles : dimTiles).push(id);
  const layerStyle: CSSProperties = {
    width: Math.max(1, filled.atlasWidth),
    height: Math.max(1, filled.atlasHeight),
    transform: panZoom ? `translate(${view.x}px, ${view.y}px) scale(${zoom})` : undefined,
    transformOrigin: "0 0",
  };
  const image = imageUrl ? (
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
  ) : null;
  const canvas = (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full"
      data-testid={`${testId}-canvas`}
      data-dot-tiles={dotTiles.length ? dotTiles.sort((a, b) => a - b).join(",") : undefined}
      data-dim-tiles={dimTiles.length ? dimTiles.sort((a, b) => a - b).join(",") : undefined}
    />
  );
  // Host content, the drag rectangle and the focus cell share the atlas's pixel space.
  const overlays = (
    <>
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
      {focusRect ? (
        <button
          type="button"
          data-testid={`${testId}-cell-${focusedId}`}
          data-tile-id={focusedId}
          data-selected={focusSelected ? "true" : "false"}
          className="pointer-events-auto absolute outline-none focus-visible:shadow-[inset_0_0_0_calc(2px/var(--atlas-zoom,1))_var(--ring)]"
          style={{
            left: focusRect.x,
            top: focusRect.y,
            width: focusRect.width,
            height: focusRect.height,
          }}
          aria-label={`Tile ${focusedId}`}
          aria-pressed={focusSelected}
          onKeyDown={onCellKeyDown}
          onClick={(event) => {
            event.stopPropagation();
            if (didPanRef.current) {
              event.preventDefault();
              return;
            }
            onSelect(focusedId);
          }}
        />
      ) : null}
    </>
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
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") reportHover(0);
        }}
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
        {panZoom ? (
          <>
            <div ref={imageRef} className="absolute left-0 top-0" style={layerStyle} data-testid={`${testId}-image`}>
              {image}
            </div>
            {canvas}
            <div
              className="pointer-events-none absolute left-0 top-0"
              style={{ ...layerStyle, "--atlas-zoom": zoom } as CSSProperties}
            >
              {overlays}
            </div>
          </>
        ) : (
          <div
            ref={imageRef}
            className="relative shrink-0"
            style={{ ...layerStyle, "--atlas-zoom": 1 } as CSSProperties}
            data-testid={`${testId}-image`}
          >
            {image}
            {canvas}
            {overlays}
          </div>
        )}
      </div>
    </div>
  );
}

/** `view` moved the least so tile `tileId` is wholly on the surface. */
function viewShowing(view: PanZoomView, tileset: TilesetPayload, tileId: number, surface: { width: number; height: number }): PanZoomView {
  const rect = tilesetTileRect(tileset, tileId);
  if (!rect || surface.width <= 0 || surface.height <= 0) return view;
  const left = view.x + rect.x * view.scale;
  const top = view.y + rect.y * view.scale;
  const right = left + rect.width * view.scale;
  const bottom = top + rect.height * view.scale;
  const dx = left < 0 ? -left : right > surface.width ? surface.width - right : 0;
  const dy = top < 0 ? -top : bottom > surface.height ? surface.height - bottom : 0;
  return dx === 0 && dy === 0 ? view : { ...view, x: view.x + dx, y: view.y + dy };
}
