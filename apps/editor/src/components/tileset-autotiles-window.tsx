import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  BrushIcon,
  ChevronDownIcon,
  EraserIcon,
  Grid3x3Icon,
  LayoutTemplateIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PipetteIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import {
  AtlasTileGrid,
  ContextMenuOverlay,
  NamePromptDialog,
  PanelFrame,
  ToolbarStrip,
  useContextMenu,
  type AtlasTileDrag,
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
import { Field, FieldError, FieldGroup, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { cn } from "@haptic/ui/lib/utils";
import {
  applyAutotileTemplate,
  assignAutotilePiece,
  AUTOTILE_LAYOUTS,
  AUTOTILE_SANDBOX_HEIGHT,
  AUTOTILE_SANDBOX_WIDTH,
  AUTOTILE_TEMPLATES,
  autotileLayoutChange,
  autotilePieceOfTile,
  autotilePieceTiles,
  autotileSandboxSample,
  autotileSandboxTiles,
  autotileTemplateFits,
  autotileTemplatePlacement,
  clearAutotilePiece,
  createTerrainResolver,
  ensureTilesetTiles,
  normalizeTilesetPayload,
  removeTileFromAutotile,
  setTilesetTerrains,
  tilePlaceholderHsl,
  tilesetAtlasColumns,
  tilesetAtlasRows,
  tilesetTileRect,
  terrainVariantMasks,
  TERRAIN_ALL,
  TERRAIN_SIDES,
  type AutotilePieceSet,
  type AutotileTemplate,
  type TilesetPayload,
  type TilesetTerrain,
  type TilesetTerrainStyle,
  type AutotileSandboxTile,
} from "@haptic/assets";
import { useDocumentActions, useOpenDocument } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalTilesetEditing } from "../context/tileset-editing-context";
import { useTexturePreview } from "./texture-preview-status";

/** Compact controls with 44px targets in the touch layout. */
const TOUCH = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const SLOT = "size-8 pointer-coarse:size-11";

const STYLE_NAMES: Record<TilesetTerrainStyle, string> = { sides: "4 Sides", blob: "Blob" };

/** Each glyph cell's neighbour bit (0 is the tile itself) and position, in reading order. */
const GLYPH_CELLS: ReadonlyArray<readonly [number, number, number]> = [
  [128, 0, 0], [1, 1, 0], [2, 2, 0],
  [64, 0, 1], [0, 1, 1], [4, 2, 1],
  [32, 0, 2], [16, 1, 2], [8, 2, 2],
];
const CORNER_BITS = new Set([2, 8, 32, 128]);

const DIRECTIONS: ReadonlyArray<readonly [number, string]> = [
  [1, "North"], [2, "North East"], [4, "East"], [8, "South East"],
  [16, "South"], [32, "South West"], [64, "West"], [128, "North West"],
];

/** A piece's accessible name: the neighbours it joins. */
function pieceLabel(mask: number, style: TilesetTerrainStyle): string {
  if (mask === 0) return "Single Piece";
  if (mask === (style === "sides" ? TERRAIN_SIDES : TERRAIN_ALL)) return "Fill Piece";
  return `Piece Joining ${DIRECTIONS.filter(([bit]) => mask & bit).map(([, name]) => name).join(", ")}`;
}

/**
 * How a glyph draws: `badge` on its own dark plate, `outline` with faint
 * unjoined parts and no plate (an empty piece over its stand-in), `overlay`
 * with only the joined parts (over tile art).
 */
type GlyphVariant = "badge" | "outline" | "overlay";

function glyphRects(mask: number, style: TilesetTerrainStyle, variant: GlyphVariant, x = 0, y = 0) {
  return GLYPH_CELLS.map(([bit, column, row]) => {
    if (CORNER_BITS.has(bit) && style === "sides") return null;
    const on = bit === 0 || (mask & bit) !== 0;
    if (variant === "overlay" && !on) return null;
    return (
      <rect
        key={bit}
        x={x + column + 0.12}
        y={y + row + 0.12}
        width={0.76}
        height={0.76}
        rx={0.14}
        className={
          on
            ? bit === 0 ? "fill-ring" : variant === "badge" ? "fill-ring/55" : "fill-ring/75"
            : variant === "badge" ? "fill-muted" : "fill-muted-foreground/25"
        }
      />
    );
  });
}

/** A piece drawn as the tile in the middle and the neighbours it joins around it. */
function AutotileMaskGlyph({
  mask,
  style,
  variant = "badge",
  className,
  testId,
}: {
  mask: number;
  style: TilesetTerrainStyle;
  variant?: GlyphVariant;
  className?: string;
  testId?: string;
}) {
  return (
    <svg
      viewBox="0 0 3 3"
      aria-hidden
      data-testid={testId}
      data-mask={mask}
      className={cn("shrink-0", className)}
    >
      {variant === "badge" ? <rect width={3} height={3} rx={0.35} className="fill-background" /> : null}
      {glyphRects(mask, style, variant)}
    </svg>
  );
}

/** A template's pieces as glyphs in its block shape. */
function AutotileTemplatePreview({
  template,
  style,
  height,
  className,
}: {
  template: AutotileTemplate;
  style: TilesetTerrainStyle;
  /** CSS height; the width follows the block's shape. */
  height: string;
  className?: string;
}) {
  const pitch = 3.4;
  return (
    <svg
      viewBox={`0 0 ${template.columns * pitch - 0.4} ${template.rows * pitch - 0.4}`}
      aria-hidden
      className={cn("shrink-0", className)}
      // Inline, so the 16px icon size menus and toggles give their SVGs cannot shrink it.
      style={{ height, width: "auto", maxWidth: "100%" }}
    >
      {template.masks.map((mask, at) => {
        if (mask === null) return null;
        const x = (at % template.columns) * pitch;
        const y = Math.floor(at / template.columns) * pitch;
        return (
          <g key={at}>
            <rect x={x} y={y} width={3} height={3} rx={0.35} className="fill-background" />
            {glyphRects(mask, style, "badge", x, y)}
          </g>
        );
      })}
    </svg>
  );
}

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
      style={{
        backgroundImage: "conic-gradient(var(--muted) 0.25turn, var(--background) 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, var(--background) 0.75turn)",
        backgroundSize: "10px 10px",
      }}
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

/** Identity of one piece set in the window's choices: the autotile and its border (empty for the default set). */
function pieceSetKey(terrainId: string, border: string | undefined): string {
  return `${terrainId}\u0000${border ?? ""}`;
}

function uniqueAutotileName(terrains: readonly TilesetTerrain[]): string {
  const names = new Set(terrains.map((terrain) => terrain.name));
  if (!names.has("Autotile")) return "Autotile";
  let index = 2;
  while (names.has(`Autotile ${index}`)) index += 1;
  return `Autotile ${index}`;
}

function autotileNameError(name: string, terrains: readonly TilesetTerrain[], except?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name.";
  if (terrains.some((terrain) => terrain.id !== except && terrain.name === trimmed)) {
    return `Another autotile is already named ${trimmed}.`;
  }
  return null;
}

/** The slot an Arrow key moves to on the board, skipping unused cells; `null` at the edge. */
function neighbourSlot(style: TilesetTerrainStyle, mask: number, key: string): number | null {
  const layout = AUTOTILE_LAYOUTS[style];
  const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
  const at = layout.masks.indexOf(mask);
  if (!step || at < 0) return null;
  let column = (at % layout.columns) + step[0]!;
  let row = Math.floor(at / layout.columns) + step[1]!;
  while (column >= 0 && row >= 0 && column < layout.columns && row < layout.rows) {
    const next = layout.masks[row * layout.columns + column];
    if (next !== null && next !== undefined) return next;
    column += step[0]!;
    row += step[1]!;
  }
  return null;
}

/** The first piece without a tile in board order, starting after `after` and wrapping; `null` when none. */
function nextEmptySlot(style: TilesetTerrainStyle, pieces: ReadonlyMap<number, number[]>, after: number | null): number | null {
  const order = AUTOTILE_LAYOUTS[style].masks.filter((mask): mask is number => mask !== null);
  const start = after === null ? 0 : order.indexOf(after) + 1;
  for (let step = 0; step < order.length; step++) {
    const mask = order[(start + step) % order.length]!;
    if (!(pieces.get(mask)?.length)) return mask;
  }
  return null;
}

function tileColumnRow(tileset: TilesetPayload, tileId: number): { column: number; row: number } {
  const columns = tilesetAtlasColumns(tileset);
  return { column: (tileId - 1) % columns, row: Math.floor((tileId - 1) / columns) };
}

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

/**
 * The Autotiles window: pick or create an autotile, assign each of its pieces
 * a tile on the sheet (or fill them from a template placed over the art), and
 * try the result in a small test-paint map.
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
  const editing = useOptionalTilesetEditing();
  const [localAutotileId, setLocalAutotileId] = useState<string | null>(null);
  const selectedAutotileId = editing ? editing.selectedAutotileId : localAutotileId;
  const setSelectedAutotileId = editing?.setSelectedAutotileId ?? setLocalAutotileId;
  const autotile = terrains.find((terrain) => terrain.id === selectedAutotileId) ?? terrains[0] ?? null;
  const style = autotile?.style ?? "sides";
  const terrainName = (id: string) => terrains.find((terrain) => terrain.id === id)?.name ?? id;
  // The set being edited: the autotile's default set, or one of its borders.
  const [borderChoice, setBorderChoice] = useState<{ autotileId: string; border: string | null } | null>(null);
  const declaredBorders = useMemo(() => autotile?.borders ?? [], [autotile]);
  const border = autotile && borderChoice?.autotileId === autotile.id && borderChoice.border !== null
    && declaredBorders.includes(borderChoice.border)
    ? borderChoice.border
    : undefined;
  const set = useMemo<AutotilePieceSet | null>(
    () => (autotile ? (border === undefined ? { terrainId: autotile.id } : { terrainId: autotile.id, border }) : null),
    [autotile, border],
  );
  const setKey = autotile ? pieceSetKey(autotile.id, border) : "";
  /** The set's part of a merge key. */
  const setMergeKey = border ?? "default";
  const preview = useTexturePreview(tileset.textureGuid);
  const imageUrl = preview.url ?? null;

  const pieces = useMemo(() => (set ? autotilePieceTiles(tileset, set) : new Map<number, number[]>()), [set, tileset]);
  const covered = pieces.size;
  const setTileCount = [...pieces.values()].reduce((count, ids) => count + ids.length, 0);
  const total = terrainVariantMasks(style).length;
  const resolver = useMemo(() => (autotile ? createTerrainResolver(tileset, autotile.id) : null), [autotile, tileset]);

  // Slot and picked-tile choices belong to one set; another set starts on its first empty piece.
  const [slotChoice, setSlotChoice] = useState<{ setKey: string; mask: number | null } | null>(null);
  const [pickChoice, setPickChoice] = useState<{ setKey: string; tileId: number } | null>(null);
  const selectedMask = autotile
    ? slotChoice?.setKey === setKey ? slotChoice.mask : nextEmptySlot(style, pieces, null)
    : null;
  const pickedTileId = autotile && pickChoice?.setKey === setKey ? pickChoice.tileId : null;
  const selectSlot = (mask: number | null) => {
    if (autotile) setSlotChoice({ setKey, mask });
  };
  const pickTile = (tileId: number | null) => setPickChoice(autotile && tileId !== null ? { setKey, tileId } : null);

  const [placement, setPlacement] = useState<{ setKey: string; template: AutotileTemplate; anchor: number; refused: boolean } | null>(null);
  const activePlacement = placement && placement.setKey === setKey ? placement : null;

  // Test paint's map: the current set's sample until the user paints; picking an autotile or set seeds it again.
  const [sandboxCells, setSandboxCells] = useState<ReadonlyMap<string, string> | null>(null);
  const sampleCells = useMemo(
    () => new Map(set ? autotileSandboxSample(style, set).map((cell) => [`${cell.x},${cell.y}`, cell.terrainId] as const) : []),
    [set, style],
  );
  const testCells = sandboxCells ?? sampleCells;
  const selectAutotile = (id: string) => {
    setSelectedAutotileId(id);
    setSandboxCells(null);
    setPlacement(null);
  };
  const selectBorder = (next: string | null) => {
    if (!autotile) return;
    setBorderChoice({ autotileId: autotile.id, border: next });
    setSandboxCells(null);
    setPlacement(null);
  };
  const placementResult = useMemo(
    () => (activePlacement && set ? applyAutotileTemplate(tileset, set, activePlacement.template, activePlacement.anchor) : null),
    [activePlacement, set, tileset],
  );
  const [reveal, setReveal] = useState<{ tileId: number; token: number } | undefined>(undefined);
  const sheetRef = useRef<HTMLElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [layoutTarget, setLayoutTarget] = useState<TilesetTerrainStyle | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [removeBorderOpen, setRemoveBorderOpen] = useState(false);

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

  const createAutotile = (name: string, nextStyle: TilesetTerrainStyle) => {
    const ids = new Set(terrains.map((terrain) => terrain.id));
    let index = terrains.length + 1;
    while (ids.has(`terrain-${index}`)) index += 1;
    const id = `terrain-${index}`;
    commitTerrains([...terrains, { id, name, style: nextStyle }], `tileset:autotile:${id}:create`);
    selectAutotile(id);
    setSlotChoice(null);
    setPickChoice(null);
  };

  const patchAutotile = (patch: Partial<TilesetTerrain>, mergeKey: string) => {
    if (!autotile) return;
    commitTerrains(terrains.map((terrain) => (terrain.id === autotile.id ? { ...terrain, ...patch } : terrain)), mergeKey);
  };

  const changeLayout = (nextStyle: TilesetTerrainStyle) => {
    if (!autotile || nextStyle === autotile.style) return;
    patchAutotile({ style: nextStyle }, `tileset:autotile:${autotile.id}:layout:${nextStyle}`);
    setSlotChoice(null);
    setPlacement(null);
    setSandboxCells(null);
  };

  /** Tiles that leave autotiles when this one is deleted: its own, and other autotiles' tiles drawn against it. */
  const deletedTileCount = autotile
    ? tileset.tiles.filter((tile) => tile.terrain && (tile.terrain.id === autotile.id || tile.terrain.border === autotile.id)).length
    : 0;
  const autotileTileCount = autotile ? tileset.tiles.filter((tile) => tile.terrain?.id === autotile.id).length : 0;

  const deleteAutotile = () => {
    if (!autotile) return;
    const index = terrains.findIndex((terrain) => terrain.id === autotile.id);
    const remaining = terrains.filter((terrain) => terrain.id !== autotile.id);
    commitTerrains(remaining, `tileset:autotile:${autotile.id}:delete`);
    setSelectedAutotileId(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
    setPlacement(null);
    setSandboxCells(null);
  };

  /** Other autotiles this one has no border for yet. */
  const borderCandidates = autotile
    ? terrains.filter((terrain) => terrain.id !== autotile.id && !declaredBorders.includes(terrain.id))
    : [];

  const addBorder = (other: string) => {
    if (!autotile || declaredBorders.includes(other)) return;
    patchAutotile({ borders: [...declaredBorders, other] }, `tileset:autotile:${autotile.id}:border-add:${other}`);
    selectBorder(other);
  };

  const removeBorder = () => {
    if (!autotile || border === undefined) return;
    patchAutotile(
      { borders: declaredBorders.filter((entry) => entry !== border) },
      `tileset:autotile:${autotile.id}:border-remove:${border}`,
    );
    selectBorder(null);
  };

  const assign = (mask: number, tileId: number) => {
    if (!autotile || !set) return;
    const next = assignAutotilePiece(tileset, set, mask, tileId);
    commit(next, `tileset:autotile:${autotile.id}:piece:${setMergeKey}:${mask}:${tileId}`);
    setSlotChoice({ setKey, mask: nextEmptySlot(style, autotilePieceTiles(next, set), mask) });
    setPickChoice(null);
  };

  const clearPiece = (mask: number) => {
    if (!autotile || !set) return;
    commit(clearAutotilePiece(tileset, set, mask), `tileset:autotile:${autotile.id}:clear:${setMergeKey}:${mask}`);
    selectSlot(mask);
  };

  const removeTile = (tileId: number) => {
    if (!autotile || !set) return;
    commit(removeTileFromAutotile(tileset, set, tileId), `tileset:autotile:${autotile.id}:remove:${setMergeKey}:${tileId}`);
  };

  /** Test paint's Pick: the cell's autotile, set and piece, keeping the test map as it is. */
  const pickFromTestPaint = (cell: AutotileSandboxTile) => {
    setSandboxCells(testCells);
    setSelectedAutotileId(cell.terrainId);
    setBorderChoice({ autotileId: cell.terrainId, border: cell.border ?? null });
    setPlacement(null);
    setPickChoice(null);
    if (cell.want !== null) setSlotChoice({ setKey: pieceSetKey(cell.terrainId, cell.border), mask: cell.want });
  };

  const showOnSheet = (mask: number) => {
    const tileId = pieces.get(mask)?.[0];
    selectSlot(mask);
    if (tileId === undefined) return;
    setReveal((current) => ({ tileId, token: (current?.token ?? 0) + 1 }));
    sheetRef.current?.scrollIntoView?.({ block: "nearest" });
  };

  const startPlacement = (template: AutotileTemplate) => {
    if (!autotile || !autotileTemplateFits(tileset, template)) return;
    const candidates = [pickedTileId, selectedMask !== null ? pieces.get(selectedMask)?.[0] : undefined, 1];
    const anchor = candidates.find((tileId): tileId is number =>
      typeof tileId === "number" && autotileTemplatePlacement(tileset, template, tileId) !== null) ?? 1;
    setPlacement({ setKey, template, anchor, refused: false });
    sheetRef.current?.scrollIntoView?.({ block: "nearest" });
  };

  const applyPlacement = () => {
    if (!autotile || !set || !activePlacement || !placementResult) return;
    commit(
      placementResult.next,
      `tileset:autotile:${autotile.id}:template:${setMergeKey}:${activePlacement.template.id}:${activePlacement.anchor}`,
    );
    setPlacement(null);
    setSlotChoice({ setKey, mask: nextEmptySlot(style, autotilePieceTiles(placementResult.next, set), null) });
  };

  const placedTileIds = useMemo(
    () => new Set(activePlacement ? (autotileTemplatePlacement(tileset, activePlacement.template, activePlacement.anchor) ?? []).map((cell) => cell.tileId) : []),
    [activePlacement, tileset],
  );

  /** Move the template so its top-left sits on `anchor`; a spot past the sheet is refused. */
  const moveAnchor = (anchor: number | null): boolean => {
    if (!activePlacement) return false;
    if (anchor === null || autotileTemplatePlacement(tileset, activePlacement.template, anchor) === null) {
      setPlacement({ ...activePlacement, refused: true });
      return false;
    }
    setPlacement({ ...activePlacement, anchor, refused: false });
    return true;
  };

  // Dragging the template keeps the grabbed cell under the pointer; at the sheet's edges it stops.
  const ghostDragRef = useRef<{ tileId: number; anchor: number } | null>(null);
  const ghostDrag: AtlasTileDrag | undefined = activePlacement
    ? {
        start: (tileId) => {
          if (!placedTileIds.has(tileId)) return false;
          ghostDragRef.current = { tileId, anchor: activePlacement.anchor };
          return true;
        },
        move: (tileId) => {
          const grab = ghostDragRef.current;
          if (!grab) return;
          const from = tileColumnRow(tileset, grab.tileId);
          const to = tileColumnRow(tileset, tileId);
          const start = tileColumnRow(tileset, grab.anchor);
          const columns = tilesetAtlasColumns(tileset);
          const { template } = activePlacement;
          const column = Math.min(Math.max(0, start.column + to.column - from.column), columns - template.columns);
          const row = Math.min(Math.max(0, start.row + to.row - from.row), tilesetAtlasRows(tileset) - template.rows);
          const anchor = row * columns + column + 1;
          if (anchor !== activePlacement.anchor) setPlacement({ ...activePlacement, anchor, refused: false });
        },
      }
    : undefined;

  const onSheetTap = (tileId: number) => {
    if (activePlacement) {
      if (!placedTileIds.has(tileId)) moveAnchor(tileId);
      return;
    }
    if (selectedMask !== null) {
      assign(selectedMask, tileId);
      return;
    }
    pickTile(pickedTileId === tileId ? null : tileId);
  };

  const onSlot = (mask: number) => {
    if (pickedTileId !== null) {
      assign(mask, pickedTileId);
      return;
    }
    selectSlot(selectedMask === mask ? null : mask);
  };

  const onSlotKeyDown = (event: ReactKeyboardEvent, mask: number) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      clearPiece(mask);
      return;
    }
    const next = neighbourSlot(style, mask, event.key);
    if (next === null) return;
    event.preventDefault();
    selectSlot(next);
    boardRef.current?.querySelector<HTMLElement>(`[data-slot-mask="${next}"]`)?.focus();
  };

  // Menus: one for the slot under the press, one for sheet tiles.
  const menuMaskRef = useRef<number | null>(null);
  const slotMenu = useContextMenu({
    enabled: autotile !== null,
    items: (): ContextMenuItem[] => {
      const mask = menuMaskRef.current;
      if (mask === null) return [];
      const empty = !(pieces.get(mask)?.length);
      return [
        { id: "clear-piece", label: "Clear Piece", disabled: empty, onSelect: () => clearPiece(mask), testId: "tileset-autotiles-clear-piece" },
        { id: "show-on-sheet", label: "Show On Sheet", disabled: empty, onSelect: () => showOnSheet(mask), testId: "tileset-autotiles-show-on-sheet" },
      ];
    },
  });
  const rememberMenuSlot = (event: { target: EventTarget | null }) => {
    const slot = event.target instanceof Element ? event.target.closest("[data-slot-mask]") : null;
    menuMaskRef.current = slot ? Number(slot.getAttribute("data-slot-mask")) : null;
  };
  const sheetMenu = useContextMenu({ items: [] });
  const openTileMenu = (tileId: number, clientX: number, clientY: number) => {
    const member = set ? autotilePieceOfTile(tileset, set, tileId) !== null : false;
    sheetMenu.openMenuAt(clientX, clientY, [
      {
        id: "remove-from-autotile",
        label: "Remove From Autotile",
        disabled: !member,
        onSelect: () => removeTile(tileId),
        testId: "tileset-autotiles-remove-tile",
      },
    ]);
  };

  // Sheet badges: this autotile's pieces carry their glyph, other autotiles' tiles are dimmed.
  const sheetMarks = useMemo(() => {
    const own = new Map<number, { mask: number; unused: boolean }>();
    for (const [mask, ids] of pieces) ids.forEach((tileId, at) => own.set(tileId, { mask, unused: at > 0 }));
    const others = new Set(
      tileset.tiles.flatMap((tile) => (tile.terrain && !own.has(tile.id) ? [tile.id] : [])),
    );
    return { own, others };
  }, [pieces, tileset]);
  const renderCellOverlay = useCallback(
    (tileId: number) => {
      const piece = sheetMarks.own.get(tileId);
      if (piece) {
        return (
          <AutotileMaskGlyph
            mask={piece.mask}
            style={style}
            testId={`tileset-autotiles-sheet-piece-${tileId}`}
            className={cn("pointer-events-none absolute top-[6%] left-[6%] size-[36%]", piece.unused && "opacity-45")}
          />
        );
      }
      if (sheetMarks.others.has(tileId)) {
        return (
          <span
            aria-hidden
            data-testid={`tileset-autotiles-sheet-other-${tileId}`}
            className="pointer-events-none absolute inset-0 bg-background/60"
          />
        );
      }
      return null;
    },
    [sheetMarks, style],
  );
  const selectedPieceTileId = selectedMask !== null ? pieces.get(selectedMask)?.[0] ?? null : null;
  // Stable while the highlight is unchanged, so the sheet's cells are not rebuilt on every window render.
  const highlightedTileIds = useMemo(
    () => (activePlacement ? [] : pickedTileId !== null ? [pickedTileId] : selectedPieceTileId !== null ? [selectedPieceTileId] : []),
    [activePlacement, pickedTileId, selectedPieceTileId],
  );
  const sheetTapRef = useRef(onSheetTap);
  useLayoutEffect(() => {
    sheetTapRef.current = onSheetTap;
  });
  const onStableSheetTap = useCallback((tileId: number) => sheetTapRef.current(tileId), []);

  const onWindowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (activePlacement) setPlacement(null);
    else if (pickedTileId !== null) pickTile(null);
    else if (selectedMask !== null) selectSlot(null);
  };

  const status = activePlacement
    ? null
    : pickedTileId !== null
      ? `Tile ${pickedTileId}: tap a piece to assign it.`
      : selectedMask !== null
        ? `${pieceLabel(selectedMask, style)}: tap a tile on the sheet.`
        : "Tap a piece, then a tile, or a tile, then a piece.";

  return (
    <div
      className="@container/autotiles flex h-full min-h-0 flex-col"
      data-testid="tileset-autotiles"
      onKeyDown={onWindowKeyDown}
    >
      <ToolbarStrip className="shrink-0 gap-1.5 py-1" data-testid="tileset-autotiles-toolbar">
        {autotile ? (
          <Select
            value={autotile.id}
            onValueChange={(value) => {
              if (typeof value === "string" && value !== autotile.id) selectAutotile(value);
            }}
            items={terrains.map((terrain) => ({ value: terrain.id, label: terrain.name }))}
          >
            <SelectTrigger
              size="sm"
              aria-label="Autotile"
              className="max-w-56 min-w-32 pointer-coarse:h-11"
              data-testid="tileset-autotiles-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {terrains.map((terrain) => (
                  <SelectItem key={terrain.id} value={terrain.id} data-testid={`tileset-autotiles-option-${terrain.id}`}>
                    {terrain.name}
                    <span className="text-xs text-muted-foreground">{STYLE_NAMES[terrain.style]}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}
        {autotile ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn("max-w-48", TOUCH)}
                  aria-label={`Border, ${border === undefined ? "No Border" : `Into ${terrainName(border)}`}`}
                  data-testid="tileset-autotiles-border"
                />
              }
            >
              <span className="truncate">{border === undefined ? "No Border" : `Into ${terrainName(border)}`}</span>
              <ChevronDownIcon data-icon="inline-end" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48" data-testid="tileset-autotiles-border-menu">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Border</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={border ?? ""}
                  onValueChange={(value) => {
                    const next = typeof value === "string" && value !== "" ? value : null;
                    if (next !== (border ?? null)) selectBorder(next);
                  }}
                >
                  <DropdownMenuRadioItem value="" closeOnClick data-testid="tileset-autotiles-border-none">
                    No Border
                  </DropdownMenuRadioItem>
                  {declaredBorders.map((id) => (
                    <DropdownMenuRadioItem key={id} value={id} closeOnClick data-testid={`tileset-autotiles-border-${id}`}>
                      Into {terrainName(id)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Add Border</DropdownMenuLabel>
                {borderCandidates.length > 0 ? (
                  borderCandidates.map((terrain) => (
                    <DropdownMenuItem
                      key={terrain.id}
                      onClick={() => addBorder(terrain.id)}
                      data-testid={`tileset-autotiles-add-border-${terrain.id}`}
                    >
                      <PlusIcon />
                      Into {terrain.name}
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled data-testid="tileset-autotiles-add-border-none">
                    {terrains.length > 1 ? "Every Autotile Has A Border" : "Needs Another Autotile"}
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={TOUCH}
          onClick={() => setCreateOpen(true)}
          data-testid="tileset-autotiles-new"
        >
          <PlusIcon data-icon="inline-start" />
          New Autotile
        </Button>
        {autotile ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={TOUCH}
                  aria-label="Autotile Actions"
                  data-testid="tileset-autotiles-actions"
                />
              }
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48" data-testid="tileset-autotiles-actions-menu">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => setRenameOpen(true)} data-testid="tileset-autotiles-rename">
                  <PencilIcon />
                  Rename…
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Change Layout</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={autotile.style}
                  onValueChange={(value) => {
                    const next = value as TilesetTerrainStyle;
                    if (next === autotile.style) return;
                    if (autotileTileCount > 0) setLayoutTarget(next);
                    else changeLayout(next);
                  }}
                >
                  <DropdownMenuRadioItem value="sides" closeOnClick data-testid="tileset-autotiles-layout-sides">
                    4 Sides (16 Pieces)
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="blob" closeOnClick data-testid="tileset-autotiles-layout-blob">
                    Blob (47 Pieces)
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {border !== undefined ? (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                      if (setTileCount > 0) setRemoveBorderOpen(true);
                      else removeBorder();
                    }}
                    data-testid="tileset-autotiles-remove-border"
                  >
                    <Trash2Icon />
                    Remove Border
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    if (deletedTileCount > 0) setDeleteOpen(true);
                    else deleteAutotile();
                  }}
                  data-testid="tileset-autotiles-delete"
                >
                  <Trash2Icon />
                  Delete Autotile
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </ToolbarStrip>

      {autotile && set ? (
        <div
          className={cn(
            "grid min-h-0 flex-1 content-start overflow-y-auto overscroll-y-contain",
            "@3xl/autotiles:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] @3xl/autotiles:grid-rows-[auto_minmax(0,1fr)] @3xl/autotiles:content-stretch @3xl/autotiles:overflow-hidden",
          )}
        >
          <section
            aria-label="Pieces"
            className="flex min-w-0 flex-col gap-2 border-b border-border p-2 @3xl/autotiles:col-start-1 @3xl/autotiles:row-start-1 @3xl/autotiles:border-r"
            data-testid="tileset-autotiles-board"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="text-xs font-semibold">
                {border === undefined ? "Pieces" : `Pieces Into ${terrainName(border)}`}
              </h3>
              <span className="text-xs text-muted-foreground tabular-nums" data-testid="tileset-autotiles-coverage">
                {covered} of {total} Pieces
              </span>
              <div className="ml-auto">
                <TemplateMenu
                  tileset={tileset}
                  style={style}
                  prominent={covered === 0}
                  onPick={startPlacement}
                />
              </div>
            </div>
            {covered === 0 ? (
              <Empty className="gap-2 rounded-md border border-dashed border-border p-3" data-testid="tileset-autotiles-empty-board">
                <EmptyHeader className="gap-1">
                  <EmptyTitle className="text-xs">No Pieces Yet</EmptyTitle>
                  <EmptyDescription className="text-xs">
                    {border === undefined
                      ? "Fill the board from a template that matches your sheet, or pick a piece and tap its tile."
                      : `Assign the pieces ${autotile.name} draws where it meets ${terrainName(border)}. Until it has some, painting uses the ordinary pieces.`}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            <div
              ref={boardRef}
              role="group"
              aria-label={border === undefined ? `${autotile.name} Pieces` : `${autotile.name} Pieces Into ${terrainName(border)}`}
              className="flex gap-1.5 overflow-x-auto pb-1 touch-pan-x touch-pan-y"
              onPointerDownCapture={rememberMenuSlot}
              onContextMenuCapture={rememberMenuSlot}
              {...slotMenu.bind}
            >
              {Array.from({ length: AUTOTILE_LAYOUTS[style].columns / 4 }, (_, group) => (
                <div key={group} className="grid shrink-0 grid-cols-4 gap-0.5">
                  {AUTOTILE_LAYOUTS[style].masks.flatMap((mask, at) => {
                    const layout = AUTOTILE_LAYOUTS[style];
                    if (Math.floor((at % layout.columns) / 4) !== group) return [];
                    if (mask === null) return [<span key={`empty-${at}`} aria-hidden className={SLOT} />];
                    const tiles = pieces.get(mask) ?? [];
                    const tileId = tiles[0] ?? null;
                    const standIn = tileId === null ? resolver?.resolve(mask, border) ?? null : null;
                    const selected = selectedMask === mask;
                    const focusable = mask === (selectedMask ?? layout.masks.find((entry) => entry !== null));
                    return [
                      <Button
                        key={mask}
                        type="button"
                        variant="outline"
                        size="icon"
                        tabIndex={focusable ? 0 : -1}
                        aria-pressed={selected}
                        aria-label={`${pieceLabel(mask, style)}, ${tileId !== null ? `Tile ${tileId}` : "Empty"}`}
                        data-slot-mask={mask}
                        data-tile-id={tileId ?? undefined}
                        data-testid={`tileset-autotiles-slot-${mask}`}
                        className={cn(
                          "relative overflow-hidden rounded-md p-0",
                          SLOT,
                          tileId === null && "border-dashed border-muted-foreground/50 bg-transparent",
                          selected && "border-(--graph-state-selected) ring-2 ring-(--graph-state-selected)",
                        )}
                        onClick={() => onSlot(mask)}
                        onKeyDown={(event) => onSlotKeyDown(event, mask)}
                      >
                        {tileId !== null ? (
                          <>
                            <TileSwatch
                              tileset={tileset}
                              tileId={tileId}
                              imageUrl={imageUrl}
                              testId={`tileset-autotiles-slot-${mask}-tile`}
                              className="absolute inset-0 size-full rounded-none ring-0"
                            />
                            <AutotileMaskGlyph
                              mask={mask}
                              style={style}
                              className="absolute right-px bottom-px size-3 pointer-coarse:size-4"
                            />
                          </>
                        ) : (
                          <>
                            {standIn !== null ? (
                              <TileSwatch
                                tileset={tileset}
                                tileId={standIn}
                                imageUrl={imageUrl}
                                testId={`tileset-autotiles-slot-${mask}-stand-in`}
                                className="absolute inset-0 size-full rounded-none opacity-30 ring-0"
                              />
                            ) : null}
                            <AutotileMaskGlyph mask={mask} style={style} variant="outline" className="relative size-[70%]" />
                          </>
                        )}
                      </Button>,
                    ];
                  })}
                </div>
              ))}
            </div>
            {status ? (
              <p className="text-xs text-muted-foreground" data-testid="tileset-autotiles-status">{status}</p>
            ) : null}
            <ContextMenuOverlay menu={slotMenu.menu} onClose={slotMenu.closeMenu} />
          </section>

          <section
            ref={sheetRef}
            aria-label="Sheet"
            className="flex h-80 min-h-0 min-w-0 flex-col border-b border-border @3xl/autotiles:col-start-2 @3xl/autotiles:row-span-2 @3xl/autotiles:row-start-1 @3xl/autotiles:h-auto @3xl/autotiles:border-b-0"
          >
            {activePlacement ? (
              <div
                className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-panel-header px-2 py-1"
                data-testid="tileset-autotiles-placement-bar"
              >
                <AutotileTemplatePreview template={activePlacement.template} style={style} height="1rem" />
                <span className="text-xs font-medium">{activePlacement.template.title}</span>
                <span className="text-xs text-muted-foreground" data-testid="tileset-autotiles-placement-status">
                  {activePlacement.refused
                    ? "That spot runs past the sheet."
                    : placementResult && placementResult.replaced > 0
                      ? `Replaces ${placementResult.replaced} ${placementResult.replaced === 1 ? "Assignment" : "Assignments"}`
                      : "Tap or drag to move it."}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={TOUCH}
                    onClick={() => setPlacement(null)}
                    data-testid="tileset-autotiles-placement-cancel"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className={TOUCH}
                    disabled={!placementResult}
                    onClick={applyPlacement}
                    data-testid="tileset-autotiles-placement-apply"
                  >
                    {`Assign ${placementResult?.pieces ?? 0} ${placementResult?.pieces === 1 ? "Piece" : "Pieces"}`}
                  </Button>
                </div>
              </div>
            ) : null}
            <AtlasTileGrid
              tileset={tileset}
              imageUrl={imageUrl}
              selectedId={0}
              selectedIds={highlightedTileIds}
              onSelect={onStableSheetTap}
              panZoom
              tool="move"
              renderCellOverlay={renderCellOverlay}
              overlay={activePlacement ? (
                <PlacementGhost tileset={tileset} template={activePlacement.template} anchor={activePlacement.anchor} style={style} />
              ) : null}
              onTileContextMenu={activePlacement ? undefined : openTileMenu}
              tileDrag={ghostDrag}
              reveal={reveal}
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
            <ContextMenuOverlay menu={sheetMenu.menu} onClose={sheetMenu.closeMenu} />
          </section>

          <AutotileTestPaint
            tileset={tileset}
            terrains={terrains}
            cells={testCells}
            defaultBrush={autotile.id}
            imageUrl={imageUrl}
            onCellsChange={setSandboxCells}
            onReset={() => setSandboxCells(null)}
            onPick={pickFromTestPaint}
          />
        </div>
      ) : (
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
            <Button type="button" size="sm" className={TOUCH} onClick={() => setCreateOpen(true)} data-testid="tileset-autotiles-empty-new">
              <PlusIcon data-icon="inline-start" />
              New Autotile
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {createOpen ? (
        <AutotileCreateDialog
          terrains={terrains}
          onOpenChange={setCreateOpen}
          onCreate={(name, nextStyle) => {
            createAutotile(name, nextStyle);
            setCreateOpen(false);
          }}
        />
      ) : null}
      {autotile ? (
        <NamePromptDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          title="Rename Autotile"
          label="Name"
          confirmLabel="Rename"
          initialValue={autotile.name}
          validate={(name) => autotileNameError(name, terrains, autotile.id)}
          onSubmit={(name) => patchAutotile({ name }, `tileset:autotile:${autotile.id}:name`)}
          data-testid="tileset-autotiles-rename-dialog"
        />
      ) : null}
      {autotile && set && layoutTarget ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) setLayoutTarget(null); }}>
          <AlertDialogContent data-testid="tileset-autotiles-layout-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Change Layout to {STYLE_NAMES[layoutTarget]}</AlertDialogTitle>
              <AlertDialogDescription>
                {layoutChangeMessage(tileset, set, layoutTarget)}
                {declaredBorders.length > 0 ? " Its borders keep their tiles too." : ""}
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
      {autotile && deleteOpen ? (
        <AlertDialog open onOpenChange={setDeleteOpen}>
          <AlertDialogContent data-testid="tileset-autotiles-delete-dialog">
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-destructive/10 text-destructive">
                <Trash2Icon />
              </AlertDialogMedia>
              <AlertDialogTitle>Delete {autotile.name}</AlertDialogTitle>
              <AlertDialogDescription>
                {deletedTileCount === 1 ? "1 tile leaves" : `${deletedTileCount} tiles leave`} the autotile and other
                autotiles&apos; borders into it; Tilemaps keep the tiles already painted. You can undo this.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
              <AlertDialogAction
                size="sm"
                variant="destructive"
                onClick={() => {
                  deleteAutotile();
                  setDeleteOpen(false);
                }}
                data-testid="tileset-autotiles-delete-confirm"
              >
                Delete Autotile
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {autotile && border !== undefined && removeBorderOpen ? (
        <AlertDialog open onOpenChange={setRemoveBorderOpen}>
          <AlertDialogContent data-testid="tileset-autotiles-remove-border-dialog">
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-destructive/10 text-destructive">
                <Trash2Icon />
              </AlertDialogMedia>
              <AlertDialogTitle>Remove Border Into {terrainName(border)}</AlertDialogTitle>
              <AlertDialogDescription>
                {setTileCount === 1 ? "Its 1 tile leaves" : `Its ${setTileCount} tiles leave`} {autotile.name}. You can undo
                this.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
              <AlertDialogAction
                size="sm"
                variant="destructive"
                onClick={() => {
                  removeBorder();
                  setRemoveBorderOpen(false);
                }}
                data-testid="tileset-autotiles-remove-border-confirm"
              >
                Remove Border
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

/** Fill From Template…: the templates of the style, disabled where the sheet is too small. */
function TemplateMenu({
  tileset,
  style,
  prominent,
  onPick,
}: {
  tileset: TilesetPayload;
  style: TilesetTerrainStyle;
  prominent: boolean;
  onPick: (template: AutotileTemplate) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant={prominent ? "default" : "outline"}
            size="sm"
            className={TOUCH}
            data-testid="tileset-autotiles-fill-template"
          />
        }
      >
        <LayoutTemplateIcon data-icon="inline-start" />
        Fill From Template…
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64" data-testid="tileset-autotiles-template-menu">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{STYLE_NAMES[style]} Templates</DropdownMenuLabel>
          {AUTOTILE_TEMPLATES[style].map((template) => {
            const fits = autotileTemplateFits(tileset, template);
            return (
              <DropdownMenuItem
                key={template.id}
                disabled={!fits}
                onClick={() => onPick(template)}
                data-testid={`tileset-autotiles-template-${template.id}`}
              >
                <span className="flex w-16 shrink-0 justify-center">
                  <AutotileTemplatePreview template={template} style={style} height="1.25rem" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span>{template.title}</span>
                  {!fits ? (
                    <span className="text-xs text-muted-foreground">Needs {template.columns} × {template.rows} Tiles</span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The template being placed, drawn over the art in atlas pixels. */
function PlacementGhost({
  tileset,
  template,
  anchor,
  style,
}: {
  tileset: TilesetPayload;
  template: AutotileTemplate;
  anchor: number;
  style: TilesetTerrainStyle;
}) {
  const placement = autotileTemplatePlacement(tileset, template, anchor);
  const first = placement ? tilesetTileRect(tileset, placement[0]!.tileId) : null;
  const last = placement ? tilesetTileRect(tileset, placement.at(-1)!.tileId) : null;
  if (!placement || !first || !last) return null;
  return (
    <div
      aria-hidden
      data-testid="tileset-autotiles-placement"
      data-anchor={anchor}
      className="pointer-events-none absolute z-20"
      style={{
        left: first.x,
        top: first.y,
        width: last.x + last.width - first.x,
        height: last.y + last.height - first.y,
        outline: "calc(2px / var(--atlas-zoom, 1)) dashed var(--graph-state-selected)",
      }}
    >
      {placement.map((cell) => {
        const rect = tilesetTileRect(tileset, cell.tileId);
        if (!rect) return null;
        return (
          <span
            key={cell.tileId}
            className="absolute flex items-center justify-center bg-background/35"
            style={{ left: rect.x - first.x, top: rect.y - first.y, width: rect.width, height: rect.height }}
          >
            {cell.mask !== null ? (
              <AutotileMaskGlyph mask={cell.mask} style={style} variant="overlay" className="size-[78%]" />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

const SANDBOX_SIZE = { width: AUTOTILE_SANDBOX_WIDTH, height: AUTOTILE_SANDBOX_HEIGHT };
type TestPaintTool = "paint" | "erase" | "pick";

const cellKey = (cell: { x: number; y: number }) => `${cell.x},${cell.y}`;

/** Every cell on the straight line from `from` to `to`, so a quick drag leaves no gaps. */
function cellsBetween(from: { x: number; y: number }, to: { x: number; y: number }): Array<{ x: number; y: number }> {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  return Array.from({ length: steps + 1 }, (_, step) => ({
    x: Math.round(from.x + ((to.x - from.x) * step) / Math.max(1, steps)),
    y: Math.round(from.y + ((to.y - from.y) * step) / Math.max(1, steps)),
  }));
}

/**
 * Test Paint: a small map painted exactly as a Tilemap brush would, with any
 * autotile of the Tileset, so both sides of a border can be tried. The window
 * owns the map (`cells`: `x,y` → autotile id); it is never saved.
 */
function AutotileTestPaint({
  tileset,
  terrains,
  cells,
  defaultBrush,
  imageUrl,
  onCellsChange,
  onReset,
  onPick,
}: {
  tileset: TilesetPayload;
  terrains: readonly TilesetTerrain[];
  cells: ReadonlyMap<string, string>;
  /** The autotile Paint uses until another is chosen: the one the window edits. */
  defaultBrush: string;
  imageUrl: string | null;
  onCellsChange: (cells: ReadonlyMap<string, string>) => void;
  onReset: () => void;
  onPick: (cell: AutotileSandboxTile) => void;
}) {
  const [tool, setTool] = useState<TestPaintTool>("paint");
  const [brushChoice, setBrushChoice] = useState<string | null>(null);
  const brush = brushChoice !== null && terrains.some((terrain) => terrain.id === brushChoice) ? brushChoice : defaultBrush;
  const tiles = useMemo(
    () => autotileSandboxTiles(tileset, [...cells].map(([key, terrainId]) => {
      const [x, y] = key.split(",").map(Number);
      return { x: x!, y: y!, terrainId };
    }), SANDBOX_SIZE),
    [cells, tileset],
  );
  const standIns = [...tiles.values()].filter((tile) => tile.standIn).length;
  const gridRef = useRef<HTMLDivElement>(null);
  const strokeRef = useRef<{ pointerId: number; last: { x: number; y: number }; cells: ReadonlyMap<string, string> } | null>(null);

  const cellAt = (event: ReactPointerEvent): { x: number; y: number } | null => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const column = Math.floor(((event.clientX - rect.left) / rect.width) * SANDBOX_SIZE.width);
    const row = Math.floor(((event.clientY - rect.top) / rect.height) * SANDBOX_SIZE.height);
    if (column < 0 || row < 0 || column >= SANDBOX_SIZE.width || row >= SANDBOX_SIZE.height) return null;
    return { x: column, y: SANDBOX_SIZE.height - 1 - row };
  };
  /** Paint or erase `changes` on top of `base`; reports and returns the new map, or `base` when nothing changed. */
  const paint = (base: ReadonlyMap<string, string>, changes: Array<{ x: number; y: number }>) => {
    const next = new Map(base);
    for (const cell of changes) {
      if (tool === "paint") next.set(cellKey(cell), brush);
      else next.delete(cellKey(cell));
    }
    const changed = next.size !== base.size || [...next].some(([key, terrainId]) => base.get(key) !== terrainId);
    if (!changed) return base;
    onCellsChange(next);
    return next;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const cell = cellAt(event);
    if (!cell) return;
    event.preventDefault();
    if (tool === "pick") {
      const tile = tiles.get(cellKey(cell));
      if (tile) onPick(tile);
      return;
    }
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointers (tests) have no active pointer to capture.
    }
    // A stroke builds on its own map, so moves that arrive before a re-render keep each other.
    strokeRef.current = { pointerId: event.pointerId, last: cell, cells: paint(cells, [cell]) };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    const cell = cellAt(event);
    if (!cell || (cell.x === stroke.last.x && cell.y === stroke.last.y)) return;
    stroke.cells = paint(stroke.cells, cellsBetween(stroke.last, cell));
    stroke.last = cell;
  };
  const endStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (strokeRef.current?.pointerId === event.pointerId) strokeRef.current = null;
  };

  return (
    <section
      aria-label="Test Paint"
      className="flex min-w-0 flex-col gap-2 p-2 @3xl/autotiles:col-start-1 @3xl/autotiles:row-start-2 @3xl/autotiles:overflow-y-auto @3xl/autotiles:border-r @3xl/autotiles:border-border"
      data-testid="tileset-autotiles-test-paint"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold">Test Paint</h3>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[tool]}
          onValueChange={(value) => {
            const next = value[0] as TestPaintTool | undefined;
            if (next) setTool(next);
          }}
          aria-label="Test Paint Tool"
          data-testid="tileset-autotiles-test-tools"
        >
          <ToggleGroupItem value="paint" className={TOUCH} data-testid="tileset-autotiles-test-paint-tool">
            <BrushIcon />
            Paint
          </ToggleGroupItem>
          <ToggleGroupItem value="erase" className={TOUCH} data-testid="tileset-autotiles-test-erase-tool">
            <EraserIcon />
            Erase
          </ToggleGroupItem>
          <ToggleGroupItem value="pick" className={TOUCH} data-testid="tileset-autotiles-test-pick-tool">
            <PipetteIcon />
            Pick
          </ToggleGroupItem>
        </ToggleGroup>
        {terrains.length > 1 ? (
          <Select
            value={brush}
            onValueChange={(value) => {
              if (typeof value === "string") setBrushChoice(value);
            }}
            items={terrains.map((terrain) => ({ value: terrain.id, label: terrain.name }))}
          >
            <SelectTrigger
              size="sm"
              aria-label="Test Paint Autotile"
              className="max-w-40 min-w-24 pointer-coarse:h-11"
              data-testid="tileset-autotiles-test-brush"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {terrains.map((terrain) => (
                  <SelectItem key={terrain.id} value={terrain.id} data-testid={`tileset-autotiles-test-brush-${terrain.id}`}>
                    {terrain.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("ml-auto", TOUCH)}
          onClick={() => {
            setBrushChoice(null);
            onReset();
          }}
          data-testid="tileset-autotiles-test-reset"
        >
          <RotateCcwIcon data-icon="inline-start" />
          Reset
        </Button>
      </div>
      <div
        ref={gridRef}
        role="img"
        aria-label="Test Paint Map"
        className="grid w-full max-w-[28rem] touch-none overflow-hidden rounded-md border border-border select-none"
        style={{
          gridTemplateColumns: `repeat(${SANDBOX_SIZE.width}, minmax(0, 1fr))`,
          aspectRatio: `${SANDBOX_SIZE.width * tileset.tileWidth} / ${SANDBOX_SIZE.height * tileset.tileHeight}`,
          backgroundImage: "conic-gradient(var(--muted) 0.25turn, var(--background) 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, var(--background) 0.75turn)",
          backgroundSize: "16px 16px",
        }}
        data-testid="tileset-autotiles-test-map"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
      >
        {Array.from({ length: SANDBOX_SIZE.height }, (_, row) => SANDBOX_SIZE.height - 1 - row).flatMap((y) =>
          Array.from({ length: SANDBOX_SIZE.width }, (_, x) => {
            const tile = tiles.get(cellKey({ x, y }));
            return (
              <span
                key={`${x},${y}`}
                className="relative min-w-0"
                data-testid={`tileset-autotiles-test-cell-${x}-${y}`}
                data-terrain={tile?.terrainId}
                data-tile-id={tile?.tileId ?? 0}
                data-border={tile?.border}
                data-stand-in={tile?.standIn ? "true" : undefined}
              >
                {tile && tile.tileId > 0 ? (
                  <TileSwatch
                    tileset={tileset}
                    tileId={tile.tileId}
                    imageUrl={imageUrl}
                    testId={`tileset-autotiles-test-cell-${x}-${y}-tile`}
                    className="absolute inset-0 size-full rounded-none ring-0"
                  />
                ) : tile ? (
                  <span aria-hidden className="absolute inset-0 bg-muted-foreground/40" />
                ) : null}
                {tile?.standIn ? (
                  <span aria-hidden className="pointer-events-none absolute inset-px border border-dashed border-(--warning)" />
                ) : null}
              </span>
            );
          }),
        )}
      </div>
      {standIns > 0 ? (
        <p className="text-xs text-(--warning)" data-testid="tileset-autotiles-test-stand-ins">
          {standIns === 1 ? "1 cell uses a stand-in tile." : `${standIns} cells use a stand-in tile.`}
        </p>
      ) : null}
    </section>
  );
}

/** New Autotile: a name and the Layout, chosen before the autotile exists. */
function AutotileCreateDialog({
  terrains,
  onOpenChange,
  onCreate,
}: {
  terrains: readonly TilesetTerrain[];
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, style: TilesetTerrainStyle) => void;
}) {
  const [name, setName] = useState(() => uniqueAutotileName(terrains));
  const [style, setStyle] = useState<TilesetTerrainStyle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!style) return;
    const message = autotileNameError(name, terrains);
    if (message) {
      setError(message);
      return;
    }
    onCreate(name.trim(), style);
  };
  const layouts: ReadonlyArray<{ style: TilesetTerrainStyle; pieces: string; uses: string }> = [
    { style: "sides", pieces: "16 pieces", uses: "Strips, pipes and platforms." },
    { style: "blob", pieces: "47 pieces", uses: "Ground with inner corners." },
  ];
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="tileset-autotiles-create-dialog">
        <DialogHeader>
          <DialogTitle>New Autotile</DialogTitle>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FieldGroup className="gap-4">
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="tileset-autotile-name">Name</FieldLabel>
              <Input
                id="tileset-autotile-name"
                value={name}
                aria-invalid={error ? true : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                data-testid="tileset-autotiles-create-name"
              />
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel id="tileset-autotile-layout-label">Layout</FieldLabel>
              <ToggleGroup
                aria-labelledby="tileset-autotile-layout-label"
                variant="outline"
                spacing={2}
                value={style ? [style] : []}
                onValueChange={(value) => {
                  const next = value[0] as TilesetTerrainStyle | undefined;
                  if (next) setStyle(next);
                }}
                className="grid w-full grid-cols-2 items-stretch"
              >
                {layouts.map((layout) => (
                  <ToggleGroupItem
                    key={layout.style}
                    value={layout.style}
                    className="h-auto flex-col items-start justify-start gap-1.5 p-2 text-left whitespace-normal"
                    data-testid={`tileset-autotiles-create-layout-${layout.style}`}
                  >
                    <AutotileTemplatePreview template={AUTOTILE_TEMPLATES[layout.style][0]!} style={layout.style} height="2rem" />
                    <span className="text-sm font-medium">{STYLE_NAMES[layout.style]}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {layout.pieces}. {layout.uses}
                    </span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!style} data-testid="tileset-autotiles-create-submit">
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
