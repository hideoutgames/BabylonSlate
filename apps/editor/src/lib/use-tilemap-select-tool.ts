import { useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  clampTilemapCellRect,
  copyTilemapCells,
  eraseTilemapCells,
  moveTilemapCells,
  offsetTilemapCellRect,
  placeTilemapClip,
  retargetTilemapClip,
  tilemapClipLostTiles,
  tilemapSelectionExtent,
  tilemapSelectionMergeKey,
  type TileCell,
  type TilemapCellRect,
  type TilemapChunk,
  type TilemapClip,
  type TilemapPayload,
  type TilesetPayload,
} from "@haptic/assets";
import type { TilemapPaintFloat } from "./tilemap-paint-renderer";
import { tilemapClipboard } from "./tilemap-clipboard";

/**
 * What the Select tool shows: the selected cells, and at most one block of
 * tiles off the map, either the selection lifted by a drag (it lands on
 * release) or a paste waiting to be placed.
 */
export interface TilemapSelectState {
  rect: TilemapCellRect | null;
  /** The selected tiles while a drag moves them: they show `offset` cells away; the map is unchanged until release. */
  lift: { rect: TilemapCellRect; layerId: string | null; clip: TilemapClip; offset: TileCell } | null;
  /** Pasted tiles waiting to be placed, ready for this map (`retargetTilemapClip`), with their bottom-left cell at `origin`. */
  paste: { clip: TilemapClip; origin: TileCell } | null;
}

const EMPTY: TilemapSelectState = { rect: null, lift: null, paste: null };

/** One pointer gesture of the Select tool. */
type SelectGesture =
  /** Drawing a new selection; `before` comes back if it is cancelled. */
  | { kind: "marquee"; pointerId: number; start: TileCell; moved: boolean; before: TilemapCellRect | null }
  /** Dragging the selection: its tiles lift once the pointer leaves the start cell. */
  | { kind: "lift"; pointerId: number; start: TileCell; rect: TilemapCellRect; layerId: string | null; clip: TilemapClip | null; id: string }
  /** Dragging a paste; `origin` is where it was when the drag began. */
  | { kind: "paste"; pointerId: number; start: TileCell; origin: TileCell; moved: boolean };

export interface TilemapSelectToolOptions {
  /** The map as this render shows it. */
  tilemap: TilemapPayload;
  /** The latest map, which an edit builds on and then moves to. */
  latestRef: RefObject<TilemapPayload>;
  /** The paint layer: the Select tool's layer unless All Layers is on, and where a one-layer paste goes. */
  paintLayerId: string | null;
  tilesets: ReadonlyMap<string, TilesetPayload>;
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
  newId: () => string;
}

const inside = (rect: TilemapCellRect, cell: TileCell) =>
  cell.x >= rect.minX && cell.x <= rect.maxX && cell.y >= rect.minY && cell.y <= rect.maxY;

const sameRect = (a: TilemapCellRect | null, b: TilemapCellRect | null) =>
  a === b || (!!a && !!b && a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY);

const clipRect = (clip: TilemapClip, origin: TileCell): TilemapCellRect => ({
  minX: origin.x, minY: origin.y, maxX: origin.x + clip.width - 1, maxY: origin.y + clip.height - 1,
});

/**
 * Tilemap Paint's **Select** tool: selecting cells, moving them (a drag, or
 * an arrow-key nudge), Cut, Copy, Paste and Delete. Every edit is one
 * document change through `onChange`, built on `latestRef` and with a
 * selection merge key, so a drag or a held arrow key is one undo step. A
 * drag's tiles preview from the map's own chunks at an offset
 * (`TilemapPaintFloat`), so moving even the whole map writes nothing until release.
 */
export function useTilemapSelectTool({ tilemap, latestRef, paintLayerId, tilesets, onChange, newId }: TilemapSelectToolOptions) {
  const [state, setStateValue] = useState<TilemapSelectState>(EMPTY);
  const stateRef = useRef(state);
  const setState = (next: TilemapSelectState) => {
    stateRef.current = next;
    setStateValue(next);
  };
  const [allLayers, setAllLayers] = useState(false);
  const gestureRef = useRef<SelectGesture | null>(null);
  const nudgeIdRef = useRef<string | null>(null);
  const clip = useSyncExternalStore(tilemapClipboard.subscribe, tilemapClipboard.read);
  /** The layers the tool acts on: the paint layer, or every layer (`null`). */
  const scope = (): string | null => (allLayers ? null : paintLayerId);

  /** Commit `next` as one edit, when it changes the map. */
  const commit = (next: TilemapPayload, operation: string, id: string) => {
    if (next === latestRef.current) return;
    latestRef.current = next;
    onChange(next as unknown as Record<string, unknown>, tilemapSelectionMergeKey(operation, id));
  };

  /** **Place**: write a waiting paste where it floats; its cells stay selected. */
  const place = () => {
    const { paste } = stateRef.current;
    if (!paste) return;
    commit(placeTilemapClip(latestRef.current, paste.clip, paste.origin, tilesets), "paste", newId());
    setState({ rect: clampTilemapCellRect(latestRef.current, clipRect(paste.clip, paste.origin)), lift: null, paste: null });
  };

  const cancelPaste = () => {
    if (stateRef.current.paste) setState(EMPTY);
  };

  /** Drop the gesture in progress without editing the map: a second finger, a hold that opened the menu. */
  const cancelGesture = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;
    const current = stateRef.current;
    if (gesture.kind === "marquee") setState({ ...current, rect: gesture.before });
    else if (gesture.kind === "lift") setState({ ...current, lift: null });
    else if (current.paste) setState({ ...current, paste: { ...current.paste, origin: gesture.origin } });
  };

  const press = (pointerId: number, cell: TileCell) => {
    cancelGesture();
    const { rect, paste } = stateRef.current;
    if (paste) gestureRef.current = { kind: "paste", pointerId, start: cell, origin: paste.origin, moved: false };
    else if (rect && inside(rect, cell)) gestureRef.current = { kind: "lift", pointerId, start: cell, rect, layerId: scope(), clip: null, id: newId() };
    else gestureRef.current = { kind: "marquee", pointerId, start: cell, moved: false, before: rect };
  };

  const move = (pointerId: number, cell: TileCell) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== pointerId) return;
    const current = stateRef.current;
    const dx = cell.x - gesture.start.x;
    const dy = cell.y - gesture.start.y;
    if (gesture.kind === "marquee") {
      if (!gesture.moved && dx === 0 && dy === 0) return;
      gesture.moved = true;
      const rect = clampTilemapCellRect(latestRef.current, { minX: gesture.start.x, minY: gesture.start.y, maxX: cell.x, maxY: cell.y });
      if (!sameRect(rect, current.rect)) setState({ ...current, rect });
      return;
    }
    if (gesture.kind === "lift") {
      if (!gesture.clip) {
        if (dx === 0 && dy === 0) return;
        gesture.clip = copyTilemapCells(latestRef.current, gesture.rect, gesture.layerId);
      }
      const lift = current.lift;
      if (lift && lift.offset.x === dx && lift.offset.y === dy) return;
      setState({ ...current, lift: { rect: gesture.rect, layerId: gesture.layerId, clip: gesture.clip, offset: { x: dx, y: dy } } });
      return;
    }
    if (!gesture.moved && dx === 0 && dy === 0) return;
    gesture.moved = true;
    const paste = current.paste;
    if (!paste) return;
    const origin = { x: gesture.origin.x + dx, y: gesture.origin.y + dy };
    if (origin.x !== paste.origin.x || origin.y !== paste.origin.y) setState({ ...current, paste: { ...paste, origin } });
  };

  /** The pointer lifted: a drag ends (a move lands in one edit), a tap selects, clears or places. */
  const release = (pointerId: number) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== pointerId) return;
    gestureRef.current = null;
    const current = stateRef.current;
    if (gesture.kind === "marquee") {
      if (gesture.moved) return;
      // A tap outside the selection clears it; with nothing selected, it selects its cell.
      const { x, y } = gesture.start;
      setState({ ...current, rect: gesture.before ? null : clampTilemapCellRect(latestRef.current, { minX: x, minY: y, maxX: x, maxY: y }) });
      return;
    }
    if (gesture.kind === "lift") {
      const lift = current.lift;
      if (!lift) return;
      commit(moveTilemapCells(latestRef.current, lift.rect, lift.layerId, lift.offset, tilesets), "move", gesture.id);
      setState({ rect: clampTilemapCellRect(latestRef.current, offsetTilemapCellRect(lift.rect, lift.offset.x, lift.offset.y)), lift: null, paste: null });
      return;
    }
    if (!gesture.moved) place();
  };

  /** Leave the tool: a paste waiting to be placed lands, a gesture in progress is dropped. */
  const leave = () => {
    cancelGesture();
    place();
  };

  /** Select one cell (a hold or right-click outside the selection), unless a paste is waiting. */
  const selectCell = (cell: TileCell) => {
    const current = stateRef.current;
    if (current.paste || (current.rect && inside(current.rect, cell))) return;
    const rect = clampTilemapCellRect(latestRef.current, { minX: cell.x, minY: cell.y, maxX: cell.x, maxY: cell.y });
    if (rect) setState({ ...current, rect });
  };

  /** **Select All**: the painted cells of the paint layer, or of every layer with All Layers on. */
  const selectAll = () => {
    cancelGesture();
    place();
    setState({ rect: tilemapSelectionExtent(latestRef.current, scope()), lift: null, paste: null });
  };

  /** **Deselect**; a waiting paste is placed first. */
  const deselect = () => {
    cancelGesture();
    place();
    setState(EMPTY);
  };

  /** **Copy**: the selected tiles, or a waiting paste as it is. */
  const copy = () => {
    const { rect, paste } = stateRef.current;
    if (paste) tilemapClipboard.write(paste.clip);
    else if (rect) tilemapClipboard.write(copyTilemapCells(latestRef.current, rect, scope()));
  };

  /** **Cut**: Copy, then the selected tiles are erased in one edit (a waiting paste is dropped instead). */
  const cut = () => {
    const { rect, paste } = stateRef.current;
    if (paste) {
      tilemapClipboard.write(paste.clip);
      setState(EMPTY);
      return;
    }
    if (!rect) return;
    copy();
    commit(eraseTilemapCells(latestRef.current, rect, scope(), tilesets), "cut", newId());
  };

  /** **Delete**: erase the selected tiles in one edit; a waiting paste is dropped. */
  const remove = () => {
    const { rect, paste } = stateRef.current;
    if (paste) setState(EMPTY);
    else if (rect) commit(eraseTilemapCells(latestRef.current, rect, scope(), tilesets), "delete", newId());
  };

  /**
   * **Paste**: the copied tiles float centred on `at` for the user to drag
   * and place; a paste already waiting is placed first. Returns whether
   * anything was pasted.
   */
  const paste = (at: TileCell): boolean => {
    const copied = tilemapClipboard.read();
    if (!copied || !paintLayerId) return false;
    cancelGesture();
    place();
    const target = retargetTilemapClip(copied, latestRef.current, paintLayerId);
    if (target.layers.length === 0) return false;
    const origin = { x: at.x - Math.floor(target.width / 2), y: at.y - Math.floor(target.height / 2) };
    setState({ rect: null, lift: null, paste: { clip: target, origin } });
    return true;
  };

  /**
   * An arrow key: a waiting paste moves by (`dx`, `dy`) cells; otherwise the
   * selected tiles move at once, one edit merged with the presses of the same
   * key-repeat burst.
   */
  const nudge = (dx: number, dy: number, repeat: boolean) => {
    if (gestureRef.current) return;
    const current = stateRef.current;
    if (current.paste) {
      const { origin } = current.paste;
      setState({ ...current, paste: { ...current.paste, origin: { x: origin.x + dx, y: origin.y + dy } } });
      return;
    }
    if (!current.rect) return;
    if (!repeat || !nudgeIdRef.current) nudgeIdRef.current = newId();
    commit(moveTilemapCells(latestRef.current, current.rect, scope(), { x: dx, y: dy }, tilesets), "nudge", nudgeIdRef.current);
    setState({ ...current, rect: clampTilemapCellRect(latestRef.current, offsetTilemapCellRect(current.rect, dx, dy)) });
  };

  /** Escape: drop a gesture, else a waiting paste, else the selection. Returns whether it did anything. */
  const escape = (): boolean => {
    if (gestureRef.current) {
      cancelGesture();
      return true;
    }
    const current = stateRef.current;
    if (!current.paste && !current.rect) return false;
    setState(EMPTY);
    return true;
  };

  /** The floating tiles to draw: a lifted selection from the map's own chunks, or a waiting paste from its clip. */
  const float = useMemo((): TilemapPaintFloat | null => {
    if (state.lift) {
      const { rect, layerId, offset } = state.lift;
      const layers = new Map<string, readonly TilemapChunk[]>();
      for (const layer of tilemap.layers) if (layerId === null || layer.id === layerId) layers.set(layer.id, layer.chunks);
      return { layers, rect, offset, hole: rect, detached: false };
    }
    if (state.paste) {
      const { clip: pasted, origin } = state.paste;
      const layers = new Map(pasted.layers.map((layer) => [layer.layerId, layer.chunks] as const));
      return { layers, rect: { minX: 0, minY: 0, maxX: pasted.width - 1, maxY: pasted.height - 1 }, offset: origin, hole: null, detached: true };
    }
    return null;
  }, [state.lift, state.paste, tilemap.layers]);

  /** The outline: where floating tiles will land, else the selection. */
  const outline = state.lift
    ? offsetTilemapCellRect(state.lift.rect, state.lift.offset.x, state.lift.offset.y)
    : state.paste ? clipRect(state.paste.clip, state.paste.origin) : state.rect;

  /** Tiles the floating block would lose past the map's edge where it is now. */
  const lost = useMemo(() => {
    if (state.lift) {
      const { rect, clip: lifted, offset } = state.lift;
      return tilemapClipLostTiles(tilemap, lifted, { x: rect.minX + offset.x, y: rect.minY + offset.y });
    }
    return state.paste ? tilemapClipLostTiles(tilemap, state.paste.clip, state.paste.origin) : 0;
  }, [state.lift, state.paste, tilemap]);

  return {
    state,
    /** The state as the latest event left it, for handlers that run before the next render. */
    current: () => stateRef.current,
    allLayers,
    setAllLayers,
    float,
    outline,
    lost,
    /** Something is selected or waiting to be placed, so Cut, Copy and Delete act. */
    hasSelection: state.rect !== null || state.paste !== null,
    canPaste: clip !== null && paintLayerId !== null,
    /** Whether a cell is inside the selection or the waiting paste: where a press drags. */
    grabs: (cell: TileCell) => (state.paste ? true : state.rect ? inside(state.rect, cell) : false),
    press,
    move,
    release,
    cancelGesture,
    leave,
    selectCell,
    selectAll,
    deselect,
    copy,
    cut,
    remove,
    paste,
    place,
    cancelPaste,
    nudge,
    escape,
  };
}
