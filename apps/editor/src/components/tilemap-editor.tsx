import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  EraserIcon,
  HandIcon,
  PaintBucketIcon,
  PencilIcon,
  PipetteIcon,
  SquareIcon,
  StampIcon,
} from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import {
  AssetPicker,
  NamedListEditor,
  PanelFrame,
  PropertyGrid,
  SearchDropdown,
  SearchInput,
  assetRowIdentity,
  selectedPickerIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  addTilemapLayer,
  addTilemapTileset,
  applyPinchView,
  applyPointerPan,
  applyTilemapPaint,
  applyWheelZoom,
  cellsAlongSegment,
  decodeTileGid,
  DEFAULT_PAINT_CELL_SIZE,
  encodeTileGid,
  ensureTilesetTiles,
  isTilemapPaintStrokeTool,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  paintCanvasTileAt,
  pickTileId,
  removeTilemapTileset,
  reorderTilemapLayers,
  resizeTilemap,
  tilemapStrokeMergeKey,
  tilemapTilesetGuids,
  tilesetTileRect,
  type TilemapPaintTool,
  type TilemapLayer,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  useOptionalTilemapEditing,
  TilemapEditingProvider,
} from "../context/tilemap-editing-context";

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

export function TilemapPaintPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="tilemap-paint-panel">
      <TilemapPaint
        payload={payload}
        onChange={(next, mergeKey) => {
          void applyAssetDocumentChange(documentId, next, mergeKey);
        }}
      />
    </PanelFrame>
  );
}

export function TilemapPalettePanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="tilemap-palette-panel">
      <TilemapPalette
        payload={payload}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}

export function TilemapDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="tilemap-details-panel" title="Details">
      <TilemapDetails
        payload={payload}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}

export function TilemapEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  return (
    <TilemapEditingProvider>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <TilemapDetails payload={payload} onChange={onChange} />
        <TilemapPalette payload={payload} onChange={onChange} />
        <TilemapPaint payload={payload} onChange={onChange} />
      </div>
    </TilemapEditingProvider>
  );
}

export function TilemapDetails({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const tilemap = normalizeTilemapPayload(payload);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedLayerId, setSelectedLayerId] = useState(
    tilemap.layers[0]?.id ?? "layer-1",
  );
  const editing = useOptionalTilemapEditing();
  const { assetRegistry, projectDocument, loadAssetDocument } = useDocuments();
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const sortingLayers = projectDocument?.settings.twoD.sortingLayers ?? [
    "Background",
    "Default",
    "Foreground",
    "UI",
  ];
  const layer =
    tilemap.layers.find((entry) => entry.id === selectedLayerId) ??
    tilemap.layers[0];

  const commit = (next: TilemapPayload) => {
    onChange(next as unknown as Record<string, unknown>);
  };

  const patchLayer = (patch: Partial<TilemapLayer>) => {
    if (!layer) return;
    commit({
      ...tilemap,
      layers: tilemap.layers.map((entry) =>
        entry.id === layer.id ? { ...entry, ...patch } : entry,
      ),
    });
  };

  const addTileset = async (guid: string | null) => {
    if (!guid) return;
    const asset = assets.find((entry) => entry.guid === guid);
    const raw =
      asset && loadAssetDocument
        ? await loadAssetDocument("tileset", asset.path)
        : {};
    const next = addTilemapTileset(
      tilemap,
      guid,
      normalizeTilesetPayload(raw ?? {}),
    );
    const added = next.tilesets[next.tilesets.length - 1];
    if (added && editing && tilemap.tilesets.length === 0) {
      editing.setSelectedGid(added.firstGid);
    }
    commit(next);
  };

  const rows: PropertyRow[] = [
    {
      id: "mapWidth",
      kind: "number",
      label: "Map Width",
      value: tilemap.width,
      min: 1,
      onChange: (value) => commit(resizeTilemap(tilemap, value, tilemap.height)),
    },
    {
      id: "mapHeight",
      kind: "number",
      label: "Map Height",
      value: tilemap.height,
      min: 1,
      onChange: (value) => commit(resizeTilemap(tilemap, tilemap.width, value)),
    },
    {
      id: "tileWidth",
      kind: "number",
      label: "Tile Width",
      value: tilemap.tileWidth,
      onChange: (value) => commit({ ...tilemap, tileWidth: value }),
    },
    {
      id: "tileHeight",
      kind: "number",
      label: "Tile Height",
      value: tilemap.tileHeight,
      onChange: (value) => commit({ ...tilemap, tileHeight: value }),
    },
    {
      id: "chunkSize",
      kind: "number",
      label: "Chunk Size",
      value: tilemap.chunkSize,
      onChange: (value) => commit({ ...tilemap, chunkSize: value }),
    },
  ];
  if (layer) {
    rows.push(
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
        onChange: (orderInLayer) => patchLayer({ orderInLayer }),
      },
      {
        id: "layer-parallax",
        kind: "vector3",
        label: "Parallax",
        value: [layer.parallax.x, layer.parallax.y, 0],
        axes: ["X", "Y"],
        onChange: ([x, y]) => patchLayer({ parallax: { x, y } }),
      },
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="tilemap-details">
      <NamedListEditor
        title="Tilesets"
        data-testid="tilemap-tilesets"
        values={tilemap.tilesets.map((entry) => entry.guid)}
        addLabel="Add Tileset"
        onAdd={() => setPickerOpen(true)}
        onChange={(guids) => {
          const remaining = new Set(guids);
          let next = tilemap;
          for (const ref of tilemap.tilesets) {
            if (!remaining.has(ref.guid)) {
              next = removeTilemapTileset(next, ref.guid);
            }
          }
          const byGuid = new Map(next.tilesets.map((ref) => [ref.guid, ref]));
          const tilesets = guids
            .map((guid) => byGuid.get(guid))
            .filter((ref): ref is (typeof next.tilesets)[number] => Boolean(ref));
          commit({
            ...next,
            tilesets,
            tilesetGuid: tilesets[0]?.guid ?? null,
          });
        }}
        renderItem={({ value }) => {
          const asset = assets.find((entry) => entry.guid === value);
          return (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto min-h-[var(--touch-target,44px)] w-full justify-start"
              data-testid={`tilemap-tileset-${value}`}
            >
              {selectedPickerIdentity(
                assetRowIdentity(
                  asset ? { name: asset.name, type: asset.type } : undefined,
                ),
                "Tileset",
              )}
            </Button>
          );
        }}
      />
      {tilemap.tilesets.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">{EMPTY_TILESETS_COPY}</p>
      ) : null}
      <PropertyGrid rows={rows} />
      <NamedListEditor
        title="Layers"
        data-testid="tilemap-layers"
        values={tilemap.layers.map((entry) => entry.id)}
        addLabel="Add Layer"
        onAdd={() => {
          const next = addTilemapLayer(tilemap);
          const added = next.layers[next.layers.length - 1];
          if (added) setSelectedLayerId(added.id);
          commit(next);
        }}
        onChange={(ids) => {
          const next = reorderTilemapLayers(tilemap, ids);
          commit(next);
          if (!next.layers.some((entry) => entry.id === selectedLayerId)) {
            setSelectedLayerId(next.layers[0]?.id ?? "layer-1");
          }
        }}
        renderItem={({ value }) => {
          const entry = tilemap.layers.find((layerRow) => layerRow.id === value);
          return (
            <Button
              type="button"
              variant={value === selectedLayerId ? "default" : "outline"}
              size="sm"
              className="w-full justify-start"
              data-testid={`tilemap-layer-${value}`}
              onClick={() => setSelectedLayerId(value)}
            >
              {entry?.name ?? value}
            </Button>
          );
        }}
      />
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

export function TilemapPalette({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange?: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const tilemap = normalizeTilemapPayload(payload);
  const editing = useOptionalTilemapEditing();
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const { assetRegistry, loadAssetDocument } = useDocuments();
  const payloads = useLoadedTilesets(tilemap);
  const atlases = useTilesetAtlases(payloads);
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const needle = query.trim().toLowerCase();

  const addTileset = async (guid: string | null) => {
    if (!guid) return;
    const asset = assets.find((entry) => entry.guid === guid);
    const raw =
      asset && loadAssetDocument
        ? await loadAssetDocument("tileset", asset.path)
        : {};
    const next = addTilemapTileset(
      tilemap,
      guid,
      normalizeTilesetPayload(raw ?? {}),
    );
    const added = next.tilesets[next.tilesets.length - 1];
    if (added) editing?.setSelectedGid(added.firstGid);
    onChange?.(next as unknown as Record<string, unknown>);
  };

  if (tilemap.tilesets.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="tilemap-palette">
        <Empty data-testid="tilemap-palette-empty">
          <EmptyHeader>
            <EmptyTitle>Palette</EmptyTitle>
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2" data-testid="tilemap-palette">
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Search Tiles"
        aria-label="Search Tiles"
        data-testid="tilemap-palette-search"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tilemap.tilesets.map((ref) => {
          const tileset = payloads.get(ref.guid);
          const name =
            assets.find((asset) => asset.guid === ref.guid)?.name ?? "Tileset";
          if (needle && !name.toLowerCase().includes(needle) && !needle.startsWith("tile")) {
            const tileMatch = tileset?.tiles.some((tile) =>
              `tile ${tile.id}`.includes(needle),
            );
            if (!tileMatch) return null;
          }
          const tiles = tileset?.tiles ?? [];
          const visible = tiles.filter((tile) => {
            if (!needle) return true;
            if (name.toLowerCase().includes(needle)) return true;
            return `tile ${tile.id}`.includes(needle);
          });
          if (visible.length === 0) return null;
          return (
            <div key={ref.guid} className="mb-3" data-testid={`tilemap-palette-group-${ref.guid}`}>
              <p className="mb-1 px-1 text-sm font-medium">{name}</p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1">
                {visible.map((tile) => {
                  const gid = encodeTileGid(ref.firstGid, tile.id);
                  return (
                    <TileThumb
                      key={gid}
                      gid={gid}
                      localId={tile.id}
                      tileset={tileset}
                      atlas={atlases.get(ref.guid) ?? null}
                      selected={editing?.selectedGid === gid}
                      onSelect={(next) => editing?.setSelectedGid(next)}
                      testId={`tilemap-palette-tile-${gid}`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TilemapPaint({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const tilemap = normalizeTilemapPayload(payload);
  const latestRef = useRef(tilemap);
  useEffect(() => {
    latestRef.current = normalizeTilemapPayload(payload);
  }, [payload]);
  const editing = useOptionalTilemapEditing();
  const [localGid, setLocalGid] = useState(1);
  const selectedGid = editing?.selectedGid ?? localGid;
  const setSelectedGid = (gid: number) => {
    if (editing) editing.setSelectedGid(gid);
    else setLocalGid(gid);
  };
  const [layerOpen, setLayerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tool, setTool] = useState<TilemapPaintTool>("move");
  const [layerId, setLayerId] = useState(tilemap.layers[0]?.id ?? "layer-1");
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
  const strokeRef = useRef<{
    id: string;
    base: TilemapPayload;
    start: { x: number; y: number };
    last: { x: number; y: number };
    cells: Array<{ x: number; y: number }>;
  } | null>(null);
  const viewRef = useRef({ pan, cellSize });
  viewRef.current = { pan, cellSize };
  const { assetRegistry, loadAssetDocument } = useDocuments();
  const payloads = useLoadedTilesets(tilemap);
  const atlases = useTilesetAtlases(payloads);
  const layer =
    tilemap.layers.find((entry) => entry.id === layerId) ?? tilemap.layers[0];
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const decoded = decodeTileGid(tilemap, selectedGid, payloads);
  const localTileId = decoded?.localId ?? selectedGid;

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    drawTilemapCanvas(
      ctx,
      cssSize.width,
      cssSize.height,
      dpr,
      tilemap,
      pan,
      cellSize,
      layer?.id,
      payloads,
      atlases,
    );
  }, [atlases, cellSize, cssSize, layer?.id, pan, payloads, tilemap]);

  const cellAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const height = rect.height || cssSize.height;
    return paintCanvasTileAt({
      localX: clientX - rect.left,
      localY: clientY - rect.top,
      canvasHeight: height,
      panX: pan.x,
      panY: pan.y,
      cellSize,
    });
  };

  const commitStroke = (next: TilemapPayload, strokeId: string) => {
    onChange(next as unknown as Record<string, unknown>, tilemapStrokeMergeKey(strokeId));
  };

  const paintAt = (
    cell: { x: number; y: number },
    pointerType: "down" | "move",
  ) => {
    if (!layer || !isTilemapPaintStrokeTool(tool)) return;
    if (pointerType === "down") {
      strokeRef.current = {
        id: newStrokeId(),
        base: latestRef.current,
        start: cell,
        last: cell,
        cells: [cell],
      };
    }
    const stroke = strokeRef.current;
    if (!stroke) return;
    if (tool === "brush" || tool === "eraser") {
      const extra = cellsAlongSegment(stroke.last, cell);
      const seen = new Set(stroke.cells.map((entry) => `${entry.x},${entry.y}`));
      for (const entry of extra) {
        const key = `${entry.x},${entry.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        stroke.cells.push(entry);
      }
      stroke.last = cell;
    } else {
      stroke.last = cell;
    }
    if (tool === "bucket" || tool === "stamp") {
      if (pointerType !== "down") return;
    }
    const painted = applyTilemapPaint(stroke.base, {
      tool,
      layerId: layer.id,
      tileId: selectedGid,
      start: stroke.start,
      end: stroke.last,
      cells: stroke.cells,
      stamp:
        tool === "stamp"
          ? { width: 2, height: 2, tiles: [selectedGid, selectedGid, selectedGid, selectedGid] }
          : undefined,
    });
    latestRef.current = painted;
    commitStroke(painted, stroke.id);
  };

  const addTileset = async (guid: string | null) => {
    if (!guid) return;
    const asset = assets.find((entry) => entry.guid === guid);
    const raw =
      asset && loadAssetDocument
        ? await loadAssetDocument("tileset", asset.path)
        : {};
    const next = addTilemapTileset(
      tilemap,
      guid,
      normalizeTilesetPayload(raw ?? {}),
    );
    const added = next.tilesets[next.tilesets.length - 1];
    if (added) setSelectedGid(added.firstGid);
    onChange(next as unknown as Record<string, unknown>);
  };

  if (tilemap.tilesets.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="tilemap-editor">
        <Empty data-testid="tilemap-paint-empty">
          <EmptyHeader>
            <EmptyTitle>Paint</EmptyTitle>
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

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden" data-testid="tilemap-editor">
      <div className="flex flex-wrap items-center gap-2 px-2 py-2">
        <ToggleGroup
          variant="outline"
          size="touch"
          spacing={1}
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
              <ToggleGroupItem
                key={entry.id}
                value={entry.id}
                aria-label={entry.label}
                data-testid={`tilemap-tool-${entry.id}`}
              >
                <Icon />
                {entry.id === "move" ? <span>{entry.label}</span> : null}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
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
            data-testid="tilemap-paint-layer"
          >
            {layer?.name ?? "Layer"}
          </Button>
        </SearchDropdown>
        <TileThumb
          gid={selectedGid}
          localId={localTileId}
          tileset={decoded?.tileset}
          atlas={decoded ? atlases.get(decoded.guid) ?? null : null}
          selected
          onSelect={() => {}}
          testId="tilemap-selected-tile"
        />
        <span
          className="truncate text-sm text-muted-foreground"
          data-testid="tilemap-selected-label"
        >
          {decoded
            ? `${
                assets.find((asset) => asset.guid === decoded.guid)?.name ??
                "Tileset"
              } · Tile ${localTileId}`
            : `GID ${selectedGid}`}
        </span>
      </div>
      <div ref={hostRef} className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 size-full touch-none rounded-md border border-border bg-background"
          data-testid="tilemap-paint-canvas"
          data-tool={tool}
          data-tile={String(localTileId)}
          data-gid={String(selectedGid)}
          data-cell-size={String(cellSize)}
          data-zoom={String(cellSize / DEFAULT_PAINT_CELL_SIZE)}
          data-pan-x={String(pan.x)}
          data-pan-y={String(pan.y)}
          data-paint-source={atlases.size > 0 ? "atlas" : "hsl"}
          onWheel={(event) => {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const view = applyWheelZoom({
              panX: viewRef.current.pan.x,
              panY: viewRef.current.pan.y,
              cellSize: viewRef.current.cellSize,
              originX: event.clientX - rect.left,
              originY: event.clientY - rect.top,
              canvasHeight: rect.height || cssSize.height,
              deltaY: event.deltaY,
            });
            setPan({ x: view.panX, y: view.panY });
            setCellSize(view.cellSize);
          }}
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
              const stroke = strokeRef.current;
              if (stroke) {
                latestRef.current = stroke.base;
                commitStroke(stroke.base, stroke.id);
                strokeRef.current = null;
              }
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
            if (tool === "picker") {
              // Defer until pointerup so a second-finger pinch keeps the palette GID.
              pendingPickerRef.current = cell;
              return;
            }
            paintAt(cell, "down");
          }}
          onPointerMove={(event) => {
            const pointerId = pointerIdOf(event);
            const tracked = pointersRef.current.get(pointerId);
            if (!tracked) return;
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
                translationY: midY - start.midY,
              });
              setPan({ x: view.panX, y: view.panY });
              setCellSize(view.cellSize);
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
              setPan({ x: next.panX, y: next.panY });
              return;
            }
            const cell = cellAt(event.clientX, event.clientY);
            if (!cell) return;
            paintAt(cell, "move");
          }}
          onPointerUp={(event) => {
            const pointerId = pointerIdOf(event);
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
                setSelectedGid(
                  pickTileId(tilemap, layer.id, pending.x, pending.y),
                );
              }
              strokeRef.current = null;
              pinchActiveRef.current = false;
            }
          }}
          onPointerCancel={(event) => {
            const pointerId = pointerIdOf(event);
            pointersRef.current.delete(pointerId);
            if (panDragRef.current?.pointerId === pointerId) {
              panDragRef.current = null;
            }
            if (pointersRef.current.size < 2) pinchStartRef.current = null;
            if (pointersRef.current.size === 0) {
              pendingPickerRef.current = null;
              strokeRef.current = null;
              pinchActiveRef.current = false;
            }
          }}
        />
      </div>
    </div>
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
}: {
  gid: number;
  localId: number;
  tileset?: TilesetPayload;
  atlas: HTMLImageElement | null;
  selected: boolean;
  onSelect: (gid: number) => void;
  testId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    const rect = tileset ? tilesetTileRect(tileset, localId) : null;
    if (atlas && rect && atlas.naturalWidth > 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        atlas,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    } else {
      ctx.fillStyle =
        localId <= 0 ? "oklch(0.25 0 0)" : `hsl(${(gid * 47) % 360} 55% 48%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, [atlas, gid, localId, tileset]);

  return (
    <button
      type="button"
      className="size-11 shrink-0 overflow-hidden rounded-md border border-border data-[selected=true]:ring-2 data-[selected=true]:ring-primary"
      data-testid={testId}
      data-gid={String(gid)}
      data-tile={String(localId)}
      data-selected={selected ? "true" : "false"}
      aria-label={`Tile ${localId}`}
      aria-pressed={selected}
      onClick={() => onSelect(gid)}
    >
      <canvas
        ref={canvasRef}
        width={tileset?.tileWidth ?? 16}
        height={tileset?.tileHeight ?? 16}
        className="size-full"
        style={{ imageRendering: "pixelated" }}
      />
    </button>
  );
}

function useLoadedTilesets(
  tilemap: TilemapPayload,
): ReadonlyMap<string, TilesetPayload> {
  const { assetRegistry, loadAssetDocument, openDocuments } = useDocuments();
  const [payloads, setPayloads] = useState<ReadonlyMap<string, TilesetPayload>>(
    new Map(),
  );
  const guids = tilemapTilesetGuids(tilemap).join(",");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = new Map<string, TilesetPayload>();
      for (const guid of guids.split(",").filter(Boolean)) {
        const asset = assetRegistry?.list().find((entry) => entry.header.guid === guid);
        if (!asset) continue;
        const open = openDocuments.find((doc) => doc.ref.path === asset.path);
        const raw =
          open?.content ??
          (loadAssetDocument
            ? await loadAssetDocument("tileset", asset.path)
            : null);
        if (!raw) continue;
        next.set(guid, ensureTilesetTiles(normalizeTilesetPayload(raw)));
      }
      if (!cancelled) {
        setPayloads((current) => {
          if (
            current.size === next.size &&
            [...next.keys()].every((guid) => current.has(guid))
          ) {
            return current;
          }
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetRegistry, guids, loadAssetDocument, openDocuments]);
  return payloads;
}

function useTilesetAtlases(
  payloads: ReadonlyMap<string, TilesetPayload>,
): ReadonlyMap<string, HTMLImageElement> {
  const { assetRegistry, readAssetChunk } = useDocuments();
  const [images, setImages] = useState<ReadonlyMap<string, HTMLImageElement>>(
    new Map(),
  );
  const key = [...payloads.entries()]
    .map(([guid, tileset]) => `${guid}:${tileset.textureGuid ?? ""}`)
    .join(",");
  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];
    void (async () => {
      const next = new Map<string, HTMLImageElement>();
      for (const [guid, tileset] of payloads) {
        const texture = (assetRegistry?.list() ?? []).find(
          (asset) => asset.header.guid === tileset.textureGuid,
        );
        if (!texture || !readAssetChunk) continue;
        const bytes = await readAssetChunk(texture.path, "pixels");
        if (!bytes || bytes.byteLength === 0) continue;
        const objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: "image/png" }),
        );
        objectUrls.push(objectUrl);
        const image = new Image();
        image.onload = () => {
          if (cancelled) return;
          next.set(guid, image);
          setImages(new Map(next));
        };
        image.src = objectUrl;
      }
    })();
    return () => {
      cancelled = true;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
    // payloads is keyed by `key`; listing entries would retrigger every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key captures texture identity
  }, [assetRegistry, key, readAssetChunk]);
  return images;
}

function drawTilemapCanvas(
  ctx: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  tilemap: TilemapPayload,
  pan: { x: number; y: number },
  cellSize: number,
  layerId: string | undefined,
  payloads: ReadonlyMap<string, TilesetPayload>,
  atlases: ReadonlyMap<string, HTMLImageElement>,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = "oklch(0.2 0 0)";
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.imageSmoothingEnabled = false;
  const layer = tilemap.layers.find((entry) => entry.id === layerId) ?? tilemap.layers[0];
  if (layer) {
    const size = tilemap.chunkSize;
    for (const chunk of layer.chunks) {
      for (let ly = 0; ly < size; ly++) {
        for (let lx = 0; lx < size; lx++) {
          const gid = chunk.tiles[ly * size + lx] ?? 0;
          if (gid <= 0) continue;
          const gx = chunk.cx * size + lx;
          const gy = chunk.cy * size + ly;
          if (gx < 0 || gy < 0 || gx >= tilemap.width || gy >= tilemap.height) {
            continue;
          }
          const screenX = gx * cellSize + pan.x;
          const screenY = cssHeight - (gy + 1) * cellSize - pan.y;
          if (
            screenX + cellSize < 0 ||
            screenY + cellSize < 0 ||
            screenX > cssWidth ||
            screenY > cssHeight
          ) {
            continue;
          }
          const hit = decodeTileGid(tilemap, gid, payloads);
          const atlas = hit ? atlases.get(hit.guid) ?? null : null;
          const rect =
            hit && atlas ? tilesetTileRect(hit.tileset, hit.localId) : null;
          if (atlas && rect && atlas.naturalWidth > 0) {
            ctx.drawImage(
              atlas,
              rect.x,
              rect.y,
              rect.width,
              rect.height,
              screenX,
              screenY,
              cellSize,
              cellSize,
            );
          } else {
            ctx.fillStyle = `hsl(${(gid * 47) % 360} 55% 48%)`;
            ctx.fillRect(screenX, screenY, cellSize, cellSize);
          }
        }
      }
    }
  }
  const mapW = Math.max(1, tilemap.width);
  const mapH = Math.max(1, tilemap.height);
  const mapLeft = pan.x;
  const mapBottom = cssHeight - pan.y;
  const mapPixelW = mapW * cellSize;
  const mapPixelH = mapH * cellSize;
  const mapTop = mapBottom - mapPixelH;
  const mapRight = mapLeft + mapPixelW;
  ctx.save();
  ctx.beginPath();
  ctx.rect(mapLeft, mapTop, mapPixelW, mapPixelH);
  ctx.clip();
  ctx.strokeStyle = "oklch(0.4 0 0 / 0.4)";
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= mapW; gx++) {
    const x = mapLeft + gx * cellSize;
    ctx.beginPath();
    ctx.moveTo(x, mapTop);
    ctx.lineTo(x, mapBottom);
    ctx.stroke();
  }
  for (let gy = 0; gy <= mapH; gy++) {
    const y = mapBottom - gy * cellSize;
    ctx.beginPath();
    ctx.moveTo(mapLeft, y);
    ctx.lineTo(mapRight, y);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = "oklch(0.92 0 0)";
  ctx.lineWidth = 2;
  ctx.strokeRect(mapLeft + 0.5, mapTop + 0.5, mapPixelW, mapPixelH);
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
