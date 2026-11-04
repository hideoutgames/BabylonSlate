import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { DEFAULT_SORTING_LAYERS } from "@haptic/core";
import {
  BrushIcon,
  ChevronDownIcon,
  EraserIcon,
  EyeIcon,
  EyeOffIcon,
  Grid2x2Icon,
  HandIcon,
  LayersIcon,
  PaintBucketIcon,
  PencilIcon,
  PipetteIcon,
  PlusIcon,
  SquareIcon,
  StampIcon,
} from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { Separator } from "@haptic/ui/components/separator";
import { Toggle } from "@haptic/ui/components/toggle";
import { cn } from "@haptic/ui/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@haptic/ui/components/toggle-group";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import {
  AssetPicker,
  NamedListEditor,
  PanelFrame,
  PropertyGrid,
  PropertySectionTitle,
  SearchDropdown,
  SearchInput,
  ToolbarStrip,
  TypeVisualIcon,
  resolveTypeVisual,
  assetRowIdentity,
  selectedPickerIdentity,
  useAssetOpen,
  useTouchUi,
  windowedSlice,
  type PropertyRow,
} from "@haptic/editor-kit";
import {
  addTilemapLayer,
  addTilemapTileset,
  reconcileTilemapTilesets,
  tilemapTileIdentity,
  applyPinchView,
  applyPointerPan,
  applyWheelZoom,
  cachedTerrainResolver,
  decodeTileGid,
  DEFAULT_PAINT_CELL_SIZE,
  encodeTileGid,
  isTilemapPaintStrokeTool,
  missingTerrainVariants,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  paintCanvasTileAt,
  pickTileId,
  rechunkTilemap,
  refreshStaleTilemapTerrains,
  removeTilemapTileset,
  reorderTilemapLayers,
  resizeTilemap,
  tilemapStrokeMergeKey,
  tilemapTerrainKey,
  tilemapTilesetGuids,
  terrainFillMask,
  terrainVariantMasks,
  tileInBounds,
  tilesetTerrainById,
  tilesetTileById,
  tilesetTileRect,
  type TilemapPaintTool,
  type TilemapLayer,
  type TilemapPayload,
  type TilemapTilesetRef,
  type TilesetPayload,
  type TilesetTile,
} from "@haptic/assets";
import {
  useDocumentActions,
  useOpenDocument,
  useProjectState,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import {
  useOptionalTilemapSelection,
  useOptionalTilemapSession,
  type TilemapTileSelection,
} from "../context/tilemap-editing-context";
import {
  TilesetPayloadLoader,
  loadTilesetPayloads,
  resolveTilesetSources,
  sameTilesetSources,
} from "../context/tilemap-tileset-payloads";
import { TilesetAtlasLoader } from "../context/tilemap-tileset-atlases";
import { TilemapStroke, type TilemapStrokeShape } from "../lib/tilemap-stroke";
import {
  createBrowserPaintSurface,
  placeholderCss,
  TilemapPaintRenderer,
} from "../lib/tilemap-paint-renderer";

const TOOLS: Array<{
  id: TilemapPaintTool;
  label: string;
  icon: typeof PencilIcon;
}> = [
  { id: "move", label: "Move", icon: HandIcon },
  { id: "brush", label: "Brush", icon: PencilIcon },
  { id: "eraser", label: "Eraser", icon: EraserIcon },
  { id: "rect", label: "Rect", icon: SquareIcon },
  { id: "bucket", label: "Bucket", icon: PaintBucketIcon },
  { id: "stamp", label: "Stamp", icon: StampIcon },
  { id: "picker", label: "Picker", icon: PipetteIcon },
];

const EMPTY_TILESETS_COPY = "Add a Tileset to start painting.";
const TILESET_VISUAL = resolveTypeVisual({ assetType: "Tileset" });
const TOOL_ITEM = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
/** The content of a tab whose document has not loaded; one object, so it normalizes once. */
const NO_PAYLOAD: Record<string, unknown> = {};

/** One Tilemap document panel: its payload and an edit callback that keeps its identity across renders. */
function useTilemapPanelDocument() {
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const payload = (doc?.content ?? NO_PAYLOAD) as Record<string, unknown>;
  const onChange = useCallback((next: Record<string, unknown>, mergeKey?: string) => {
    void applyAssetDocumentChange(documentId, next, mergeKey);
  }, [applyAssetDocumentChange, documentId]);
  return { payload, onChange };
}

export function TilemapPaintPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, onChange } = useTilemapPanelDocument();
  return (
    <PanelFrame data-testid="tilemap-paint-panel">
      <TilemapPaint payload={payload} onChange={onChange} />
    </PanelFrame>
  );
}

export function TilemapPalettePanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, onChange } = useTilemapPanelDocument();
  return (
    <PanelFrame data-testid="tilemap-palette-panel">
      <TilemapPalette payload={payload} onChange={onChange} />
    </PanelFrame>
  );
}

export function TilemapDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, onChange } = useTilemapPanelDocument();
  return (
    <PanelFrame data-testid="tilemap-details-panel">
      <TilemapDetails payload={payload} onChange={onChange} />
    </PanelFrame>
  );
}

/** Normalized maps by stored payload object, shared by every panel of every Tilemap document. */
const normalizedTilemaps = new WeakMap<object, TilemapPayload>();
/** Working maps by normalized map and loaded Tileset payloads (`workingTilemap`). */
const workingTilemaps = new WeakMap<TilemapPayload, WeakMap<ReadonlyMap<string, TilesetPayload>, TilemapPayload>>();

/**
 * The stored map, normalized once per payload object: the Details, Palette and
 * Paint panels of a document read the same object, and an edit's untouched
 * chunks keep their identity through it.
 */
function normalizedTilemap(payload: Record<string, unknown>): TilemapPayload {
  let map = normalizedTilemaps.get(payload);
  if (!map) normalizedTilemaps.set(payload, (map = normalizeTilemapPayload(payload)));
  return map;
}

/**
 * The map the Tilemap panels show and edit: the stored map with its Tileset
 * ranges grown to the loaded atlases and the terrain cells of every changed
 * Tileset re-resolved. Panels build each edit on it, so the next authored edit
 * stores both, and undoes with them. Built once per map and Tileset payloads.
 */
function workingTilemap(authored: TilemapPayload, payloads: ReadonlyMap<string, TilesetPayload>): TilemapPayload {
  let byPayloads = workingTilemaps.get(authored);
  if (!byPayloads) workingTilemaps.set(authored, (byPayloads = new WeakMap()));
  let map = byPayloads.get(payloads);
  if (!map) byPayloads.set(payloads, (map = refreshStaleTilemapTerrains(reconcileTilemapTilesets(authored, payloads), payloads)));
  return map;
}

/** One panel's view of a Tilemap document: its working map, the Tilesets it references and a loader for them. */
function useTilemapDocument(payload: Record<string, unknown>) {
  const authored = normalizedTilemap(payload);
  const { payloads, loadPayloads } = useLoadedTilesets(authored);
  const tilemap = workingTilemap(authored, payloads);
  return { tilemap, payloads, loadPayloads };
}

/**
 * The layer Paint writes and the Inspector edits: shared through the document's
 * editing session, so picking it in either is the same pick.
 */
function usePaintLayer(tilemap: TilemapPayload) {
  const session = useOptionalTilemapSession();
  const [localLayerId, setLocalLayerId] = useState<string | null>(null);
  const layerId = session ? session.layerId : localLayerId;
  const setLayerId = session?.setLayerId ?? setLocalLayerId;
  const layer = tilemap.layers.find((entry) => entry.id === layerId) ?? tilemap.layers[0];
  return { layer, setLayerId };
}

export function TilemapDetails({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const { tilemap, loadPayloads } = useTilemapDocument(payload);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removeGuid, setRemoveGuid] = useState<string | null>(null);
  const { layer, setLayerId } = usePaintLayer(tilemap);
  const session = useOptionalTilemapSession();
  const { projectDocument } = useProjectState();
  const assets = useRegistryPickerAssets();
  const sortingLayers = projectDocument?.settings.twoD.sortingLayers ?? [
    "Background",
    "Default",
    "Foreground",
    "UI",
  ];

  /** `field` marks a continuous edit whose scrub is one undo step. */
  const commit = (next: TilemapPayload, field?: string) => {
    const record = next as unknown as Record<string, unknown>;
    if (field) onChange(record, `tilemap:${field}`);
    else onChange(record);
  };

  const patchLayer = (patch: Partial<TilemapLayer>, field?: string) => {
    if (!layer) return;
    commit({
      ...tilemap,
      layers: tilemap.layers.map((entry) =>
        entry.id === layer.id ? { ...entry, ...patch } : entry,
      ),
    }, field ? `layer:${layer.id}:${field}` : undefined);
  };

  const addTilesetToLatest = useAddTileset(tilemap, loadPayloads, assets);
  const addTileset = async (guid: string | null) => {
    const result = await addTilesetToLatest(guid);
    if (!result) return;
    if (result.added && session && result.base.tilesets.length === 0) {
      session.setSelectedTile({ guid: result.added.guid, localId: 1 });
    }
    commit(result.next);
  };

  const mapRows: PropertyRow[] = [
    {
      id: "mapWidth",
      kind: "number",
      label: "Map Width",
      value: tilemap.width,
      min: 1,
      onChange: (value) => commit(resizeTilemap(tilemap, value, tilemap.height), "width"),
    },
    {
      id: "mapHeight",
      kind: "number",
      label: "Map Height",
      value: tilemap.height,
      min: 1,
      onChange: (value) => commit(resizeTilemap(tilemap, tilemap.width, value), "height"),
    },
    {
      id: "tileWidth",
      kind: "number",
      label: "Tile Width",
      value: tilemap.tileWidth,
      onChange: (value) => commit({ ...tilemap, tileWidth: value }, "tileWidth"),
    },
    {
      id: "tileHeight",
      kind: "number",
      label: "Tile Height",
      value: tilemap.tileHeight,
      onChange: (value) => commit({ ...tilemap, tileHeight: value }, "tileHeight"),
    },
    {
      id: "chunkSize",
      kind: "number",
      label: "Chunk Size",
      value: tilemap.chunkSize,
      min: 1,
      // Every painted cell keeps its place on the new chunk grid.
      onChange: (value) => commit(rechunkTilemap(tilemap, value), "chunkSize"),
    },
  ];
  const layerRows: PropertyRow[] = [];
  if (layer) {
    layerRows.push(
      {
        id: "layer-name",
        kind: "text",
        label: "Layer Name",
        value: layer.name,
        onChange: (name) => patchLayer({ name }),
      },
      {
        id: "layer-visible",
        kind: "boolean",
        label: "Visible",
        value: layer.visible,
        onChange: (visible) => patchLayer({ visible }),
      },
      {
        id: "layer-collision",
        kind: "boolean",
        label: "Collision",
        value: layer.collision,
        onChange: (collision) => patchLayer({ collision }),
      },
      {
        id: "layer-sorting",
        kind: "enum",
        label: "Sorting Layer",
        value: layer.sortingLayer,
        options: sortingLayers.map((name) => ({ value: name, label: name })),
        onChange: (sortingLayer) => patchLayer({ sortingLayer }),
      },
      {
        id: "layer-order",
        kind: "number",
        label: "Order In Layer",
        value: layer.orderInLayer,
        onChange: (orderInLayer) => patchLayer({ orderInLayer }, "orderInLayer"),
      },
      {
        id: "layer-parallax",
        kind: "vector3",
        label: "Parallax",
        value: [layer.parallax.x, layer.parallax.y, 0],
        axes: ["X", "Y"],
        onChange: ([x, y]) => patchLayer({ parallax: { x, y } }, "parallax"),
      },
    );
  }

  return (
    <div className="flex min-h-0 flex-col" data-testid="tilemap-details">
      <PropertySectionTitle
        aside={tilemap.tilesets.length ? <SectionCount value={tilemap.tilesets.length} /> : null}
      >
        Tilesets
      </PropertySectionTitle>
      {tilemap.tilesets.length === 0 ? (
        <p className="px-2 pt-2 text-xs text-muted-foreground">{EMPTY_TILESETS_COPY}</p>
      ) : null}
      <div className="py-1">
      <NamedListEditor
        data-testid="tilemap-tilesets"
        values={tilemap.tilesets.map((entry) => entry.guid)}
        addLabel="Add Tileset"
        onAdd={() => setPickerOpen(true)}
        onChange={(guids) => {
          const remaining = new Set(guids);
          const removed = tilemap.tilesets.find((ref) => !remaining.has(ref.guid));
          if (removed) {
            setRemoveGuid(removed.guid);
            return;
          }
          const byGuid = new Map(tilemap.tilesets.map((ref) => [ref.guid, ref]));
          const tilesets = guids
            .map((guid) => byGuid.get(guid))
            .filter((ref): ref is (typeof tilemap.tilesets)[number] => Boolean(ref));
          commit({ ...tilemap, tilesets });
        }}
        renderItem={({ value }) => {
          const asset = assets.find((entry) => entry.guid === value);
          return (
            <div
              className="flex min-h-[var(--chrome-row,28px)] min-w-0 items-center gap-2 rounded-md px-1.5 text-sm pointer-coarse:min-h-11"
              data-testid={`tilemap-tileset-${value}`}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {selectedPickerIdentity(
                  assetRowIdentity(
                    asset ? { name: asset.name, type: asset.type } : undefined,
                  ),
                  "Tileset",
                )}
              </span>
            </div>
          );
        }}
      />
      <AlertDialog
        open={removeGuid !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveGuid(null);
        }}
      >
        <AlertDialogContent data-testid="tilemap-remove-tileset-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Tileset?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove {assets.find((asset) => asset.guid === removeGuid)?.name ?? "this Tileset"}
              {" "}from this Tilemap and erase its painted tiles from every layer?
              You can undo this change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              onClick={() => {
                if (!removeGuid) return;
                const next = removeTilemapTileset(tilemap, removeGuid);
                commit(next);
                session?.setSelectedTile(null);
                setRemoveGuid(null);
              }}
            >
              Remove Tileset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
      <PropertyGrid title="Map" rows={mapRows} />
      <PropertySectionTitle aside={<SectionCount value={tilemap.layers.length} />}>
        Layers
      </PropertySectionTitle>
      <div className="py-1">
      <NamedListEditor
        data-testid="tilemap-layers"
        values={tilemap.layers.map((entry) => entry.id)}
        addLabel="Add Layer"
        onAdd={() => {
          const next = addTilemapLayer(tilemap);
          const added = next.layers[next.layers.length - 1];
          if (added) setLayerId(added.id);
          commit(next);
        }}
        onChange={(ids) => {
          const next = reorderTilemapLayers(tilemap, ids);
          commit(next);
          if (layer && !next.layers.some((entry) => entry.id === layer.id)) {
            setLayerId(next.layers[0]?.id ?? "layer-1");
          }
        }}
        renderItem={({ value }) => {
          const entry = tilemap.layers.find((layerRow) => layerRow.id === value);
          if (!entry) return null;
          const visibilityLabel = `${entry.visible ? "Hide" : "Show"} ${entry.name} Layer`;
          return (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={value === layer?.id}
                className={cn(
                  "min-w-0 flex-1 justify-start pointer-coarse:min-h-11",
                  value === layer?.id && "bg-accent font-medium text-accent-foreground",
                  !entry.visible && "text-muted-foreground",
                )}
                data-testid={`tilemap-layer-${value}`}
                onClick={() => setLayerId(value)}
              >
                <LayersIcon className="text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground pointer-coarse:size-11"
                aria-label={visibilityLabel}
                title={visibilityLabel}
                data-testid={`tilemap-layer-visibility-${value}`}
                onClick={() => commit({
                  ...tilemap,
                  layers: tilemap.layers.map((item) => item.id === entry.id
                    ? { ...item, visible: !item.visible }
                    : item),
                })}
              >
                {entry.visible ? <EyeIcon /> : <EyeOffIcon />}
              </Button>
            </div>
          );
        }}
      />
      </div>
      {layer ? <PropertyGrid title="Selected Layer" rows={layerRows} /> : null}
      <AssetPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        assets={assets}
        allowedTypes={["Tileset"]}
        allowNone={false}
        title="Pick Tileset"
        onPick={(guid) => {
          void addTileset(guid);
          setPickerOpen(false);
        }}
        data-testid="tilemap-tileset-picker"
      />
    </div>
  );
}

/** One autotile row of the Palette: its fill tile and how many of its variants have a tile. */
interface PaletteAutotile {
  ref: TilemapTilesetRef;
  tileset: TilesetPayload;
  terrainId: string;
  name: string;
  fill: number;
  covered: number;
  total: number;
}

export function TilemapPalette({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange?: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const { tilemap, payloads, loadPayloads } = useTilemapDocument(payload);
  const session = useOptionalTilemapSession();
  const selection = useOptionalTilemapSelection();
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const atlases = useTilesetAtlases(payloads);
  const assets = useRegistryPickerAssets();
  const needle = query.trim().toLowerCase();
  const selectedTerrain = selection?.selectedTerrain ?? null;
  const assetOpen = useAssetOpen();
  const scrollRef = useRef<HTMLDivElement>(null);
  const scroll = useScrollWindow(scrollRef);
  const tilesetName = useCallback(
    (guid: string) => assets.find((asset) => asset.guid === guid)?.name ?? "Tileset",
    [assets],
  );
  // Resolvers and coverage only change with the Tilesets, not per render or per pick.
  const allAutotiles = useMemo(() => tilemap.tilesets.flatMap((ref): PaletteAutotile[] => {
    const tileset = payloads.get(ref.guid);
    if (!tileset) return [];
    return (tileset.terrains ?? []).map((terrain) => {
      const total = terrainVariantMasks(terrain.style).length;
      return {
        ref,
        tileset,
        terrainId: terrain.id,
        name: terrain.name,
        fill: cachedTerrainResolver(tileset, terrain.id, ref.tileCount)?.resolve(terrainFillMask(terrain.style)) ?? 0,
        covered: total - missingTerrainVariants(tileset, terrain.id).length,
        total,
      };
    });
  }), [payloads, tilemap.tilesets]);
  const autotiles = needle
    ? allAutotiles.filter((entry) => tilesetName(entry.ref.guid).toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle))
    : allAutotiles;
  const selectedGid = selectedTerrain ? -1 : selectedTileGid(tilemap, selection?.selectedTile ?? null);
  const selectTile = session?.setSelectedTile;
  const onSelectTile = useCallback((guid: string, localId: number) => selectTile?.({ guid, localId }), [selectTile]);

  const addTilesetToLatest = useAddTileset(tilemap, loadPayloads, assets);
  const addTileset = async (guid: string | null) => {
    const result = await addTilesetToLatest(guid);
    if (!result) return;
    if (result.added) session?.setSelectedTile({ guid: result.added.guid, localId: 1 });
    onChange?.(result.next as unknown as Record<string, unknown>);
  };

  if (tilemap.tilesets.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="tilemap-palette">
        <Empty data-testid="tilemap-palette-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Grid2x2Icon />
            </EmptyMedia>
            <EmptyTitle>No Tiles</EmptyTitle>
            <EmptyDescription>{EMPTY_TILESETS_COPY}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="tilemap-palette-add-tileset"
              onClick={() => setPickerOpen(true)}
            >
              <PlusIcon />
              Add Tileset
            </Button>
          </EmptyContent>
        </Empty>
        <AssetPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          assets={assets}
          allowedTypes={["Tileset"]}
          allowNone={false}
          title="Pick Tileset"
          onPick={(guid) => {
            void addTileset(guid);
            setPickerOpen(false);
          }}
          data-testid="tilemap-palette-tileset-picker"
        />
      </div>
    );
  }

  const severalTilesets = new Set(allAutotiles.map((entry) => entry.ref.guid)).size > 1;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tilemap-palette">
      <div className="flex shrink-0 border-b border-border p-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search Tiles"
          aria-label="Search Tiles"
          data-testid="tilemap-palette-search"
        />
      </div>
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto"
        onScroll={scroll.onScroll}
        data-testid="tilemap-palette-scroll"
      >
        {autotiles.length > 0 ? (
          <section className="flex flex-col" data-testid="tilemap-palette-autotiles">
            <h3 className="sticky top-0 z-10 bg-sidebar px-2 py-1.5 text-xs font-semibold">Autotiles</h3>
            <div role="group" aria-label="Autotiles" className="flex flex-col gap-1 px-2 pb-3">
              {autotiles.map(({ ref, tileset, terrainId, name, fill, covered, total }) => {
                const brush = { guid: ref.guid, terrainId };
                const label = severalTilesets ? `${name} · ${tilesetName(ref.guid)}` : name;
                if (fill === 0) {
                  return (
                    <Button
                      key={`${ref.guid}:${terrainId}`}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto justify-start gap-2 border-dashed py-1 pl-1 text-left font-normal pointer-coarse:min-h-11"
                      disabled={!assetOpen}
                      onClick={() => assetOpen?.openAsset(ref.guid)}
                      data-testid={`tilemap-palette-autotile-setup-${ref.guid}-${terrainId}`}
                    >
                      <span aria-hidden className="size-7 shrink-0 rounded-sm border border-dashed border-border" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{label}</span>
                        <span className="truncate text-xs text-muted-foreground">Set Up in Tileset</span>
                      </span>
                    </Button>
                  );
                }
                const pressed = selectedTerrain !== null && tilemapTerrainKey(selectedTerrain) === tilemapTerrainKey(brush);
                return (
                  <Toggle
                    key={`${ref.guid}:${terrainId}`}
                    variant="outline"
                    size="sm"
                    className="h-auto justify-start gap-2 py-1 pl-1 text-left pointer-coarse:min-h-11"
                    pressed={pressed}
                    onPressedChange={(next) => session?.setSelectedTerrain(next ? brush : null)}
                    data-testid={`tilemap-palette-terrain-${ref.guid}-${terrainId}`}
                  >
                    <TileSprite
                      gid={encodeTileGid(ref.firstGid, fill)}
                      localId={fill}
                      tileset={tileset}
                      atlas={atlases.get(ref.guid) ?? null}
                      className="size-7 shrink-0 rounded-sm"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{label}</span>
                      <span className="truncate text-xs font-normal text-muted-foreground tabular-nums">
                        {covered} of {total}
                      </span>
                    </span>
                  </Toggle>
                );
              })}
            </div>
          </section>
        ) : null}
        {tilemap.tilesets.map((ref) => {
          const tileset = payloads.get(ref.guid);
          if (!tileset) return null;
          const name = tilesetName(ref.guid);
          return (
            <PaletteGroup
              key={ref.guid}
              tilesetRef={ref}
              tileset={tileset}
              name={name}
              needle={needle}
              atlas={atlases.get(ref.guid) ?? null}
              selectedGid={selectedGid}
              onSelectTile={onSelectTile}
              scroll={scroll.view}
            />
          );
        })}
      </div>
    </div>
  );
}

/** The scroll position and height of a scroll container, read once per scroll frame and on resize. */
function useScrollWindow(ref: RefObject<HTMLDivElement | null>) {
  const [view, setView] = useState({ scrollTop: 0, height: 0 });
  const frameRef = useRef<number | null>(null);
  const read = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const next = { scrollTop: element.scrollTop, height: element.clientHeight };
    setView((current) => (current.scrollTop === next.scrollTop && current.height === next.height ? current : next));
  }, [ref]);
  useLayoutEffect(() => {
    read();
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [read, ref]);
  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);
  const onScroll = useCallback(() => {
    if (typeof requestAnimationFrame !== "function") {
      read();
      return;
    }
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      read();
    });
  }, [read]);
  return { view, onScroll };
}

/** Gap between Palette tiles and the group's side padding, in CSS pixels (Tailwind `gap-1`, `px-2`). */
const PALETTE_GAP = 4;
const PALETTE_PADDING = 8;

/**
 * One Tileset's tiles in the Palette. Only the rows in view (plus a few) are
 * mounted, each tile drawing its cell from the one decoded atlas image, so a
 * large sheet costs the tiles on screen, not one element and canvas per tile.
 */
const PaletteGroup = memo(function PaletteGroup({
  tilesetRef,
  tileset,
  name,
  needle,
  atlas,
  selectedGid,
  onSelectTile,
  scroll,
}: {
  tilesetRef: TilemapTilesetRef;
  tileset: TilesetPayload;
  name: string;
  needle: string;
  atlas: HTMLImageElement | null;
  selectedGid: number;
  onSelectTile: (guid: string, localId: number) => void;
  scroll: { scrollTop: number; height: number };
}) {
  const touch = useTouchUi();
  const gridRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ width: 0, top: 0 });
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const next = { width: grid.clientWidth, top: grid.offsetTop };
      setLayout((current) => (current.width === next.width && current.top === next.top ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  });
  const nameMatches = !needle || name.toLowerCase().includes(needle);
  const tiles = useMemo(
    () => (nameMatches ? tileset.tiles : tileset.tiles.filter((tile) => `tile ${tile.id}`.includes(needle))),
    [nameMatches, needle, tileset.tiles],
  );
  if (tiles.length === 0) return null;
  // Columns as `auto-fill` would lay them out, so rows have a known height to window by.
  const minCell = touch ? 44 : 36;
  const inner = Math.max(0, layout.width - 2 * PALETTE_PADDING);
  const columns = inner > 0 ? Math.max(1, Math.floor((inner + PALETTE_GAP) / (minCell + PALETTE_GAP))) : 0;
  const rows = columns > 0 ? Math.ceil(tiles.length / columns) : 1;
  const rowHeight = columns > 0 ? (inner - PALETTE_GAP * (columns - 1)) / columns + PALETTE_GAP : 0;
  const windowed = columns > 0 && scroll.height > 0;
  // Rows in view of the scroll container, measured from this grid's top.
  const slice = windowed
    ? windowedSlice({ itemCount: rows, rowHeight, scrollTop: scroll.scrollTop - layout.top, viewportHeight: scroll.height })
    : { firstIndex: 0, lastIndex: rows };
  const first = windowed ? Math.min(tiles.length, slice.firstIndex * columns) : 0;
  const last = windowed ? Math.max(first, Math.min(tiles.length, slice.lastIndex * columns)) : tiles.length;
  const gridStyle: CSSProperties | undefined = columns > 0
    ? {
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        paddingTop: windowed ? (first / columns) * rowHeight : undefined,
        height: windowed ? rows * rowHeight - PALETTE_GAP + 12 : undefined,
      }
    : undefined;
  return (
    <section className="flex flex-col" data-testid={`tilemap-palette-group-${tilesetRef.guid}`}>
      <h3 className="sticky top-0 z-10 flex items-center gap-1.5 bg-sidebar px-2 py-1.5 text-xs font-semibold">
        <TypeVisualIcon visual={TILESET_VISUAL} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <SectionCount value={tiles.length} />
      </h3>
      <div
        ref={gridRef}
        className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] content-start gap-1 px-2 pb-3 pointer-coarse:grid-cols-[repeat(auto-fill,minmax(var(--touch-target,44px),1fr))]"
        style={gridStyle}
        data-testid={`tilemap-palette-grid-${tilesetRef.guid}`}
      >
        {tiles.slice(first, last).map((tile) => (
          <PaletteTile
            key={tile.id}
            tile={tile}
            tilesetRef={tilesetRef}
            tileset={tileset}
            atlas={atlas}
            selected={selectedGid === encodeTileGid(tilesetRef.firstGid, tile.id)}
            onSelectTile={onSelectTile}
          />
        ))}
      </div>
    </section>
  );
});

const PaletteTile = memo(function PaletteTile({
  tile,
  tilesetRef,
  tileset,
  atlas,
  selected,
  onSelectTile,
}: {
  tile: TilesetTile;
  tilesetRef: TilemapTilesetRef;
  tileset: TilesetPayload;
  atlas: HTMLImageElement | null;
  selected: boolean;
  onSelectTile: (guid: string, localId: number) => void;
}) {
  const gid = encodeTileGid(tilesetRef.firstGid, tile.id);
  return (
    <TileThumb
      gid={gid}
      localId={tile.id}
      tileset={tileset}
      atlas={atlas}
      selected={selected}
      onSelect={() => onSelectTile(tilesetRef.guid, tile.id)}
      testId={`tilemap-palette-tile-${gid}`}
    />
  );
});

export function TilemapPaint({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const { tilemap, payloads, loadPayloads } = useTilemapDocument(payload);
  const latestRef = useRef(tilemap);
  useEffect(() => {
    latestRef.current = tilemap;
  }, [tilemap]);
  const session = useOptionalTilemapSession();
  const selection = useOptionalTilemapSelection();
  const [localTile, setLocalTile] = useState<TilemapTileSelection>(null);
  const selectedTerrain = selection?.selectedTerrain ?? null;
  const selectedGid = selectedTileGid(tilemap, session ? selection?.selectedTile ?? null : localTile);
  const setSelectedGid = (gid: number) => {
    const tile = gid === 0 ? { guid: "", localId: 0 } : tilemapTileIdentity(tilemap, gid);
    if (session) session.setSelectedTile(tile);
    else setLocalTile(tile);
  };
  const [layerOpen, setLayerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tool, setTool] = useState<TilemapPaintTool>("move");
  // Picking an autotile means painting it: leave Move or Picker for the Brush.
  const [seenTerrain, setSeenTerrain] = useState(selectedTerrain);
  if (selectedTerrain !== seenTerrain) {
    setSeenTerrain(selectedTerrain);
    if (selectedTerrain && (tool === "move" || tool === "picker")) setTool("brush");
  }
  const { layer, setLayerId } = usePaintLayer(tilemap);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cellSize, setCellSize] = useState(DEFAULT_PAINT_CELL_SIZE);
  const [cssSize, setCssSize] = useState({ width: 256, height: 256 });
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pendingPickerRef = useRef<{ x: number; y: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchStartRef = useRef<{
    panX: number;
    panY: number;
    cellSize: number;
    spread: number;
    midX: number;
    midY: number;
  } | null>(null);
  const panDragRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const pinchActiveRef = useRef(false);
  const strokeRef = useRef<{ id: string; stroke: TilemapStroke } | null>(null);
  const [hoverStore] = useState(() => new HoverCellStore());
  // The stroke in progress draws from local state, so only this canvas
  // re-renders per frame; the document receives one edit when it ends.
  const [strokePreview, setStrokePreview] = useState<{ map: TilemapPayload; shape: TilemapStrokeShape | null } | null>(null);
  const shown = strokePreview?.map ?? tilemap;
  // Gestures move the view here per pointer event; the state that draws it
  // follows once per animation frame, or at once on release or wheel.
  const viewRef = useRef({ pan, cellSize });
  const viewFrameRef = useRef<number | null>(null);
  const flushView = () => {
    if (viewFrameRef.current !== null) {
      cancelAnimationFrame(viewFrameRef.current);
      viewFrameRef.current = null;
    }
    setPan(viewRef.current.pan);
    setCellSize(viewRef.current.cellSize);
  };
  const moveView = (next: { pan: { x: number; y: number }; cellSize: number }) => {
    viewRef.current = next;
    if (viewFrameRef.current !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      flushView();
      return;
    }
    viewFrameRef.current = requestAnimationFrame(() => {
      viewFrameRef.current = null;
      flushView();
    });
  };
  // Pointer moves of a stroke land in the stroke at once and show once per frame.
  const strokeFrameRef = useRef<number | null>(null);
  const showStroke = () => {
    if (strokeFrameRef.current !== null) {
      cancelAnimationFrame(strokeFrameRef.current);
      strokeFrameRef.current = null;
    }
    const active = strokeRef.current?.stroke;
    if (!active) return;
    const painted = active.flush();
    latestRef.current = painted;
    setStrokePreview({ map: painted, shape: active.shape });
  };
  const scheduleStroke = () => {
    if (strokeFrameRef.current !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      showStroke();
      return;
    }
    strokeFrameRef.current = requestAnimationFrame(() => {
      strokeFrameRef.current = null;
      showStroke();
    });
  };
  useEffect(
    () => () => {
      if (viewFrameRef.current !== null) cancelAnimationFrame(viewFrameRef.current);
      if (strokeFrameRef.current !== null) cancelAnimationFrame(strokeFrameRef.current);
    },
    [],
  );
  const atlases = useTilesetAtlases(payloads);
  const assets = useRegistryPickerAssets();
  const { projectDocument } = useProjectState();
  const sortingLayers = projectDocument?.settings.twoD.sortingLayers ?? DEFAULT_SORTING_LAYERS;
  const decoded = decodeTileGid(tilemap, selectedGid, payloads);
  const localTileId = decoded?.localId ?? selectedGid;
  // A terrain brush paints only while its Tileset is on the map and has tiles for it.
  const terrainBrush = useMemo(() => {
    const brush = selectedTerrain;
    const ref = brush ? tilemap.tilesets.find((entry) => entry.guid === brush.guid) : undefined;
    const tileset = brush ? payloads.get(brush.guid) : undefined;
    const terrain = brush && tileset ? tilesetTerrainById(tileset, brush.terrainId) : null;
    const preview = brush && tileset && ref ? cachedTerrainResolver(tileset, brush.terrainId, ref.tileCount)?.resolve(0) : 0;
    if (!brush || !ref || !tileset || !terrain || !preview) return null;
    return { brush, terrain, tileset, gid: encodeTileGid(ref.firstGid, preview), localId: preview };
  }, [selectedTerrain, payloads, tilemap.tilesets]);
  const [renderer] = useState(() => new TilemapPaintRenderer(createBrowserPaintSurface));
  useEffect(() => () => renderer.dispose(), [renderer]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const apply = () => {
      const width = Math.max(1, host.clientWidth || 256);
      const height = Math.max(1, host.clientHeight || 256);
      setCssSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(host);
    return () => observer.disconnect();
  }, [tilemap.tilesets.length]);

  const shape = strokePreview?.shape ?? null;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    renderer.draw(ctx, {
      cssWidth: cssSize.width,
      cssHeight: cssSize.height,
      dpr,
      tilemap: shown,
      pan,
      cellSize,
      payloads,
      atlases,
      sortingLayers,
      preview: shape,
    });
  }, [atlases, cellSize, cssSize, pan, payloads, renderer, shape, shown, sortingLayers]);

  // React attaches wheel listeners as passive, which ignore preventDefault, so
  // the canvas keeps a native non-passive listener that runs the latest handler.
  const wheelRef = useRef<(event: WheelEvent) => void>(() => {});
  wheelRef.current = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const view = applyWheelZoom({
      panX: viewRef.current.pan.x,
      panY: viewRef.current.pan.y,
      cellSize: viewRef.current.cellSize,
      originX: event.clientX - rect.left,
      originY: event.clientY - rect.top,
      canvasHeight: rect.height || cssSize.height,
      deltaY: event.deltaY,
    });
    viewRef.current = { pan: { x: view.panX, y: view.panY }, cellSize: view.cellSize };
    flushView();
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => wheelRef.current(event);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [tilemap.tilesets.length]);

  const cellAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const height = rect.height || cssSize.height;
    return paintCanvasTileAt({
      localX: clientX - rect.left,
      localY: clientY - rect.top,
      canvasHeight: height,
      panX: viewRef.current.pan.x,
      panY: viewRef.current.pan.y,
      cellSize: viewRef.current.cellSize,
    });
  };

  /** Commit the stroke in progress as one document edit, if it changed anything. */
  const finishStroke = () => {
    const active = strokeRef.current;
    strokeRef.current = null;
    if (strokeFrameRef.current !== null) {
      cancelAnimationFrame(strokeFrameRef.current);
      strokeFrameRef.current = null;
    }
    setStrokePreview(null);
    if (!active) return;
    const painted = active.stroke.finish();
    latestRef.current = painted;
    if (painted === active.stroke.base) return;
    onChange(
      painted as unknown as Record<string, unknown>,
      tilemapStrokeMergeKey(active.id),
    );
  };

  /** Drop the stroke in progress without editing the document. */
  const cancelStroke = () => {
    const active = strokeRef.current;
    if (!active) return;
    strokeRef.current = null;
    if (strokeFrameRef.current !== null) {
      cancelAnimationFrame(strokeFrameRef.current);
      strokeFrameRef.current = null;
    }
    latestRef.current = active.stroke.base;
    setStrokePreview(null);
  };

  const startStroke = (cell: { x: number; y: number }) => {
    if (!layer || !isTilemapPaintStrokeTool(tool)) return;
    if (!terrainBrush && tool !== "eraser" && (selectedGid < 0 || (selectedGid > 0 && !decoded))) return;
    // A stroke whose release never arrived (lost capture) still lands.
    finishStroke();
    const stroke = new TilemapStroke(latestRef.current, {
      tool,
      layerId: layer.id,
      gid: selectedGid,
      terrain: terrainBrush?.brush,
      tilesets: payloads,
      start: cell,
    });
    strokeRef.current = { id: newStrokeId(), stroke };
    scheduleStroke();
  };

  /** The Picker takes an autotile cell's autotile as the brush, any other cell's tile. */
  const pickCell = (cell: { x: number; y: number }) => {
    if (!layer) return;
    const gid = pickTileId(tilemap, layer.id, cell.x, cell.y);
    const identity = gid > 0 ? tilemapTileIdentity(tilemap, gid) : null;
    const tileset = identity ? payloads.get(identity.guid) : undefined;
    const terrainId = identity && tileset ? tilesetTileById(tileset, identity.localId)?.terrain?.id : undefined;
    if (session && identity && tileset && terrainId && tilesetTerrainById(tileset, terrainId)) {
      session.setSelectedTile(identity);
      session.setSelectedTerrain({ guid: identity.guid, terrainId });
      return;
    }
    setSelectedGid(gid);
  };

  const addTilesetToLatest = useAddTileset(tilemap, loadPayloads, assets);
  const addTileset = async (guid: string | null) => {
    const result = await addTilesetToLatest(guid);
    if (!result) return;
    if (result.added) {
      const tile = { guid: result.added.guid, localId: 1 };
      if (session) session.setSelectedTile(tile);
      else setLocalTile(tile);
    }
    onChange(result.next as unknown as Record<string, unknown>);
  };

  if (tilemap.tilesets.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="tilemap-editor">
        <Empty data-testid="tilemap-paint-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BrushIcon />
            </EmptyMedia>
            <EmptyTitle>No Tilesets</EmptyTitle>
            <EmptyDescription>{EMPTY_TILESETS_COPY}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="tilemap-paint-add-tileset"
              onClick={() => setPickerOpen(true)}
            >
              <PlusIcon />
              Add Tileset
            </Button>
          </EmptyContent>
        </Empty>
        <AssetPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          assets={assets}
          allowedTypes={["Tileset"]}
          allowNone={false}
          title="Pick Tileset"
          onPick={(guid) => {
            void addTileset(guid);
            setPickerOpen(false);
          }}
          data-testid="tilemap-paint-tileset-picker"
        />
      </div>
    );
  }

  const layerHidden = layer ? !layer.visible : false;
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden" data-testid="tilemap-editor">
      <ToolbarStrip className="shrink-0 gap-2 py-1" data-testid="tilemap-paint-toolbar">
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[tool]}
          onValueChange={(value) => {
            const next = value[0] as TilemapPaintTool | undefined;
            if (next) setTool(next);
          }}
          aria-label="Tilemap paint tool"
          data-testid="tilemap-paint-tools"
        >
          {TOOLS.map((entry) => {
            const Icon = entry.icon;
            return (
              <Tooltip key={entry.id}>
              <TooltipTrigger render={<ToggleGroupItem
                value={entry.id}
                aria-label={entry.label}
                className={TOOL_ITEM}
                data-testid={`tilemap-tool-${entry.id}`}
              >
                <Icon />
                {entry.id === "move" ? <span>{entry.label}</span> : null}
              </ToggleGroupItem>} />
              <TooltipContent>{entry.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </ToggleGroup>
        <Separator orientation="vertical" className="my-1" />
        <SearchDropdown
          open={layerOpen}
          onOpenChange={setLayerOpen}
          title="Paint Layer"
          description="Choose which tilemap layer the brush writes."
          items={tilemap.layers.map((entry) => ({
            id: entry.id,
            label: entry.name,
            description: entry.visible ? "Visible" : "Hidden",
          }))}
          onSelect={(id) => setLayerId(id)}
          data-testid="tilemap-paint-layer-menu"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Paint Layer: ${layer?.name ?? "Layer"}${layerHidden ? " (Hidden)" : ""}`}
            className={cn("max-w-48 pointer-coarse:min-h-11", layerHidden && "text-muted-foreground")}
            data-testid="tilemap-paint-layer"
            data-hidden={layerHidden ? "true" : undefined}
          >
            {layerHidden ? <EyeOffIcon /> : <LayersIcon />}
            <span className="truncate">{layer?.name ?? "Layer"}</span>
            <ChevronDownIcon className="text-muted-foreground" />
          </Button>
        </SearchDropdown>
        {layerHidden ? (
          <span className="shrink-0 text-xs text-muted-foreground" data-testid="tilemap-paint-layer-hidden">
            Layer Hidden
          </span>
        ) : null}
        <Separator orientation="vertical" className="my-1" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {terrainBrush ? (
            <TileSprite
              gid={terrainBrush.gid}
              localId={terrainBrush.localId}
              tileset={terrainBrush.tileset}
              atlas={atlases.get(terrainBrush.brush.guid) ?? null}
              className="size-7 rounded-sm ring-1 ring-border pointer-coarse:size-11"
            />
          ) : (
            <TileThumb
              gid={selectedGid}
              localId={localTileId}
              tileset={decoded?.tileset}
              atlas={decoded ? atlases.get(decoded.guid) ?? null : null}
              selected={false}
              onSelect={() => {}}
              className="size-7 pointer-coarse:size-11"
              testId="tilemap-selected-tile"
            />
          )}
          <span
            className="truncate text-xs text-muted-foreground"
            data-testid="tilemap-selected-label"
          >
            {terrainBrush
              ? `${
                  assets.find((asset) => asset.guid === terrainBrush.brush.guid)?.name ??
                  "Tileset"
                } · ${terrainBrush.terrain.name}`
              : decoded
                ? `${
                    assets.find((asset) => asset.guid === decoded.guid)?.name ??
                    "Tileset"
                  } · Tile ${localTileId}`
                : `GID ${selectedGid}`}
          </span>
          <HoverCellReadout store={hoverStore} />
        </div>
      </ToolbarStrip>
      <div ref={hostRef} className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 size-full touch-none bg-background"
          data-testid="tilemap-paint-canvas"
          data-tool={tool}
          data-tile={String(localTileId)}
          data-gid={String(selectedGid)}
          data-terrain={terrainBrush ? terrainBrush.terrain.id : undefined}
          data-cell-size={String(cellSize)}
          data-zoom={String(cellSize / DEFAULT_PAINT_CELL_SIZE)}
          data-pan-x={String(pan.x)}
          data-pan-y={String(pan.y)}
          data-paint-source={atlases.size > 0 ? "atlas" : "hsl"}
          onPointerDown={(event) => {
            event.preventDefault();
            const pointerId = pointerIdOf(event);
            try {
              event.currentTarget.setPointerCapture?.(pointerId);
            } catch {
              // Synthetic PointerEvents (Playwright / jsdom) have no active pointer.
            }
            pointersRef.current.set(pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            if (pointersRef.current.size >= 2) {
              cancelStroke();
              panDragRef.current = null;
              pendingPickerRef.current = null;
              pinchActiveRef.current = true;
              const points = [...pointersRef.current.values()];
              const spread = Math.hypot(
                points[0]!.x - points[1]!.x,
                points[0]!.y - points[1]!.y,
              );
              pinchStartRef.current = {
                panX: viewRef.current.pan.x,
                panY: viewRef.current.pan.y,
                cellSize: viewRef.current.cellSize,
                spread: Math.max(1, spread),
                midX: (points[0]!.x + points[1]!.x) / 2,
                midY: (points[0]!.y + points[1]!.y) / 2,
              };
              return;
            }
            pinchActiveRef.current = false;
            if (tool === "move") {
              panDragRef.current = {
                pointerId,
                lastX: event.clientX,
                lastY: event.clientY,
              };
              return;
            }
            const cell = cellAt(event.clientX, event.clientY);
            if (!cell || !layer) return;
            hoverStore.set(cell, tilemap);
            if (tool === "picker") {
              // Defer until pointerup so a second-finger pinch keeps the palette GID.
              pendingPickerRef.current = cell;
              return;
            }
            startStroke(cell);
          }}
          onPointerMove={(event) => {
            const pointerId = pointerIdOf(event);
            const tracked = pointersRef.current.get(pointerId);
            if (!tracked) {
              // A hovering mouse reads out the cell under it.
              if (event.pointerType === "mouse") {
                const cell = cellAt(event.clientX, event.clientY);
                if (cell) hoverStore.set(cell, tilemap);
              }
              return;
            }
            pointersRef.current.set(pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            if (pointersRef.current.size >= 2) {
              const points = [...pointersRef.current.values()];
              const spread = Math.hypot(
                points[0]!.x - points[1]!.x,
                points[0]!.y - points[1]!.y,
              );
              const midX = (points[0]!.x + points[1]!.x) / 2;
              const midY = (points[0]!.y + points[1]!.y) / 2;
              const start = pinchStartRef.current;
              const canvas = canvasRef.current;
              if (!start || !canvas) return;
              const rect = canvas.getBoundingClientRect();
              const view = applyPinchView({
                panX: start.panX,
                panY: start.panY,
                cellSize: start.cellSize,
                originX: start.midX - rect.left,
                originY: start.midY - rect.top,
                canvasHeight: rect.height || cssSize.height,
                spreadRatio: spread / start.spread,
                translationX: midX - start.midX,
                // Screen Y points down; the tilemap pan is in +Y-up space.
                translationY: start.midY - midY,
              });
              moveView({ pan: { x: view.panX, y: view.panY }, cellSize: view.cellSize });
              return;
            }
            if (pinchActiveRef.current) return;
            const drag = panDragRef.current;
            if (drag && drag.pointerId === pointerId) {
              const dx = event.clientX - drag.lastX;
              const dy = event.clientY - drag.lastY;
              drag.lastX = event.clientX;
              drag.lastY = event.clientY;
              const next = applyPointerPan({
                panX: viewRef.current.pan.x,
                panY: viewRef.current.pan.y,
                dx,
                dy: -dy,
              });
              moveView({
                pan: { x: next.panX, y: next.panY },
                cellSize: viewRef.current.cellSize,
              });
              return;
            }
            const cell = cellAt(event.clientX, event.clientY);
            if (!cell) return;
            hoverStore.set(cell, tilemap);
            // A move inside the stroke's last cell changes nothing.
            if (strokeRef.current?.stroke.moveTo(cell)) scheduleStroke();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse" && !pointersRef.current.size) hoverStore.set(null, tilemap);
          }}
          onPointerUp={(event) => {
            const pointerId = pointerIdOf(event);
            if (viewFrameRef.current !== null) flushView();
            pointersRef.current.delete(pointerId);
            if (panDragRef.current?.pointerId === pointerId) {
              panDragRef.current = null;
            }
            if (pointersRef.current.size < 2) pinchStartRef.current = null;
            if (pointersRef.current.size === 0) {
              const pending = pendingPickerRef.current;
              pendingPickerRef.current = null;
              if (
                pending &&
                !pinchActiveRef.current &&
                tool === "picker" &&
                layer
              ) {
                pickCell(pending);
              }
              finishStroke();
              pinchActiveRef.current = false;
            }
          }}
          onPointerCancel={(event) => {
            const pointerId = pointerIdOf(event);
            if (viewFrameRef.current !== null) flushView();
            pointersRef.current.delete(pointerId);
            if (panDragRef.current?.pointerId === pointerId) {
              panDragRef.current = null;
            }
            if (pointersRef.current.size < 2) pinchStartRef.current = null;
            if (pointersRef.current.size === 0) {
              pendingPickerRef.current = null;
              finishStroke();
              pinchActiveRef.current = false;
            }
          }}
        />
      </div>
    </div>
  );
}

/**
 * The map cell under the pointer, kept outside React state so a hovering
 * mouse re-renders only its readout, once per cell it enters.
 */
class HoverCellStore {
  private cell: { x: number; y: number } | null = null;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.cell;

  /** `cell` when it is inside `map`, else nothing. */
  set(cell: { x: number; y: number } | null, map: TilemapPayload): void {
    const next = cell && tileInBounds(map, cell.x, cell.y) ? cell : null;
    if (next?.x === this.cell?.x && next?.y === this.cell?.y) return;
    this.cell = next ? { x: next.x, y: next.y } : null;
    for (const listener of [...this.listeners]) listener();
  }
}

function HoverCellReadout({ store }: { store: HoverCellStore }) {
  const cell = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (!cell) return null;
  return (
    <span
      className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
      data-testid="tilemap-paint-hover-cell"
      aria-label={`Cell ${cell.x}, ${cell.y}`}
    >
      {cell.x}, {cell.y}
    </span>
  );
}

function TileThumb({
  gid,
  localId,
  tileset,
  atlas,
  selected,
  onSelect,
  testId,
  className,
}: {
  gid: number;
  localId: number;
  tileset?: TilesetPayload;
  atlas: HTMLImageElement | null;
  selected: boolean;
  onSelect: (gid: number) => void;
  testId: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "aspect-square w-full min-w-0 overflow-hidden rounded-sm ring-1 ring-border outline-none hover:ring-foreground/40 focus-visible:ring-2 focus-visible:ring-ring data-[selected=true]:ring-2 data-[selected=true]:ring-(--graph-state-selected) data-[selected=true]:ring-offset-1 data-[selected=true]:ring-offset-sidebar",
        className,
      )}
      data-testid={testId}
      data-gid={String(gid)}
      data-tile={String(localId)}
      data-selected={selected ? "true" : "false"}
      aria-label={`Tile ${localId}`}
      aria-pressed={selected}
      onClick={() => onSelect(gid)}
    >
      <TileSprite gid={gid} localId={localId} tileset={tileset} atlas={atlas} className="size-full" />
    </button>
  );
}

/**
 * One atlas cell drawn pixelated from the shared decoded atlas image as a CSS
 * sprite (percentages, so it fills any size), or its placeholder colour while
 * the atlas is missing. No canvas or copy of the image per tile.
 */
function TileSprite({
  gid,
  localId,
  tileset,
  atlas,
  className,
}: {
  gid: number;
  localId: number;
  tileset?: TilesetPayload;
  atlas: HTMLImageElement | null;
  className?: string;
}) {
  const rect = tileset ? tilesetTileRect(tileset, localId) : null;
  let style: CSSProperties;
  if (atlas && rect && tileset && atlas.naturalWidth > 0) {
    const width = atlas.naturalWidth;
    const height = atlas.naturalHeight || tileset.atlasHeight;
    const percent = (offset: number, cell: number, size: number) => (size > cell ? `${(offset / (size - cell)) * 100}%` : "0%");
    style = {
      backgroundImage: `url(${atlas.src})`,
      backgroundRepeat: "no-repeat",
      backgroundSize: `${(width / rect.width) * 100}% ${(height / rect.height) * 100}%`,
      backgroundPosition: `${percent(rect.x, rect.width, width)} ${percent(rect.y, rect.height, height)}`,
      imageRendering: "pixelated",
    };
  } else {
    style = { backgroundColor: localId <= 0 ? "oklch(0.25 0 0)" : placeholderCss(gid) };
  }
  return <span aria-hidden className={cn("block shrink-0", className)} style={style} data-tile-sprite={localId} />;
}

function selectedTileGid(
  tilemap: TilemapPayload,
  selected: TilemapTileSelection,
): number {
  if (!selected) return tilemap.tilesets[0]?.firstGid ?? 0;
  if (selected.localId === 0) return 0;
  const ref = tilemap.tilesets.find((entry) => entry.guid === selected.guid);
  if (!ref || selected.localId > ref.tileCount) return -1;
  return encodeTileGid(ref.firstGid, selected.localId);
}

/** Picker rows for every indexed asset, rebuilt when the registry changes rather than per edit. */
function useRegistryPickerAssets() {
  const { assetRegistry, registryEpoch } = useRegistryState();
  return useMemo(() => {
    void registryEpoch;
    return (assetRegistry?.list() ?? []).map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));
  }, [assetRegistry, registryEpoch]);
}

const TILESET_KINDS = ["tileset"] as const;

/**
 * Payloads of the Tilesets `tilemap` references. A Tilemap document's panels
 * share its provider's loader; a panel rendered without one keeps its own.
 */
function useLoadedTilesets(
  tilemap: TilemapPayload,
) {
  const { loadAssetDocument } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const tilesetDocuments = useOpenDocumentsOfKinds(TILESET_KINDS);
  const sharedLoader = useOptionalTilemapSession()?.tilesetLoader;
  const [ownLoader] = useState(() => new TilesetPayloadLoader());
  const loader = sharedLoader ?? ownLoader;
  const resolved = resolveTilesetSources(
    tilemapTilesetGuids(tilemap),
    assetRegistry,
    tilesetDocuments,
  );
  // Every Tileset edit publishes a new list. Keep the same sources, and skip
  // the load effect, until a referenced Tileset changes.
  const [sources, setSources] = useState(resolved);
  if (!sameTilesetSources(sources, resolved)) setSources(resolved);
  useEffect(() => {
    loader.request(sources, loadAssetDocument);
  }, [loadAssetDocument, loader, sources]);
  const payloads = useSyncExternalStore(loader.subscribe, loader.getSnapshot);
  const loadPayloads = useCallback(
    () => loadTilesetPayloads(sources, loadAssetDocument),
    [loadAssetDocument, sources],
  );
  return { payloads, loadPayloads };
}

/**
 * Adds a picked Tileset. The Tileset document and the referenced Tilesets load
 * first, so the edit is built on the tilemap as it is when they finish rather
 * than on the render that opened the picker. Returns that base with the edit.
 */
function useAddTileset(
  tilemap: TilemapPayload,
  loadPayloads: ReturnType<typeof useLoadedTilesets>["loadPayloads"],
  assets: ReturnType<typeof useRegistryPickerAssets>,
) {
  const { loadAssetDocument } = useDocumentActions();
  const latestRef = useRef({ tilemap, loadPayloads });
  latestRef.current = { tilemap, loadPayloads };
  return async (guid: string | null) => {
    if (!guid) return null;
    const asset = assets.find((entry) => entry.guid === guid);
    const raw =
      asset && loadAssetDocument
        ? await loadAssetDocument("tileset", asset.path)
        : {};
    const known = await latestRef.current.loadPayloads();
    const base = latestRef.current.tilemap;
    const next = addTilemapTileset(base, guid, normalizeTilesetPayload(raw ?? {}), known);
    return { base, next, added: next.tilesets[next.tilesets.length - 1] };
  };
}

/**
 * Decoded atlas images of the loaded Tilesets, by Tileset guid. A Tilemap
 * document's Palette and Paint share its provider's loader, so each Texture is
 * read and decoded once; a panel rendered without one keeps its own.
 */
function useTilesetAtlases(
  payloads: ReadonlyMap<string, TilesetPayload>,
): ReadonlyMap<string, HTMLImageElement> {
  const { readAssetChunk } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const shared = useOptionalTilemapSession()?.atlasLoader;
  const [own] = useState(() => new TilesetAtlasLoader());
  const loader = shared ?? own;
  useEffect(() => {
    if (shared) return;
    return () => own.dispose();
  }, [own, shared]);
  useEffect(() => {
    void registryEpoch;
    loader.request(payloads, assetRegistry, readAssetChunk);
  }, [assetRegistry, loader, payloads, readAssetChunk, registryEpoch]);
  return useSyncExternalStore(loader.subscribe, loader.getSnapshot);
}

function pointerIdOf(event: { pointerId?: number; nativeEvent?: { pointerId?: number } }): number {
  const native = event.nativeEvent;
  if (typeof native?.pointerId === "number") return native.pointerId;
  return typeof event.pointerId === "number" ? event.pointerId : 0;
}

function newStrokeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function SectionCount({ value }: { value: number }) {
  return (
    <span className="rounded-md bg-muted px-1.5 text-[0.7rem] font-normal text-muted-foreground tabular-nums">
      {value}
    </span>
  );
}
