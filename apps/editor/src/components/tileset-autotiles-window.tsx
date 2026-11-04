import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { IDockviewPanelProps } from "dockview-react";
import {
  ChevronRightIcon,
  Grid2x2Icon,
  Grid3x3Icon,
  MinusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  AtlasTileGrid,
  ContextMenuOverlay,
  InlineRenameInput,
  PanelFrame,
  useContextMenu,
  type AtlasTileDrag,
  type AtlasTileGridHandle,
  type AtlasTileMark,
  type ContextMenuItem,
} from "@haptic/editor-kit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { Button } from "@haptic/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@haptic/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import { Kbd } from "@haptic/ui/components/kbd";
import { Toggle } from "@haptic/ui/components/toggle";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import { cn } from "@haptic/ui/lib/utils";
import {
  applyAutotileBlock,
  assignAutotilePiece,
  AUTOTILE_PIECE_GROUPS,
  AUTOTILE_PREVIEW_HEIGHT,
  AUTOTILE_PREVIEW_WIDTH,
  autotileBlockPlacement,
  autotileLayoutChange,
  autotilePieceTiles,
  autotilePreviewSample,
  autotilePreviewTiles,
  autotileReady,
  clearAutotilePiece,
  createTerrainResolver,
  ensureTilesetTiles,
  normalizeTilesetPayload,
  setTilesetTerrains,
  terrainFillMask,
  terrainVariantMasks,
  TERRAIN_E,
  TERRAIN_N,
  TERRAIN_NE,
  TERRAIN_NW,
  TERRAIN_S,
  TERRAIN_SE,
  TERRAIN_SW,
  TERRAIN_W,
  tilePlaceholderHsl,
  tilesetTileRect,
  type AutotilePieceGroup,
  type AutotilePieceSet,
  type AutotilePreviewTile,
  type TilesetPayload,
  type TilesetTerrain,
  type TilesetTerrainStyle,
} from "@haptic/assets";
import { useDocumentActions, useOpenDocument } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalTilesetEditing } from "../context/tileset-editing-context";
import { autotilePieceName } from "../lib/autotile-piece-name";
import { useCoarsePointer } from "../shell/use-platform-layout";
import { IconActionButton } from "./icon-action-button";
import { useTexturePreview } from "./texture-preview-status";

const STYLE_NAMES: Record<TilesetTerrainStyle, string> = { sides: "4 Sides", blob: "Blob" };

const PREVIEW_SIZE = { width: AUTOTILE_PREVIEW_WIDTH, height: AUTOTILE_PREVIEW_HEIGHT };

/** Preview cells are at most 28px and shrink with a narrow column, down to 16px (then the map scrolls sideways). */
const PREVIEW_CELL = 28;
/** The preview frame at full cell size: the cells, its 10px padding and 1px border on both sides. */
const PREVIEW_FRAME_WIDTH = PREVIEW_SIZE.width * PREVIEW_CELL + 22;

/** Checkerboard behind transparent tile art. */
const CHECKERBOARD = {
  backgroundImage: "conic-gradient(var(--muted) 0.25turn, var(--background) 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, var(--background) 0.75turn)",
  backgroundSize: "14px 14px",
};

/** The selected piece's highlight: a soft fill and ring in the selection colour (preview cells and the legend swatch). */
const PICKED = "bg-(--graph-state-selected)/15 shadow-[inset_0_0_0_2px_var(--graph-state-selected)]";

/**
 * One atlas cell over a checkerboard, scaled to whatever size `className`
 * gives it. Without an image it is the flat colour the tile paints with.
 */
export function TileSwatch({
  tileset,
  tileId,
  imageUrl,
  className = "size-10",
  testId = "tileset-selected-swatch",
}: {
  tileset: TilesetPayload;
  tileId: number;
  imageUrl: string | null;
  className?: string;
  testId?: string;
}) {
  const rect = tilesetTileRect(tileset, tileId);
  // Percent sizes keep the cell framed at any swatch size.
  const percent = (offset: number, cell: number, atlas: number) =>
    atlas > cell ? `${(offset / (atlas - cell)) * 100}%` : "0%";
  const placeholder = !imageUrl && rect ? tilePlaceholderHsl(tileId) : null;
  return (
    <span
      aria-hidden
      data-testid={testId}
      data-tile-id={tileId}
      className={cn("block shrink-0 overflow-hidden rounded-md ring-1 ring-border", className)}
      style={{ ...CHECKERBOARD, backgroundSize: "10px 10px" }}
    >
      {imageUrl && rect ? (
        <span
          className="block size-full"
          style={{
            backgroundImage: `url(${imageUrl})`,
            backgroundRepeat: "no-repeat",
            backgroundSize: `${(tileset.atlasWidth / rect.width) * 100}% ${(tileset.atlasHeight / rect.height) * 100}%`,
            backgroundPosition: `${percent(rect.x, rect.width, tileset.atlasWidth)} ${percent(rect.y, rect.height, tileset.atlasHeight)}`,
            imageRendering: "pixelated",
          }}
        />
      ) : placeholder ? (
        <span
          className="block size-full"
          style={{ backgroundColor: `hsl(${placeholder.h} ${placeholder.s}% ${placeholder.l}%)` }}
        />
      ) : null}
    </span>
  );
}

/**
 * An empty piece's shape: the tile as a centre square, each side it joins
 * extended toward that neighbour, each side it leaves open drawn as an edge,
 * and (Blob) each inner-corner notch drawn as an L.
 */
function PieceSilhouette({ mask, style }: { mask: number; style: TilesetTerrainStyle }) {
  const joins = (bit: number) => (mask & bit) !== 0;
  const fill = "fill-foreground/12";
  const shapes: ReactNode[] = [<rect key="c" x={11} y={11} width={22} height={22} className="fill-foreground/30" />];
  const rect = (key: string, x: number, y: number) => shapes.push(<rect key={key} x={x} y={y} width={x === 11 ? 22 : 10} height={y === 11 ? 22 : 10} className={fill} />);
  if (joins(TERRAIN_N)) rect("n", 11, 1);
  if (joins(TERRAIN_S)) rect("s", 11, 33);
  if (joins(TERRAIN_W)) rect("w", 1, 11);
  if (joins(TERRAIN_E)) rect("e", 33, 11);
  const corners: ReadonlyArray<readonly [string, number, number, number, number, number]> = [
    ["ne", TERRAIN_NE, TERRAIN_N, TERRAIN_E, 33, 1],
    ["se", TERRAIN_SE, TERRAIN_S, TERRAIN_E, 33, 33],
    ["sw", TERRAIN_SW, TERRAIN_S, TERRAIN_W, 1, 33],
    ["nw", TERRAIN_NW, TERRAIN_N, TERRAIN_W, 1, 1],
  ];
  const lines: Array<readonly [number, number, number, number]> = [];
  for (const [key, corner, side, other, x, y] of corners) {
    if (!joins(side) || !joins(other)) continue;
    if (style === "sides" || joins(corner)) {
      shapes.push(<rect key={key} x={x} y={y} width={10} height={10} className={fill} />);
    } else {
      // The notch: the L where the corner's two sides meet the open corner.
      const cx = x === 1 ? 11 : 33;
      const cy = y === 1 ? 11 : 33;
      lines.push([cx, y === 1 ? 1 : 43, cx, cy], [cx, cy, x === 1 ? 1 : 43, cy]);
    }
  }
  if (!joins(TERRAIN_N)) lines.push([11, 11, 33, 11]);
  if (!joins(TERRAIN_S)) lines.push([11, 33, 33, 33]);
  if (!joins(TERRAIN_W)) lines.push([11, 11, 11, 33]);
  if (!joins(TERRAIN_E)) lines.push([33, 11, 33, 33]);
  return (
    <svg viewBox="0 0 44 44" aria-hidden className="size-10" data-silhouette={mask}>
      {shapes}
      {lines.map(([x1, y1, x2, y2], at) => (
        <line key={at} x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-foreground/75" strokeWidth={2.5} strokeLinecap="round" />
      ))}
    </svg>
  );
}

export function TilesetAutotilesPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="tileset-autotiles-panel">
      <TilesetAutotiles
        payload={payload}
        onChange={(next, mergeKey) => {
          void applyAssetDocumentChange(documentId, next, mergeKey);
        }}
      />
    </PanelFrame>
  );
}

/** Identity of one piece set: the autotile and its border (empty for the default set). */
function pieceSetKey(set: AutotilePieceSet): string {
  return `${set.terrainId}\u0000${set.border ?? ""}`;
}

function pieceSetOf(terrainId: string, border: string | undefined): AutotilePieceSet {
  return border === undefined ? { terrainId } : { terrainId, border };
}

/** `base`, or `base N` with the lowest N no other autotile uses. */
function uniqueAutotileName(base: string, terrains: readonly TilesetTerrain[], except?: string): string {
  const names = new Set(terrains.flatMap((terrain) => (terrain.id === except ? [] : [terrain.name])));
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

/** The first piece in `order` without a tile, starting after `after` and wrapping; `after` itself when every piece has one. */
function nextEmptyPiece(order: readonly number[], pieces: ReadonlyMap<number, number[]>, after: number): number {
  const start = order.indexOf(after);
  for (let step = 1; step <= order.length; step++) {
    const mask = order[(start + step) % order.length]!;
    if (!(pieces.get(mask)?.length)) return mask;
  }
  return after;
}

const groupOfMask = (style: TilesetTerrainStyle, mask: number) =>
  AUTOTILE_PIECE_GROUPS[style].find((group) => group.masks.includes(mask)) ?? null;

function layoutChangeMessage(tileset: TilesetPayload, set: AutotilePieceSet, style: TilesetTerrainStyle): string {
  const change = autotileLayoutChange(tileset, set, style);
  const total = terrainVariantMasks(style).length;
  const pieces = change.missing === 0
    ? `all ${total} pieces have a tile`
    : `${change.kept} of ${total} pieces have a tile and ${change.missing} ${change.missing === 1 ? "is" : "are"} missing`;
  const unused = change.unusedTileIds.length;
  const unusedText = unused > 0
    ? ` ${unused} ${unused === 1 ? "tile becomes" : "tiles become"} unused, because another tile already draws ${unused === 1 ? "its piece" : "their pieces"}.`
    : "";
  return `Pieces keep their tiles. As ${STYLE_NAMES[style]}, ${pieces}.${unusedText}`;
}

/** A tile in progress of being dragged from the sheet onto a piece (mouse only). */
interface SheetDrag {
  tileId: number;
  /** The piece under the pointer, if any. */
  over: number | null;
}

/**
 * The Autotiles window: the Tileset's autotiles and their border sets in a
 * list, the selected set's pieces with a live preview map, and the sheet. Tap
 * a piece, then its tile on the sheet; tap preview cells to try shapes.
 */
export function TilesetAutotiles({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  /** Every edit is one undo step; `mergeKey` names it. */
  onChange: (next: Record<string, unknown>, mergeKey: string) => void;
}) {
  const tileset = useMemo(() => ensureTilesetTiles(normalizeTilesetPayload(payload)), [payload]);
  const terrains = useMemo(() => tileset.terrains ?? [], [tileset]);
  const terrainName = (id: string) => terrains.find((terrain) => terrain.id === id)?.name ?? id;
  const editing = useOptionalTilesetEditing();
  const [localAutotileId, setLocalAutotileId] = useState<string | null>(null);
  const selectedAutotileId = editing ? editing.selectedAutotileId : localAutotileId;
  const setSelectedAutotileId = editing?.setSelectedAutotileId ?? setLocalAutotileId;
  const autotile = terrains.find((terrain) => terrain.id === selectedAutotileId) ?? terrains[0] ?? null;
  const style = autotile?.style ?? "sides";
  // The set being edited: the autotile's default set, or one of its border sets.
  const [borderChoice, setBorderChoice] = useState<{ autotileId: string; border: string } | null>(null);
  const border = autotile && borderChoice?.autotileId === autotile.id && (autotile.borders ?? []).includes(borderChoice.border)
    ? borderChoice.border
    : undefined;
  const autotileId = autotile?.id ?? null;
  const set = useMemo(() => (autotileId === null ? null : pieceSetOf(autotileId, border)), [autotileId, border]);
  const setKey = set ? pieceSetKey(set) : "";
  /** The set's part of a merge key. */
  const setMergeKey = border ?? "default";
  const preview = useTexturePreview(tileset.textureGuid);
  const imageUrl = preview.url ?? null;
  const coarse = useCoarsePointer();
  const verb = coarse ? "Tap" : "Click";
  const rootRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<AtlasTileGridHandle>(null);

  const groups = AUTOTILE_PIECE_GROUPS[style];
  const [moreOpen, setMoreOpen] = useState(false);
  const visibleMasks = useMemo(
    () => groups.filter((group) => !group.optional || moreOpen).flatMap((group) => group.masks),
    [groups, moreOpen],
  );
  const pieces = useMemo(() => (set ? autotilePieceTiles(tileset, set) : new Map<number, number[]>()), [set, tileset]);
  const resolver = useMemo(() => (autotileId === null ? null : createTerrainResolver(tileset, autotileId)), [autotileId, tileset]);

  // Block mode: the next sheet tap assigns the group's block from that tile.
  const [block, setBlock] = useState<{ setKey: string; groupId: AutotilePieceGroup["id"] } | null>(null);
  const blockGroup = block?.setKey === setKey ? groups.find((group) => group.id === block.groupId) ?? null : null;
  const [blockAnchor, setBlockAnchor] = useState(0);

  // The selected piece belongs to one set; another set starts on its first empty visible piece.
  const [slotChoice, setSlotChoice] = useState<{ setKey: string; mask: number } | null>(null);
  const defaultMask = visibleMasks.find((mask) => !(pieces.get(mask)?.length)) ?? visibleMasks[0] ?? null;
  const selectedMask = autotile
    ? slotChoice?.setKey === setKey && groupOfMask(style, slotChoice.mask) ? slotChoice.mask : defaultMask
    : null;
  const selectPiece = (mask: number) => {
    if (!autotile) return;
    setSlotChoice({ setKey, mask });
    setBlock(null);
  };

  // Preview maps: per set, the user's edits over its starting shapes; never saved.
  const [previewEdits, setPreviewEdits] = useState<ReadonlyMap<string, ReadonlyMap<string, string>>>(() => new Map());
  const sampleCells = useMemo(
    () => new Map(set ? autotilePreviewSample(style, set).map((cell) => [`${cell.x},${cell.y}`, cell.terrainId] as const) : []),
    [set, style],
  );
  const previewCells = previewEdits.get(setKey) ?? sampleCells;
  const previewTiles = useMemo(
    () => (set
      ? autotilePreviewTiles(tileset, set, [...previewCells].map(([key, terrainId]) => {
          const [x, y] = key.split(",").map(Number);
          return { x: x!, y: y!, terrainId };
        }), PREVIEW_SIZE)
      : new Map<string, AutotilePreviewTile>()),
    [previewCells, set, tileset],
  );
  /** Whether a preview cell wants `mask` of the edited set. */
  const wantsSelected = (tile: AutotilePreviewTile | undefined) =>
    Boolean(set && tile && selectedMask !== null && tile.terrainId === set.terrainId && tile.border === set.border && tile.want === selectedMask);
  const pickedCount = [...previewTiles.values()].filter(wantsSelected).length;
  const ownCells = [...previewTiles.values()].filter((tile) => tile.terrainId === autotileId);
  const standIns = ownCells.filter((tile) => tile.standIn).length;
  const noTile = ownCells.some((tile) => tile.tileId === 0);
  // The piece of the edited set under a hovering mouse in the preview, outlined on the board.
  const [hoverCell, setHoverCell] = useState<string | null>(null);
  const hoverTile = hoverCell !== null ? previewTiles.get(hoverCell) : undefined;
  const hoverMask = set && hoverTile && hoverTile.terrainId === set.terrainId && hoverTile.border === set.border ? hoverTile.want : null;

  // Mouse hover only: a touch never reveals or hides anything, so every first tap acts.
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [drag, setDrag] = useState<SheetDrag | null>(null);
  // The pressed tile and the pointer while dragging; the ghost follows the pointer without re-rendering the window.
  const dragTileRef = useRef<number | null>(null);
  const dragPointRef = useRef({ x: 0, y: 0 });
  const ghostRef = useRef<HTMLDivElement | null>(null);

  const [layoutTarget, setLayoutTarget] = useState<TilesetTerrainStyle | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [removeBorderTarget, setRemoveBorderTarget] = useState<AutotilePieceSet | null>(null);

  const commit = (next: TilesetPayload, mergeKey: string): boolean => {
    if (next === tileset) return false;
    onChange(ensureTilesetTiles(next) as unknown as Record<string, unknown>, mergeKey);
    return true;
  };

  /**
   * Replace the autotile list. Tiles of a removed autotile or border, and
   * other autotiles' borders into a removed autotile, go in the same edit.
   */
  const commitTerrains = (next: TilesetTerrain[], mergeKey: string) => {
    commit(setTilesetTerrains(tileset, next), mergeKey);
  };

  const patchTerrain = (id: string, patch: Partial<TilesetTerrain>, mergeKey: string) => {
    commitTerrains(terrains.map((terrain) => (terrain.id === id ? { ...terrain, ...patch } : terrain)), mergeKey);
  };

  /** Edit `set` (a row of the list): its first empty visible piece is selected. */
  const selectSet = (next: AutotilePieceSet) => {
    setSelectedAutotileId(next.terrainId);
    setBorderChoice(next.border === undefined ? null : { autotileId: next.terrainId, border: next.border });
    setSlotChoice(null);
    setBlock(null);
  };

  const createAutotile = () => {
    const ids = new Set(terrains.map((terrain) => terrain.id));
    let index = terrains.length + 1;
    while (ids.has(`terrain-${index}`)) index += 1;
    const id = `terrain-${index}`;
    commitTerrains([...terrains, { id, name: uniqueAutotileName("Autotile", terrains), style: "blob" }], `tileset:autotile:${id}:create`);
    selectSet({ terrainId: id });
    setRenamingId(id);
  };

  const renameAutotile = (id: string, name: string | null) => {
    setRenamingId(null);
    const terrain = terrains.find((entry) => entry.id === id);
    // A name another autotile has takes the next free number.
    const unique = name === null ? null : uniqueAutotileName(name, terrains, id);
    if (!terrain || unique === null || unique === terrain.name) return;
    patchTerrain(id, { name: unique }, `tileset:autotile:${id}:name`);
  };

  const changeLayout = (nextStyle: TilesetTerrainStyle) => {
    if (!autotile || nextStyle === autotile.style) return;
    patchTerrain(autotile.id, { style: nextStyle }, `tileset:autotile:${autotile.id}:layout:${nextStyle}`);
    setSlotChoice(null);
    setBlock(null);
    setPreviewEdits((current) => {
      const next = new Map(current);
      next.delete(pieceSetKey({ terrainId: autotile.id }));
      return next;
    });
  };
  const requestLayout = (nextStyle: TilesetTerrainStyle) => {
    if (!autotile || nextStyle === autotile.style) return;
    if (tileset.tiles.some((tile) => tile.terrain?.id === autotile.id)) setLayoutTarget(nextStyle);
    else changeLayout(nextStyle);
  };

  /** Tiles that leave autotiles when `id` is deleted: its own, and other autotiles' tiles drawn against it. */
  const deletedTileCount = (id: string) =>
    tileset.tiles.filter((tile) => tile.terrain && (tile.terrain.id === id || tile.terrain.border === id)).length;
  const deleteAutotile = (id: string) => {
    const index = terrains.findIndex((terrain) => terrain.id === id);
    const remaining = terrains.filter((terrain) => terrain.id !== id);
    commitTerrains(remaining, `tileset:autotile:${id}:delete`);
    if (autotile?.id === id || border === id) {
      const next = autotile?.id === id ? remaining[Math.min(index, remaining.length - 1)] : autotile;
      if (next) selectSet({ terrainId: next.id });
      else setSelectedAutotileId(null);
    }
  };
  const requestDelete = (id: string) => {
    if (deletedTileCount(id) > 0) setDeleteTarget(id);
    else deleteAutotile(id);
  };

  const addBorder = (terrain: TilesetTerrain, other: string) => {
    const borders = terrain.borders ?? [];
    if (borders.includes(other)) return;
    patchTerrain(terrain.id, { borders: [...borders, other] }, `tileset:autotile:${terrain.id}:border-add:${other}`);
    selectSet({ terrainId: terrain.id, border: other });
  };
  const borderTileCount = (target: AutotilePieceSet) =>
    tileset.tiles.filter((tile) => tile.terrain?.id === target.terrainId && tile.terrain.border === target.border).length;
  const removeBorder = (target: AutotilePieceSet) => {
    const terrain = terrains.find((entry) => entry.id === target.terrainId);
    if (!terrain || target.border === undefined) return;
    patchTerrain(
      terrain.id,
      { borders: (terrain.borders ?? []).filter((entry) => entry !== target.border) },
      `tileset:autotile:${terrain.id}:border-remove:${target.border}`,
    );
    if (autotile?.id === target.terrainId && border === target.border) selectSet({ terrainId: target.terrainId });
  };
  const requestRemoveBorder = (target: AutotilePieceSet) => {
    if (borderTileCount(target) > 0) setRemoveBorderTarget(target);
    else removeBorder(target);
  };

  /** Give `mask` the tile; `advance` moves the selection on to the next empty visible piece. */
  const assign = (mask: number, tileId: number, advance: boolean) => {
    if (!autotile || !set) return;
    const next = assignAutotilePiece(tileset, set, mask, tileId);
    commit(next, `tileset:autotile:${autotile.id}:piece:${setMergeKey}:${mask}:${tileId}`);
    setSlotChoice({ setKey, mask: advance ? nextEmptyPiece(visibleMasks, autotilePieceTiles(next, set), mask) : mask });
  };

  const clearPiece = (mask: number) => {
    if (!autotile || !set) return;
    commit(clearAutotilePiece(tileset, set, mask), `tileset:autotile:${autotile.id}:clear:${setMergeKey}:${mask}`);
    selectPiece(mask);
  };

  const applyBlock = (group: AutotilePieceGroup, anchorTileId: number) => {
    if (!autotile || !set) return;
    commit(
      applyAutotileBlock(tileset, set, group.block, anchorTileId),
      `tileset:autotile:${autotile.id}:block:${setMergeKey}:${group.id}:${anchorTileId}`,
    );
    setBlock(null);
  };

  const onSheetTap = (tileId: number) => {
    if (blockGroup) applyBlock(blockGroup, tileId);
    else if (selectedMask !== null) assign(selectedMask, tileId, true);
  };
  // The sheet keeps one tap handler, so its cells are not rebuilt on every window render.
  const sheetTapRef = useRef(onSheetTap);
  useLayoutEffect(() => {
    sheetTapRef.current = onSheetTap;
  });
  const onStableSheetTap = useCallback((tileId: number) => sheetTapRef.current(tileId), []);

  /** The piece slot under a client point in this window, or `null`. */
  const slotAt = (clientX: number, clientY: number): number | null => {
    const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(clientX, clientY) : null;
    const slot = hit?.closest("[data-slot-mask]");
    return slot && rootRef.current?.contains(slot) ? Number(slot.getAttribute("data-slot-mask")) : null;
  };
  const placeGhost = (ghost: HTMLDivElement | null) => {
    ghostRef.current = ghost;
    if (ghost) ghost.style.transform = `translate(${dragPointRef.current.x + 8}px, ${dragPointRef.current.y + 8}px)`;
  };
  const tileDrag: AtlasTileDrag | undefined = !blockGroup
    ? {
        start: (tileId) => {
          dragTileRef.current = tileId;
          return true;
        },
        move: (clientX, clientY) => {
          const tileId = dragTileRef.current;
          if (tileId === null) return;
          dragPointRef.current = { x: clientX, y: clientY };
          placeGhost(ghostRef.current);
          const over = slotAt(clientX, clientY);
          setDrag((current) => (current?.tileId === tileId && current.over === over ? current : { tileId, over }));
        },
        end: (drop) => {
          const tileId = dragTileRef.current;
          dragTileRef.current = null;
          setDrag(null);
          const over = drop ? slotAt(drop.clientX, drop.clientY) : null;
          if (tileId !== null && over !== null) assign(over, tileId, false);
        },
      }
    : undefined;

  // Sheet marks: the edited set's tiles carry a dot, tiles of other sets are dimmed.
  const sheetMarks = useMemo(() => {
    const marks = new Map<number, AtlasTileMark>();
    for (const ids of pieces.values()) for (const tileId of ids) marks.set(tileId, "dot");
    for (const tile of tileset.tiles) if (tile.terrain && !marks.has(tile.id)) marks.set(tile.id, "dim");
    return marks;
  }, [pieces, tileset]);
  const selectedTileId = selectedMask !== null ? pieces.get(selectedMask)?.[0] ?? null : null;
  // Stable while the highlight is unchanged, so the sheet's cells are not rebuilt on every window render.
  const highlightedTileIds = useMemo(
    () => (blockGroup || selectedTileId === null ? [] : [selectedTileId]),
    [blockGroup, selectedTileId],
  );

  const blockOutline = blockGroup && blockAnchor > 0
    ? <BlockOutline tileset={tileset} group={blockGroup} anchor={blockAnchor} />
    : null;

  const onWindowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && blockGroup) {
      event.stopPropagation();
      setBlock(null);
    }
  };

  const onSlotKeyDown = (event: ReactKeyboardEvent, mask: number) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      clearPiece(mask);
      return;
    }
    const next = neighbourPiece(groups, visibleMasks, mask, event.key);
    if (next === null) return;
    event.preventDefault();
    selectPiece(next);
    rootRef.current?.querySelector<HTMLElement>(`[data-slot-mask="${next}"]`)?.focus();
  };

  const togglePreviewCell = (key: string) => {
    if (!set) return;
    const current = previewCells.get(key);
    const next = new Map(previewCells);
    if (current === set.terrainId) {
      if (set.border !== undefined) next.set(key, set.border);
      else next.delete(key);
    } else {
      next.set(key, set.terrainId);
    }
    setPreviewEdits((edits) => new Map(edits).set(setKey, next));
  };
  // Long-press or right-click a preview cell: select the piece it uses.
  const menuCellRef = useRef<string | null>(null);
  const previewMenu = useContextMenu({
    enabled: set !== null,
    items: (): ContextMenuItem[] => {
      const key = menuCellRef.current;
      const tile = key !== null ? previewTiles.get(key) : undefined;
      const want = tile?.want ?? null;
      return [
        {
          id: "select-piece",
          label: "Select Piece",
          disabled: !tile || want === null,
          onSelect: () => {
            if (!tile || want === null) return;
            const target = pieceSetOf(tile.terrainId, tile.border);
            const targetStyle = terrains.find((terrain) => terrain.id === tile.terrainId)?.style ?? style;
            if (pieceSetKey(target) !== setKey) selectSet(target);
            setSlotChoice({ setKey: pieceSetKey(target), mask: want });
            if (groupOfMask(targetStyle, want)?.optional) setMoreOpen(true);
          },
          testId: "tileset-autotiles-select-piece",
        },
      ];
    },
  });
  const rememberMenuCell = (event: { target: EventTarget | null }) => {
    const cell = event.target instanceof Element ? event.target.closest("[data-cell]") : null;
    menuCellRef.current = cell?.getAttribute("data-cell") ?? null;
  };

  if (!autotile || !set) {
    return (
      <Empty data-testid="tileset-autotiles-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Grid3x3Icon />
          </EmptyMedia>
          <EmptyTitle>No Autotiles</EmptyTitle>
          <EmptyDescription>
            An autotile turns a set of tiles into a brush that picks edges and corners for you as you paint a Tilemap.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" size="touch" onClick={createAutotile} data-testid="tileset-autotiles-empty-new">
            <PlusIcon data-icon="inline-start" />
            New Autotile
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const selectedName = selectedMask !== null ? autotilePieceName(selectedMask, style) : null;
  // Painting's tile for an empty piece: the closest piece of the set, or of the default set while the set is empty.
  const standInTileId = selectedMask !== null && selectedTileId === null && resolver ? resolver.resolve(selectedMask, border) : null;

  return (
    <div
      ref={rootRef}
      className="@container/autotiles h-full min-h-0"
      data-testid="tileset-autotiles"
      onKeyDown={onWindowKeyDown}
    >
      {/*
        Three columns from 42rem, each scrolling by itself, so the pieces, the preview and the sheet are all in view:
        the list, the pieces (one group wide, Blob's Main and Inner Corners stacked), and the sheet over the preview.
        Narrower (a phone) they stack.
      */}
      <div
        className={cn(
          "grid min-h-full grid-cols-1",
          "@2xl/autotiles:h-full @2xl/autotiles:grid-cols-[minmax(9rem,12.5rem)_minmax(15rem,19.5rem)_minmax(15rem,1fr)]",
        )}
      >
        <section
          aria-label="Autotiles"
          className="flex min-w-0 flex-col border-b border-border @2xl/autotiles:min-h-0 @2xl/autotiles:border-r @2xl/autotiles:border-b-0"
          data-testid="tileset-autotiles-list"
        >
          <ColumnHeader title="Autotiles">
            <IconActionButton
              label="New Autotile"
              variant="ghost"
              size="touch-icon"
              onClick={createAutotile}
              data-testid="tileset-autotiles-new"
            >
              <PlusIcon />
            </IconActionButton>
          </ColumnHeader>
          <div className="flex flex-col gap-px p-1.5 @2xl/autotiles:min-h-0 @2xl/autotiles:overflow-y-auto">
            {terrains.map((terrain) => {
              const rowSelected = terrain.id === autotile.id && border === undefined;
              const ready = autotileReady(tileset, terrain.id);
              const readyText = terrain.style === "blob"
                ? ready ? "Every main piece has a tile" : "Some main pieces have no tile"
                : ready ? "Every piece has a tile" : "Some pieces have no tile";
              const others = terrains.filter((other) => other.id !== terrain.id && !(terrain.borders ?? []).includes(other.id));
              const showActions = rowSelected || hoverRow === terrain.id || menuRow === terrain.id;
              return (
                <div key={terrain.id} className="flex flex-col gap-px">
                  <ListRow
                    selected={rowSelected}
                    onMouseHover={(over) => setHoverRow(over ? terrain.id : null)}
                  >
                    {renamingId === terrain.id ? (
                      <div className="flex min-w-0 flex-1 items-center gap-2 pl-2">
                        <AutotileSwatch tileset={tileset} terrain={terrain} imageUrl={imageUrl} />
                        <InlineRenameInput
                          value={terrain.name}
                          aria-label={`Rename ${terrain.name}`}
                          data-testid={`tileset-autotiles-rename-${terrain.id}`}
                          className="h-6 min-w-0 flex-1 text-[13px]"
                          onDone={(name) => renameAutotile(terrain.id, name)}
                        />
                      </div>
                    ) : (
                      <RowButton
                        selected={rowSelected}
                        onClick={() => selectSet({ terrainId: terrain.id })}
                        testId={`tileset-autotiles-row-${terrain.id}`}
                      >
                        <AutotileSwatch tileset={tileset} terrain={terrain} imageUrl={imageUrl} />
                        <span className="min-w-0 flex-1 truncate text-left">{terrain.name}</span>
                        <span
                          role="img"
                          aria-label={readyText}
                          title={readyText}
                          data-testid={`tileset-autotiles-status-${terrain.id}`}
                          data-ready={ready ? "true" : "false"}
                          className={cn("size-[7px] shrink-0 rounded-full", ready ? "bg-(--success)" : "bg-(--warning)")}
                        />
                      </RowButton>
                    )}
                    <DropdownMenu
                      modal={false}
                      onOpenChange={(open) => setMenuRow(open ? terrain.id : null)}
                    >
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="touch-icon"
                            className={cn("shrink-0 text-muted-foreground", !showActions && "invisible")}
                            aria-label={`${terrain.name} Actions`}
                            data-testid={`tileset-autotiles-actions-${terrain.id}`}
                          />
                        }
                      >
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-44">
                        <DropdownMenuGroup>
                          <DropdownMenuItem onClick={() => setRenamingId(terrain.id)} data-testid="tileset-autotiles-rename">
                            Rename
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                        {others.length > 0 ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>Add Next To</DropdownMenuLabel>
                              {others.map((other) => (
                                <DropdownMenuItem
                                  key={other.id}
                                  onClick={() => addBorder(terrain, other.id)}
                                  data-testid={`tileset-autotiles-add-border-${other.id}`}
                                >
                                  <AutotileSwatch tileset={tileset} terrain={other} imageUrl={imageUrl} />
                                  {other.name}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuGroup>
                          </>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => requestDelete(terrain.id)}
                            data-testid="tileset-autotiles-delete"
                          >
                            <Trash2Icon />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </ListRow>
                  {(terrain.borders ?? []).flatMap((otherId) => {
                    const other = terrains.find((entry) => entry.id === otherId);
                    if (!other) return [];
                    const rowKey = `${terrain.id}\u0000${otherId}`;
                    const childSelected = terrain.id === autotile.id && border === otherId;
                    const target = { terrainId: terrain.id, border: otherId };
                    return [
                      <ListRow
                        key={otherId}
                        selected={childSelected}
                        indent
                        onMouseHover={(over) => setHoverRow(over ? rowKey : null)}
                      >
                        <RowButton
                          selected={childSelected}
                          onClick={() => selectSet(target)}
                          testId={`tileset-autotiles-row-${terrain.id}-${otherId}`}
                        >
                          <AutotileSwatch tileset={tileset} terrain={other} imageUrl={imageUrl} />
                          <span className="min-w-0 flex-1 truncate text-left">Next To {other.name}</span>
                        </RowButton>
                        <IconActionButton
                          label={`Remove Next To ${other.name}`}
                          variant="ghost"
                          size="touch-icon"
                          className={cn("shrink-0 text-muted-foreground", !(childSelected || hoverRow === rowKey) && "invisible")}
                          onClick={() => requestRemoveBorder(target)}
                          data-testid={`tileset-autotiles-remove-border-${terrain.id}-${otherId}`}
                        >
                          <XIcon />
                        </IconActionButton>
                      </ListRow>,
                    ];
                  })}
                </div>
              );
            })}
          </div>
        </section>

        <section
          aria-label="Pieces"
          className="flex min-w-0 flex-col border-b border-border @2xl/autotiles:min-h-0 @2xl/autotiles:border-r @2xl/autotiles:border-b-0"
          data-testid="tileset-autotiles-pieces"
        >
          <ColumnHeader
            title={
              <span data-testid="tileset-autotiles-pieces-title">
                {autotile.name}
                {border !== undefined ? <span className="font-medium text-muted-foreground"> · Next To {terrainName(border)}</span> : null}
              </span>
            }
          >
            {border === undefined ? (
              <>
                <span className="text-xs text-muted-foreground" id="tileset-autotiles-layout-label">Layout</span>
                <ToggleGroup
                  variant="outline"
                  size="touch"
                  spacing={0}
                  value={[style]}
                  onValueChange={(value) => {
                    const next = value[0] as TilesetTerrainStyle | undefined;
                    if (next) requestLayout(next);
                  }}
                  aria-labelledby="tileset-autotiles-layout-label"
                >
                  <ToggleGroupItem value="sides" className="text-xs" data-testid="tileset-autotiles-layout-sides">
                    4 Sides
                  </ToggleGroupItem>
                  <ToggleGroupItem value="blob" className="text-xs" data-testid="tileset-autotiles-layout-blob">
                    Blob
                  </ToggleGroupItem>
                </ToggleGroup>
              </>
            ) : null}
          </ColumnHeader>
          <div className="flex flex-col gap-3.5 p-3 @2xl/autotiles:min-h-0 @2xl/autotiles:flex-1 @2xl/autotiles:overflow-y-auto">
            {selectedMask !== null && selectedName !== null ? (
              <div
                className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted px-2.5 py-1 text-xs"
                data-testid="tileset-autotiles-selected-piece"
              >
                <strong className="font-semibold" data-testid="tileset-autotiles-selected-name">{selectedName}</strong>
                <span className="text-muted-foreground" data-testid="tileset-autotiles-selected-tile">
                  {selectedTileId !== null
                    ? `Tile ${selectedTileId}`
                    : standInTileId !== null
                      ? `No tile · painting uses Tile ${standInTileId} instead`
                      : "No tile"}
                </span>
                <span className="flex-1" />
                <span className="inline-flex items-center gap-1.5 text-muted-foreground" data-testid="tileset-autotiles-selected-where">
                  {pickedCount > 0 ? (
                    <>
                      <span aria-hidden className={cn("size-2.5 rounded-[2px]", PICKED)} />
                      {pickedCount === 1 ? "1 cell in the preview" : `${pickedCount} cells in the preview`}
                    </>
                  ) : "Not in the preview"}
                </span>
                {selectedTileId !== null ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    className="text-xs"
                    onClick={() => clearPiece(selectedMask)}
                    data-testid="tileset-autotiles-selected-clear"
                  >
                    <XIcon data-icon="inline-start" />
                    Clear
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
              {groups.map((group) => {
                const open = !group.optional || moreOpen;
                const done = group.masks.filter((mask) => pieces.get(mask)?.length).length;
                return (
                  <section
                    key={group.id}
                    aria-label={group.title}
                    className={cn("flex min-w-0 flex-col gap-1.5", group.optional && "basis-full")}
                    data-testid={`tileset-autotiles-group-${group.id}`}
                  >
                    <div className="flex min-h-7 items-center gap-2">
                      {group.optional ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="touch"
                          className="-ml-1.5 gap-1 px-1.5 text-xs font-semibold"
                          aria-expanded={moreOpen}
                          onClick={() => setMoreOpen((current) => !current)}
                          data-testid="tileset-autotiles-more-toggle"
                        >
                          <ChevronRightIcon
                            data-icon="inline-start"
                            className={cn("size-3 transition-transform motion-reduce:transition-none", moreOpen && "rotate-90")}
                          />
                          {group.title}
                        </Button>
                      ) : (
                        <h3 className="text-xs font-semibold">{group.title}</h3>
                      )}
                      <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums" data-testid={`tileset-autotiles-group-${group.id}-count`}>
                        {done} of {group.masks.length}
                        {group.optional ? " · Optional" : ""}
                      </span>
                      <span className="flex-1" />
                      <BlockToggle
                        group={group}
                        pressed={blockGroup?.id === group.id}
                        onPressedChange={(pressed) => {
                          setBlock(pressed ? { setKey, groupId: group.id } : null);
                          setBlockAnchor(0);
                        }}
                      />
                    </div>
                    {open ? (
                      <div
                        role="group"
                        aria-label={`${group.title} Pieces`}
                        className={cn("gap-1", group.optional ? "flex flex-wrap" : "grid w-max")}
                        style={group.optional ? undefined : { gridTemplateColumns: `repeat(${group.columns}, 50px)` }}
                      >
                        {group.masks.map((mask) => {
                          const tileId = pieces.get(mask)?.[0] ?? null;
                          const name = autotilePieceName(mask, style);
                          const selected = selectedMask === mask;
                          return (
                            <PieceSlot
                              key={mask}
                              mask={mask}
                              name={name}
                              style={style}
                              tileId={tileId}
                              tileset={tileset}
                              imageUrl={imageUrl}
                              selected={selected}
                              previewHover={hoverMask === mask}
                              dropTarget={drag?.over === mask}
                              showClear={tileId !== null && (selected || hoverSlot === mask)}
                              onSelect={() => selectPiece(mask)}
                              onClear={() => clearPiece(mask)}
                              onKeyDown={(event) => onSlotKeyDown(event, mask)}
                              onMouseHover={(over) => setHoverSlot(over ? mask : null)}
                            />
                          );
                        })}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          </div>
        </section>

        {/* The sheet with the preview pinned below it, so a tile given to a piece shows in the preview at once. */}
        <div className="flex min-w-0 flex-col @2xl/autotiles:min-h-0 @2xl/autotiles:overflow-y-auto">
          <section
            aria-label="Sheet"
            className="flex h-[24rem] min-h-0 min-w-0 flex-col @2xl/autotiles:h-auto @2xl/autotiles:min-h-48 @2xl/autotiles:flex-1"
          >
            <ColumnHeader title="Sheet">
              <IconActionButton
                label="Zoom Out"
                variant="ghost"
                size="touch-icon"
                onClick={() => sheetRef.current?.zoomBy(1 / 1.25)}
                data-testid="tileset-autotiles-zoom-out"
              >
                <MinusIcon />
              </IconActionButton>
              <IconActionButton
                label="Zoom In"
                variant="ghost"
                size="touch-icon"
                onClick={() => sheetRef.current?.zoomBy(1.25)}
                data-testid="tileset-autotiles-zoom-in"
              >
                <PlusIcon />
              </IconActionButton>
            </ColumnHeader>
            <div
              className="flex min-h-[30px] shrink-0 items-center gap-2 border-b border-border px-2.5 py-1 text-xs text-muted-foreground"
              data-testid="tileset-autotiles-sheet-hint"
            >
              {blockGroup ? (
                <>
                  <span>{verb} the top-left tile of a {blockGroup.block.columns} × {blockGroup.block.rows} block.</span>
                  <span className="flex-1" />
                  {coarse ? null : <Kbd>Esc</Kbd>}
                </>
              ) : selectedName !== null ? (
                <span>
                  {verb} a tile for <strong className="font-semibold text-foreground">{selectedName}</strong>
                  {coarse ? "." : ", or drag one onto any piece."}
                </span>
              ) : null}
            </div>
            <AtlasTileGrid
              ref={sheetRef}
              tileset={tileset}
              imageUrl={imageUrl}
              selectedId={0}
              selectedIds={highlightedTileIds}
              onSelect={onStableSheetTap}
              panZoom
              tool="move"
              cellMarks={sheetMarks}
              overlay={blockOutline}
              tileDrag={tileDrag}
              onTileHover={blockGroup ? setBlockAnchor : undefined}
              emptyLabel={
                preview.status === "missing"
                  ? "Missing Texture"
                  : preview.status === "loading"
                    ? "Loading Texture…"
                    : preview.status === "failed"
                      ? "Texture Unavailable"
                      : "No Texture"
              }
              emptyDescription={
                preview.status === "loading"
                  ? undefined
                  : preview.status === "failed"
                    ? preview.error
                    : "Pick the sheet's Texture in the Inspector."
              }
              data-testid="tileset-autotiles-sheet"
            />
          </section>

            <section aria-label="Preview" className="flex shrink-0 flex-col gap-2 border-t border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-xs font-semibold">Preview</h3>
                <span
                  role="status"
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                  data-testid="tileset-autotiles-preview-status"
                >
                  <span aria-hidden className={cn("size-[7px] rounded-full", standIns > 0 ? "bg-(--warning)" : "bg-(--success)")} />
                  {standIns === 0
                    ? "Every cell has its piece"
                    : noTile
                      ? `${standIns} ${standIns === 1 ? "cell has" : "cells have"} no tile yet`
                      : `${standIns} ${standIns === 1 ? "cell uses" : "cells use"} a nearby piece`}
                </span>
              </div>
              <div
                className="w-full self-start overflow-x-auto rounded-md border border-border p-2.5"
                style={{ ...CHECKERBOARD, maxWidth: PREVIEW_FRAME_WIDTH }}
              >
                <div
                  role="group"
                  aria-label="Preview Map"
                  className="grid touch-manipulation select-none"
                  style={{ gridTemplateColumns: `repeat(${PREVIEW_SIZE.width}, minmax(1rem, 1fr))` }}
                  data-testid="tileset-autotiles-preview-map"
                  onClick={(event) => {
                    const cell = event.target instanceof Element ? event.target.closest("[data-cell]") : null;
                    const key = cell?.getAttribute("data-cell");
                    if (key) togglePreviewCell(key);
                  }}
                  onPointerOver={(event: ReactPointerEvent) => {
                    if (event.pointerType !== "mouse") return;
                    const cell = event.target instanceof Element ? event.target.closest("[data-cell]") : null;
                    setHoverCell(cell?.getAttribute("data-cell") ?? null);
                  }}
                  onPointerLeave={(event) => {
                    if (event.pointerType === "mouse") setHoverCell(null);
                  }}
                  onPointerDownCapture={rememberMenuCell}
                  onContextMenuCapture={rememberMenuCell}
                  {...previewMenu.bind}
                >
                  {Array.from({ length: PREVIEW_SIZE.height }, (_, row) => PREVIEW_SIZE.height - 1 - row).flatMap((y) =>
                    Array.from({ length: PREVIEW_SIZE.width }, (_, x) => {
                      const key = `${x},${y}`;
                      const tile = previewTiles.get(key);
                      const own = tile?.terrainId === autotile.id;
                      const picked = wantsSelected(tile);
                      return (
                        <span
                          key={key}
                          data-cell={key}
                          data-testid={`tileset-autotiles-preview-cell-${x}-${y}`}
                          data-terrain={tile?.terrainId}
                          data-tile-id={tile?.tileId ?? 0}
                          data-border={tile?.border}
                          data-stand-in={own && tile.standIn ? "true" : undefined}
                          data-picked={picked ? "true" : undefined}
                          className="group/cell relative aspect-square cursor-crosshair"
                        >
                          {tile && tile.tileId > 0 ? (
                            <TileSwatch
                              tileset={tileset}
                              tileId={tile.tileId}
                              imageUrl={imageUrl}
                              testId={`tileset-autotiles-preview-cell-${x}-${y}-tile`}
                              className="absolute inset-0 size-full rounded-none ring-0"
                            />
                          ) : tile ? (
                            <span aria-hidden className="absolute inset-0 bg-muted-foreground/25" />
                          ) : null}
                          {picked ? <span aria-hidden className={cn("pointer-events-none absolute inset-0 z-[1]", PICKED)} /> : null}
                          {/* Always present: a hovering mouse only draws its neutral ring, so nothing appears or moves for a touch. */}
                          <span aria-hidden className="pointer-events-none absolute inset-0 z-[3] group-hover/cell:shadow-[inset_0_0_0_2px_var(--foreground)]" />
                          {own && tile.standIn ? (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute top-[3px] right-[3px] z-[2] size-1.5 rounded-full bg-(--warning) shadow-[0_0_0_1.5px_var(--background)]"
                            />
                          ) : null}
                        </span>
                      );
                    }),
                  )}
                </div>
              </div>
              <ContextMenuOverlay menu={previewMenu.menu} onClose={previewMenu.closeMenu} />
            </section>
        </div>
      </div>

      {drag
        ? createPortal(
            <div
              ref={placeGhost}
              aria-hidden
              className="pointer-events-none fixed top-0 left-0 z-50 rounded-sm shadow-lg"
              data-testid="tileset-autotiles-drag-ghost"
            >
              <TileSwatch tileset={tileset} tileId={drag.tileId} imageUrl={imageUrl} className="size-10" testId="tileset-autotiles-drag-tile" />
            </div>,
            document.body,
          )
        : null}

      {layoutTarget ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) setLayoutTarget(null); }}>
          <AlertDialogContent data-testid="tileset-autotiles-layout-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Change Layout to {STYLE_NAMES[layoutTarget]}</AlertDialogTitle>
              <AlertDialogDescription>
                {layoutChangeMessage(tileset, { terrainId: autotile.id }, layoutTarget)}
                {(autotile.borders ?? []).length > 0 ? " Its borders keep their tiles too." : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
              <AlertDialogAction
                size="sm"
                onClick={() => {
                  changeLayout(layoutTarget);
                  setLayoutTarget(null);
                }}
                data-testid="tileset-autotiles-layout-confirm"
              >
                Change Layout
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {deleteTarget ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
          <AlertDialogContent data-testid="tileset-autotiles-delete-dialog">
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-destructive/10 text-destructive">
                <Trash2Icon />
              </AlertDialogMedia>
              <AlertDialogTitle>Delete {terrainName(deleteTarget)}</AlertDialogTitle>
              <AlertDialogDescription>
                {deletedTileCount(deleteTarget) === 1 ? "1 tile leaves" : `${deletedTileCount(deleteTarget)} tiles leave`} the
                autotile and other autotiles&apos; pieces next to it; Tilemaps keep the tiles already painted. You can undo this.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
              <AlertDialogAction
                size="sm"
                variant="destructive"
                onClick={() => {
                  deleteAutotile(deleteTarget);
                  setDeleteTarget(null);
                }}
                data-testid="tileset-autotiles-delete-confirm"
              >
                Delete Autotile
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {removeBorderTarget?.border !== undefined ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) setRemoveBorderTarget(null); }}>
          <AlertDialogContent data-testid="tileset-autotiles-remove-border-dialog">
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-destructive/10 text-destructive">
                <Trash2Icon />
              </AlertDialogMedia>
              <AlertDialogTitle>
                Remove {terrainName(removeBorderTarget.terrainId)} Next To {terrainName(removeBorderTarget.border)}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {borderTileCount(removeBorderTarget) === 1 ? "Its 1 tile leaves" : `Its ${borderTileCount(removeBorderTarget)} tiles leave`}{" "}
                {terrainName(removeBorderTarget.terrainId)}. You can undo this.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
              <AlertDialogAction
                size="sm"
                variant="destructive"
                onClick={() => {
                  removeBorder(removeBorderTarget);
                  setRemoveBorderTarget(null);
                }}
                data-testid="tileset-autotiles-remove-border-confirm"
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

/** The slot an Arrow key moves to: Left and Right step through the visible pieces, Up and Down move by a row of the slot's group. */
function neighbourPiece(groups: readonly AutotilePieceGroup[], visible: readonly number[], mask: number, key: string): number | null {
  const at = visible.indexOf(mask);
  if (at < 0) return null;
  if (key === "ArrowLeft") return visible[at - 1] ?? null;
  if (key === "ArrowRight") return visible[at + 1] ?? null;
  if (key !== "ArrowUp" && key !== "ArrowDown") return null;
  const group = groups.find((entry) => entry.masks.includes(mask));
  if (!group) return null;
  const index = group.masks.indexOf(mask) + (key === "ArrowDown" ? group.columns : -group.columns);
  return group.masks[index] ?? null;
}

function ColumnHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex min-h-10 shrink-0 items-center gap-1.5 border-b border-border bg-panel-header px-2.5 py-1">
      <h2 className="min-w-0 flex-1 truncate text-xs font-semibold">{title}</h2>
      {children}
    </header>
  );
}

/** A list row: the accent background when selected, a faint one under a hovering mouse; `onMouseHover` reports a mouse entering or leaving. */
function ListRow({
  selected,
  indent = false,
  onMouseHover,
  children,
}: {
  selected: boolean;
  indent?: boolean;
  onMouseHover: (over: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-7 items-center gap-0.5 rounded-md pr-0.5 pointer-coarse:h-11",
        indent && "pl-4",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      data-selected={selected ? "true" : "false"}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") onMouseHover(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") onMouseHover(false);
      }}
    >
      {children}
    </div>
  );
}

function RowButton({
  selected,
  onClick,
  testId,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-current={selected ? "true" : undefined}
      className={cn(
        "h-full min-w-0 flex-1 justify-start gap-2 rounded-md px-2 text-[13px] hover:bg-transparent",
        selected ? "font-medium" : "font-normal",
      )}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
    </Button>
  );
}

/** An autotile's swatch: its fill piece's tile, or an empty square while it has none. */
function AutotileSwatch({ tileset, terrain, imageUrl }: { tileset: TilesetPayload; terrain: TilesetTerrain; imageUrl: string | null }) {
  const fill = useMemo(() => createTerrainResolver(tileset, terrain.id)?.resolve(terrainFillMask(terrain.style)) ?? null, [terrain.id, terrain.style, tileset]);
  return fill !== null
    ? <TileSwatch tileset={tileset} tileId={fill} imageUrl={imageUrl} className="size-[18px] rounded-[4px] ring-0" testId={`tileset-autotiles-swatch-${terrain.id}`} />
    : <span aria-hidden className="size-[18px] shrink-0 rounded-[4px] bg-muted ring-1 ring-border" />;
}

/** A group's block button: the next sheet tap assigns the group's pieces as the standard block lays them out. */
function BlockToggle({
  group,
  pressed,
  onPressedChange,
}: {
  group: AutotilePieceGroup;
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
}) {
  const label = `Assign ${group.title} From a Block on the Sheet`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            size="sm"
            className="size-7 min-w-7 px-0 text-muted-foreground pointer-coarse:size-11"
            pressed={pressed}
            onPressedChange={onPressedChange}
            aria-label={label}
            data-testid={`tileset-autotiles-block-${group.id}`}
          />
        }
      >
        <Grid2x2Icon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PieceSlot({
  mask,
  name,
  style,
  tileId,
  tileset,
  imageUrl,
  selected,
  previewHover,
  dropTarget,
  showClear,
  onSelect,
  onClear,
  onKeyDown,
  onMouseHover,
}: {
  mask: number;
  name: string;
  style: TilesetTerrainStyle;
  tileId: number | null;
  tileset: TilesetPayload;
  imageUrl: string | null;
  selected: boolean;
  /** A hovered preview cell uses this piece. */
  previewHover: boolean;
  /** A dragged sheet tile is over this piece. */
  dropTarget: boolean;
  /** The corner clear button: on the selected piece, or under a hovering mouse. */
  showClear: boolean;
  onSelect: () => void;
  onClear: () => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
  onMouseHover: (over: boolean) => void;
}) {
  return (
    <div
      className="relative"
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") onMouseHover(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") onMouseHover(false);
      }}
    >
      <Button
        type="button"
        variant="outline"
        tabIndex={selected ? 0 : -1}
        aria-pressed={selected}
        aria-label={`${name}, ${tileId !== null ? `Tile ${tileId}` : "No tile"}`}
        title={name}
        data-slot-mask={mask}
        data-tile-id={tileId ?? undefined}
        data-preview-hover={previewHover ? "true" : undefined}
        data-drop-target={dropTarget ? "true" : undefined}
        data-testid={`tileset-autotiles-slot-${mask}`}
        className={cn(
          "size-[50px] rounded-md bg-muted p-0 hover:border-muted-foreground hover:bg-muted",
          tileId === null && "border-dashed border-input bg-transparent hover:bg-transparent",
          selected && "border-2 border-solid border-(--graph-state-selected) ring-3 ring-(--graph-state-selected)/20 hover:border-(--graph-state-selected)",
          previewHover && !selected && "outline-2 outline-offset-1 outline-(--graph-state-selected) outline-dashed",
          dropTarget && "border-2 border-(--graph-state-selected) bg-(--graph-state-selected)/15",
        )}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        {tileId !== null ? (
          <TileSwatch
            tileset={tileset}
            tileId={tileId}
            imageUrl={imageUrl}
            testId={`tileset-autotiles-slot-${mask}-tile`}
            className="size-10 rounded-[3px] ring-0"
          />
        ) : (
          <PieceSilhouette mask={mask} style={style} />
        )}
      </Button>
      {showClear ? (
        <Button
          type="button"
          variant="outline"
          tabIndex={-1}
          aria-label={`Clear ${name}`}
          title="Clear"
          className="absolute -top-1.5 -right-1.5 z-10 size-[18px] rounded-full border-border bg-popover p-0 text-muted-foreground after:absolute after:-inset-1 after:content-[''] hover:text-foreground pointer-coarse:-top-2 pointer-coarse:-right-2 pointer-coarse:size-6 [&_svg:not([class*='size-'])]:size-2.5"
          onClick={onClear}
          data-testid={`tileset-autotiles-slot-${mask}-clear`}
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}

/** The block a group's button assigns, outlined over the sheet from the hovered tile (in atlas pixels). */
function BlockOutline({ tileset, group, anchor }: { tileset: TilesetPayload; group: AutotilePieceGroup; anchor: number }) {
  const placement = autotileBlockPlacement(tileset, group.block, anchor);
  const first = placement[0] ? tilesetTileRect(tileset, placement[0].tileId) : null;
  const last = placement.length ? tilesetTileRect(tileset, placement.at(-1)!.tileId) : null;
  if (!first || !last) return null;
  const pieces = placement.filter((cell) => cell.mask !== null).length;
  return (
    <div
      aria-hidden
      data-testid="tileset-autotiles-block-outline"
      data-anchor={anchor}
      className="pointer-events-none absolute z-20 rounded-[2px] bg-(--graph-state-selected)/20"
      style={{
        left: first.x,
        top: first.y,
        width: last.x + last.width - first.x,
        height: last.y + last.height - first.y,
        outline: "calc(2px / var(--atlas-zoom, 1)) solid var(--graph-state-selected)",
      }}
    >
      <span
        className="absolute left-0 rounded-sm bg-(--graph-state-selected) font-semibold whitespace-nowrap text-background"
        style={{
          bottom: "100%",
          marginBottom: "calc(4px / var(--atlas-zoom, 1))",
          padding: "calc(2px / var(--atlas-zoom, 1)) calc(6px / var(--atlas-zoom, 1))",
          fontSize: "calc(11px / var(--atlas-zoom, 1))",
        }}
      >
        {group.title} · {pieces === 1 ? "1 piece" : `${pieces} pieces`}
      </span>
    </div>
  );
}
