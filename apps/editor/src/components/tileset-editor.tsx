import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  ArrowDownIcon,
  ArrowDownLeftIcon,
  ArrowDownRightIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ArrowUpLeftIcon,
  ArrowUpRightIcon,
  BrushIcon,
  HandIcon,
  MousePointerIcon,
  SplineIcon,
  SquareDashedIcon,
  SquareIcon,
  type LucideIcon,
} from "lucide-react";
import {
  AssetPicker,
  AtlasTileGrid,
  NamedListEditor,
  PanelFrame,
  PropertyGrid,
  PropertySectionTitle,
  ToolbarStrip,
  assetRowIdentity,
  type AtlasTileGridTool,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Toggle } from "@babylonslate/ui/components/toggle";
import { Button } from "@babylonslate/ui/components/button";
import { Badge } from "@babylonslate/ui/components/badge";
import { Field, FieldDescription, FieldTitle } from "@babylonslate/ui/components/field";
import { Separator } from "@babylonslate/ui/components/separator";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import {
  canonicalTerrainMask,
  ensureTilesetTiles,
  tilesetTerrainById,
  tilesetTileRect,
  terrainVariantMasks,
  DEFAULT_TILE_ANIMATION_FRAME_DURATION_MS,
  normalizeTilesetPayload,
  TERRAIN_E,
  TERRAIN_N,
  TERRAIN_NE,
  TERRAIN_NW,
  TERRAIN_S,
  TERRAIN_SE,
  TERRAIN_SW,
  TERRAIN_W,
  TILESET_TERRAIN_STYLES,
  type TilesetCollision,
  type TilesetPayload,
  type TilesetTerrain,
  type TilesetTerrainStyle,
  type TilesetTile,
} from "@babylonslate/assets";
import {
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { TexturePreviewStatus, useTexturePreview } from "./texture-preview-status";
import { useOptionalTilesetEditing } from "../context/tileset-editing-context";

const TOOL_ITEM = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";

export function TilesetPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="tileset-preview-panel">
      <TilesetPreview
        payload={payload}
        onChange={(next, mergeKey) => {
          void applyAssetDocumentChange(documentId, next, mergeKey);
        }}
      />
    </PanelFrame>
  );
}

export function TilesetDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="tileset-details-panel">
      <TilesetEditor
        payload={payload}
        onChange={(next, mergeKey) => {
          void applyAssetDocumentChange(documentId, next, mergeKey);
        }}
      />
    </PanelFrame>
  );
}

export function TilesetPreview({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  /** A collision paint drag passes one merge key so the stroke is one undo step. */
  onChange?: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const tileset = useMemo(
    () => ensureTilesetTiles(normalizeTilesetPayload(payload)),
    [payload],
  );
  const editing = useOptionalTilesetEditing();
  const [localSelectedIds, setLocalSelectedIds] = useState([
    tileset.tiles[0]?.id ?? 1,
  ]);
  const selectedIds = currentTileSelection(
    tileset,
    editing?.selectedTileIds ?? localSelectedIds,
  );
  const selectedId = selectedIds[0] ?? 1;
  const [previewTool, setPreviewTool] = useState<AtlasTileGridTool>("move");
  const [pickerOpen, setPickerOpen] = useState(false);
  const assets = useAssetOptions();
  const preview = useTexturePreview(tileset.textureGuid);
  const { url } = preview;
  const selected =
    tileset.tiles.find((tile) => tile.id === selectedId) ?? tileset.tiles[0];

  const commit = (next: TilesetPayload, mergeKey?: string) => {
    const record = ensureTilesetTiles(next) as unknown as Record<string, unknown>;
    if (mergeKey) onChange?.(record, mergeKey);
    else onChange?.(record);
  };

  const patchTiles = (
    tileIds: number[],
    patch: Partial<TilesetTile>,
    mergeKey?: string,
  ) => {
    const ids = new Set(tileIds);
    commit({
      ...tileset,
      tiles: tileset.tiles.map((tile) =>
        ids.has(tile.id) ? { ...tile, ...patch } : tile,
      ),
    }, mergeKey);
  };

  const collisionValue = collisionEnum(selected?.collision);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" onErrorCapture={preview.fail}>
      <ToolbarStrip className="shrink-0 gap-2 py-1" data-testid="tileset-preview-toolbar">
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[previewTool]}
          onValueChange={(value) => {
            const next = value[0] as AtlasTileGridTool | undefined;
            if (next) setPreviewTool(next);
          }}
          aria-label="Tileset preview tool"
          data-testid="tileset-preview-tools"
        >
          <ToggleGroupItem value="move" className={TOOL_ITEM} data-testid="tileset-tool-move">
            <HandIcon />
            Move
          </ToggleGroupItem>
          <ToggleGroupItem value="select" className={TOOL_ITEM} data-testid="tileset-tool-select">
            <MousePointerIcon />
            Select
          </ToggleGroupItem>
        </ToggleGroup>
        <Separator orientation="vertical" className="my-1" />
        <span className="text-xs text-muted-foreground">Collision</span>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[collisionValue]}
          onValueChange={(value) => {
            const next = value[0];
            if (!next || !selected) return;
            patchTiles(selectedIds, { collision: collisionFromEnum(next) });
          }}
          aria-label="Tile Collision"
          data-testid="tileset-collision-tools"
        >
          <ToggleGroupItem value="none" className={TOOL_ITEM} data-testid="tileset-collision-none">
            <SquareDashedIcon />
            None
          </ToggleGroupItem>
          <ToggleGroupItem value="full" className={TOOL_ITEM} data-testid="tileset-collision-full">
            <SquareIcon />
            Full
          </ToggleGroupItem>
          <ToggleGroupItem value="chain" className={TOOL_ITEM} data-testid="tileset-collision-chain">
            <SplineIcon />
            Chain
          </ToggleGroupItem>
        </ToggleGroup>
        <Toggle
          variant="outline"
          size="sm"
          className={TOOL_ITEM}
          pressed={editing?.paintCollision ?? false}
          onPressedChange={(pressed) => editing?.setPaintCollision(pressed)}
          data-testid="tileset-paint-collision"
        >
          <BrushIcon />
          Paint Collision
        </Toggle>
        {url ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums" data-testid="tileset-preview-selection">
            {selectedIds.length > 1 ? `${selectedIds.length} Tiles Selected` : `Tile ${selectedId}`}
          </span>
        ) : null}
      </ToolbarStrip>
      <AtlasTileGrid
        tileset={tileset}
        imageUrl={url}
        selectedId={selectedId}
        selectedIds={selectedIds}
        panZoom
        tool={previewTool}
        emptyLabel={preview.status === "failed" ? "" : preview.status === "missing" ? "Missing Texture" : preview.status === "empty" ? "No Texture" : "Loading Texture…"}
        emptyDescription={preview.status === "empty"
          ? "Pick a Texture to slice it into tiles."
          : preview.status === "missing"
            ? "The assigned Texture is no longer in the project."
            : undefined}
        emptyAction={preview.status === "empty" || preview.status === "missing" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="tileset-preview-pick-texture"
            onClick={() => setPickerOpen(true)}
          >
            Pick Texture
          </Button>
        ) : undefined}
        data-testid="tileset-preview"
        onSelect={(id) => {
          if (editing) editing.setSelectedTileId(id);
          else setLocalSelectedIds([id]);
          if (editing?.paintCollision && selected) {
            patchTiles([id], { collision: selected.collision }, "tileset:paintCollision");
          }
        }}
        onSelectionChange={(ids) => {
          if (editing) editing.setSelectedTileIds(ids);
          else setLocalSelectedIds(ids);
          if (editing?.paintCollision && selected) {
            // The selection grows on every pointer move of a paint drag.
            patchTiles(ids, { collision: selected.collision }, "tileset:paintCollision");
          }
        }}
        onImageSize={(width, height) => {
          if (
            width <= 0 ||
            height <= 0 ||
            (width === tileset.atlasWidth && height === tileset.atlasHeight)
          ) {
            return;
          }
          commit(
            ensureTilesetTiles({
              ...tileset,
              atlasWidth: width,
              atlasHeight: height,
            }),
          );
        }}
      />
      {preview.status === "failed" ? <TexturePreviewStatus preview={preview} /> : null}
      <AssetPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        assets={assets}
        allowedTypes={["Texture"]}
        onPick={(guid) => {
          commit({ ...tileset, textureGuid: guid });
          setPickerOpen(false);
        }}
        data-testid="tileset-preview-texture-picker"
      />
    </div>
  );
}

export function TilesetEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  /** `mergeKey` groups one scrub's edits into one undo entry. */
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const tileset = useMemo(
    () => ensureTilesetTiles(normalizeTilesetPayload(payload)),
    [payload],
  );
  const [tileSize, setTileSize] = useState({
    width: tileset.tileWidth,
    height: tileset.tileHeight,
  });
  useEffect(() => {
    setTileSize({ width: tileset.tileWidth, height: tileset.tileHeight });
  }, [tileset.tileWidth, tileset.tileHeight]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const editing = useOptionalTilesetEditing();
  const selectedIds = currentTileSelection(
    tileset,
    editing?.selectedTileIds ?? [],
  );
  const selectedId = selectedIds[0] ?? 1;
  const assets = useAssetOptions();
  const textureName = assets.find(
    (asset) => asset.guid === tileset.textureGuid,
  )?.name;
  const selected =
    tileset.tiles.find((tile) => tile.id === selectedId) ?? tileset.tiles[0];

  /** `field` marks a continuous edit whose scrub is one undo step. */
  const commit = (next: TilesetPayload, field?: string) => {
    const record = ensureTilesetTiles(next) as unknown as Record<string, unknown>;
    if (field) onChange(record, `tileset:${field}`);
    else onChange(record);
  };

  const patchTile = (patch: Partial<TilesetTile>, field?: string) => {
    if (!selected) return;
    const ids = new Set(selectedIds);
    commit({
      ...tileset,
      tiles: tileset.tiles.map((tile) =>
        ids.has(tile.id) ? { ...tile, ...patch } : tile,
      ),
    }, field ? `tiles:${selectedIds.join(",")}:${field}` : undefined);
  };

  const terrains = tileset.terrains ?? [];
  const [selectedTerrainId, setSelectedTerrainId] = useState<string | null>(null);
  const selectedTerrain =
    terrains.find((terrain) => terrain.id === selectedTerrainId) ?? terrains[0] ?? null;

  /** Replace the terrain list; tiles of a removed terrain leave it in the same edit. */
  const commitTerrains = (next: TilesetTerrain[], field?: string) => {
    const kept = new Set(next.map((terrain) => terrain.id));
    const tiles = tileset.tiles.map((tile) =>
      tile.terrain && !kept.has(tile.terrain.id) ? withoutTerrain(tile) : tile,
    );
    const payload: TilesetPayload = { ...tileset, tiles, terrains: next };
    // A Tileset without terrains saves without the key, as before terrains existed.
    if (next.length === 0) delete payload.terrains;
    commit(payload, field);
  };

  const addTerrain = () => {
    const ids = new Set(terrains.map((terrain) => terrain.id));
    let index = terrains.length + 1;
    while (ids.has(`terrain-${index}`)) index += 1;
    const id = `terrain-${index}`;
    const name = terrains.some((terrain) => terrain.name === "Terrain") ? `Terrain ${index}` : "Terrain";
    commitTerrains([...terrains, { id, name, style: "sides" }]);
    setSelectedTerrainId(id);
  };

  const patchTerrain = (patch: Partial<TilesetTerrain>, field?: string) => {
    if (!selectedTerrain) return;
    commitTerrains(
      terrains.map((terrain) => (terrain.id === selectedTerrain.id ? { ...terrain, ...patch } : terrain)),
      field ? `terrain:${selectedTerrain.id}:${field}` : undefined,
    );
  };

  const selectedSet = new Set(selectedIds);
  const tileTerrain = selected?.terrain ? tilesetTerrainById(tileset, selected.terrain.id) : null;
  /** Selected tiles in the primary tile's terrain; neighbour toggles edit them together. */
  const terrainMembers = tileTerrain
    ? tileset.tiles.filter((tile) => selectedSet.has(tile.id) && tile.terrain?.id === tileTerrain.id)
    : [];

  const setTileTerrain = (terrainId: string | null) => {
    commit({
      ...tileset,
      tiles: tileset.tiles.map((tile) => {
        if (!selectedSet.has(tile.id)) return tile;
        if (!terrainId) return withoutTerrain(tile);
        return { ...tile, terrain: { id: terrainId, mask: tile.terrain?.mask ?? 0 } };
      }),
    });
  };

  const toggleTerrainNeighbour = (bit: number, on: boolean) => {
    const members = new Set(terrainMembers.map((tile) => tile.id));
    commit({
      ...tileset,
      tiles: tileset.tiles.map((tile) => {
        if (!members.has(tile.id) || !tile.terrain) return tile;
        // Opening a side also opens the corners that need it.
        const mask = on ? tile.terrain.mask | bit : tile.terrain.mask & ~bit & ~(SIDE_CORNERS.get(bit) ?? 0);
        return { ...tile, terrain: { ...tile.terrain, mask } };
      }),
    });
  };

  const preview = useTexturePreview(tileset.textureGuid);
  const tileSizeDirty =
    Math.floor(tileSize.width) !== tileset.tileWidth ||
    Math.floor(tileSize.height) !== tileset.tileHeight;
  const collisionValue = collisionEnum(selected?.collision);
  const atlasRows: PropertyRow[] = [
    {
      id: "texture",
      kind: "asset",
      label: "Texture",
      value: tileset.textureGuid,
      placeholder: "None",
      onPick: () => setPickerOpen(true),
      onChange: (value) => commit({ ...tileset, textureGuid: value }),
      ...assetRowIdentity(
        textureName ? { name: textureName, type: "Texture" } : undefined,
      ),
    },
    {
      id: "atlasWidth",
      kind: "number",
      label: "Atlas Width",
      value: tileset.atlasWidth,
      disabled: true,
      onChange: () => {},
    },
    {
      id: "atlasHeight",
      kind: "number",
      label: "Atlas Height",
      value: tileset.atlasHeight,
      disabled: true,
      onChange: () => {},
    },
  ];
  const tileSizeRows: PropertyRow[] = [
    {
      id: "tileWidth",
      kind: "number",
      label: "Tile Width",
      value: tileSize.width,
      min: 1,
      onChange: (width) => setTileSize((current) => ({ ...current, width })),
    },
    {
      id: "tileHeight",
      kind: "number",
      label: "Tile Height",
      value: tileSize.height,
      min: 1,
      onChange: (height) => setTileSize((current) => ({ ...current, height })),
    },
  ];
  const layoutRows: PropertyRow[] = [
    {
      id: "margin",
      kind: "number",
      label: "Margin",
      value: tileset.margin,
      onChange: (value) => commit({ ...tileset, margin: value }, "margin"),
    },
    {
      id: "spacing",
      kind: "number",
      label: "Spacing",
      value: tileset.spacing,
      onChange: (value) => commit({ ...tileset, spacing: value }, "spacing"),
    },
  ];
  const tileRows: PropertyRow[] = [
    {
      id: "collision",
      kind: "enum",
      label: "Tile Collision",
      value: collisionValue,
      options: [
        { value: "none", label: "None" },
        { value: "full", label: "Full" },
        { value: "chain", label: "Chain" },
      ],
      onChange: (value) => patchTile({ collision: collisionFromEnum(value) }),
    },
    {
      id: "flags",
      kind: "flags",
      label: "Tile Flags",
      value: selected?.flags ?? 0,
      bitCount: 8,
      onChange: (flags) => patchTile({ flags }),
    },
    {
      id: "animation",
      kind: "text",
      label: "Animation Frames",
      value: (selected?.animation ?? []).join(", "),
      onChange: (value) =>
        patchTile({
          animation: value
            .split(/[,\s]+/)
            .map((entry) => Number(entry))
            .filter((id) => Number.isInteger(id) && id > 0),
        }),
    },
    {
      id: "animationFrameDurationMs",
      kind: "number",
      label: "Frame Duration",
      unit: "ms",
      value: selected?.animationFrameDurationMs ?? DEFAULT_TILE_ANIMATION_FRAME_DURATION_MS,
      min: 1,
      onChange: (value) =>
        patchTile(
          { animationFrameDurationMs: Math.max(1, Math.floor(value)) },
          "animationFrameDurationMs",
        ),
    },
  ];
  const tileTerrainRows: PropertyRow[] = terrains.length > 0
    ? [{
        id: "tile-terrain",
        kind: "enum",
        label: "Terrain",
        value: selected?.terrain?.id ?? "none",
        options: [
          { value: "none", label: "None" },
          ...terrains.map((terrain) => ({ value: terrain.id, label: terrain.name })),
        ],
        onChange: (value) => setTileTerrain(value === "none" ? null : value),
      }]
    : [];
  const terrainRows: PropertyRow[] = selectedTerrain
    ? [
        {
          id: "terrain-name",
          kind: "text",
          label: "Terrain Name",
          value: selectedTerrain.name,
          onChange: (name) => {
            if (name.trim()) patchTerrain({ name });
          },
        },
        {
          id: "terrain-style",
          kind: "enum",
          label: "Style",
          value: selectedTerrain.style,
          options: TILESET_TERRAIN_STYLES.map((style) => ({ value: style, label: TERRAIN_STYLE_LABELS[style] })),
          onChange: (style) => patchTerrain({ style: style as TilesetTerrainStyle }),
        },
      ]
    : [];
  if (collisionValue === "chain") {
    const points =
      selected?.collision && typeof selected.collision === "object"
        ? selected.collision.points
        : [];
    tileRows.push({
      id: "chain-points",
      kind: "text",
      label: "Chain Points",
      value: points.map((point) => `${point.x},${point.y}`).join(" "),
      onChange: (value) =>
        patchTile({
          collision: {
            kind: "chain",
            points: parseChainPoints(value),
          },
        }),
    });
  }

  return (
    <div data-testid="tileset-editor">
      <PropertyGrid title="Atlas" rows={atlasRows} />
      <PropertyGrid title="Grid" rows={tileSizeRows} />
      <div className="flex items-center justify-end gap-2 px-2 pb-1.5">
        {tileSizeDirty ? (
          <span className="mr-auto text-xs text-muted-foreground">Rebuilds the tile grid.</span>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={!tileSizeDirty}
          onClick={() =>
            commit({
              ...tileset,
              tileWidth: Math.max(1, Math.floor(tileSize.width)),
              tileHeight: Math.max(1, Math.floor(tileSize.height)),
            })
          }
          data-testid="tileset-confirm-tile-size"
        >
          Confirm Tile Size
        </Button>
      </div>
      <PropertyGrid rows={layoutRows} />
      <PropertySectionTitle>Terrains</PropertySectionTitle>
      {terrains.length === 0 ? (
        <p className="px-2 pt-2 text-xs text-muted-foreground">
          Add a terrain, then set it on its tiles to paint them as autotiles.
        </p>
      ) : null}
      <div className="py-1">
        <NamedListEditor
          data-testid="tileset-terrains"
          values={terrains.map((terrain) => terrain.id)}
          addLabel="Add Terrain"
          onAdd={addTerrain}
          onChange={(ids) => {
            const byId = new Map(terrains.map((terrain) => [terrain.id, terrain]));
            commitTerrains(ids.flatMap((id) => byId.get(id) ?? []));
          }}
          renderItem={({ value }) => {
            const terrain = terrains.find((entry) => entry.id === value);
            if (!terrain) return null;
            const active = terrain.id === selectedTerrain?.id;
            return (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={active}
                className={cn(
                  "min-w-0 flex-1 justify-start pointer-coarse:min-h-11",
                  active && "bg-accent font-medium text-accent-foreground",
                )}
                data-testid={`tileset-terrain-${value}`}
                onClick={() => setSelectedTerrainId(value)}
              >
                <span className="truncate">{terrain.name}</span>
                <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
                  {TERRAIN_STYLE_SHORT_LABELS[terrain.style]}
                </span>
              </Button>
            );
          }}
        />
      </div>
      {selectedTerrain ? (
        <>
          <PropertyGrid title="Selected Terrain" rows={terrainRows} />
          <p className="px-2 pb-1.5 text-xs text-muted-foreground" data-testid="tileset-terrain-coverage">
            {terrainCoverage(tileset, selectedTerrain)}
          </p>
        </>
      ) : null}
      <PropertySectionTitle>
        {selectedIds.length > 1 ? "Selected Tiles" : "Selected Tile"}
      </PropertySectionTitle>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-2">
        <TileSwatch tileset={tileset} tileId={selected?.id ?? 1} imageUrl={preview.url} />
        <div className="flex min-w-32 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium" data-testid="tileset-selected-label">
            {selectedIds.length > 1
              ? `${selectedIds.length} Tiles`
              : `Tile ${selected?.id ?? 1}`}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {selectedIds.length > 1
              ? "Edits apply to every selected tile."
              : tileGridLabel(tileset, selected?.id ?? 1)}
          </span>
        </div>
        <Badge variant={collisionValue === "none" ? "outline" : "secondary"} className="font-normal">
          {collisionValue === "full" ? "Full Collision" : collisionValue === "chain" ? "Chain Collision" : "No Collision"}
        </Badge>
        {tileTerrain ? (
          <Badge variant="secondary" className="font-normal" data-testid="tileset-selected-terrain">
            {tileTerrain.name}
          </Badge>
        ) : null}
      </div>
      <PropertyGrid rows={tileRows} />
      {tileTerrainRows.length > 0 ? <PropertyGrid rows={tileTerrainRows} /> : null}
      {tileTerrain ? (
        <TerrainNeighboursField
          style={tileTerrain.style}
          masks={terrainMembers.map((tile) => tile.terrain?.mask ?? 0)}
          onToggle={toggleTerrainNeighbour}
          center={<TileSwatch tileset={tileset} tileId={selected?.id ?? 1} imageUrl={preview.url} className="size-full" testId="tileset-terrain-swatch" />}
        />
      ) : null}
      <AssetPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        assets={assets}
        allowedTypes={["Texture"]}
        onPick={(guid) => {
          commit({ ...tileset, textureGuid: guid });
          setPickerOpen(false);
        }}
        data-testid="tileset-texture-picker"
      />
    </div>
  );
}

function currentTileSelection(
  tileset: TilesetPayload,
  ids: number[],
): number[] {
  const available = new Set(tileset.tiles.map((tile) => tile.id));
  const selected = ids.filter((id) => available.has(id));
  return selected.length ? selected : [tileset.tiles[0]?.id ?? 1];
}

function collisionEnum(value: TilesetCollision | undefined): string {
  if (value === "full") return "full";
  if (value && typeof value === "object") return "chain";
  return "none";
}

function collisionFromEnum(value: string): TilesetCollision {
  if (value === "full") return "full";
  if (value === "chain") {
    return {
      kind: "chain",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
    };
  }
  return "none";
}

function parseChainPoints(value: string): Array<{ x: number; y: number }> {
  return value
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(",");
      return { x: Number(x) || 0, y: Number(y) || 0 };
    })
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function useAssetOptions() {
  const { assetRegistry } = useRegistryState();
  return (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
}

/** One atlas cell over a checkerboard, scaled to whatever size `className` gives it. */
function TileSwatch({
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
  return (
    <span
      aria-hidden
      data-testid={testId}
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
      ) : null}
    </span>
  );
}

/** Style names with their variant counts; PropertyGrid shows them as written. */
const TERRAIN_STYLE_LABELS: Record<TilesetTerrainStyle, string> = {
  sides: "4 Sides (16)",
  blob: "Blob (47)",
};

const TERRAIN_STYLE_SHORT_LABELS: Record<TilesetTerrainStyle, string> = {
  sides: "4 Sides",
  blob: "Blob",
};

/** Corners that stop counting once their side opens. */
const SIDE_CORNERS = new Map([
  [TERRAIN_N, TERRAIN_NE | TERRAIN_NW],
  [TERRAIN_E, TERRAIN_NE | TERRAIN_SE],
  [TERRAIN_S, TERRAIN_SE | TERRAIN_SW],
  [TERRAIN_W, TERRAIN_SW | TERRAIN_NW],
]);

/** Sides each corner needs. */
const CORNER_SIDES = new Map([
  [TERRAIN_NE, TERRAIN_N | TERRAIN_E],
  [TERRAIN_SE, TERRAIN_S | TERRAIN_E],
  [TERRAIN_SW, TERRAIN_S | TERRAIN_W],
  [TERRAIN_NW, TERRAIN_N | TERRAIN_W],
]);

/** The neighbour toggles in reading order around the tile (`null`). */
const NEIGHBOUR_GRID: ReadonlyArray<{ bit: number; label: string; icon: LucideIcon } | null> = [
  { bit: TERRAIN_NW, label: "North West", icon: ArrowUpLeftIcon },
  { bit: TERRAIN_N, label: "North", icon: ArrowUpIcon },
  { bit: TERRAIN_NE, label: "North East", icon: ArrowUpRightIcon },
  { bit: TERRAIN_W, label: "West", icon: ArrowLeftIcon },
  null,
  { bit: TERRAIN_E, label: "East", icon: ArrowRightIcon },
  { bit: TERRAIN_SW, label: "South West", icon: ArrowDownLeftIcon },
  { bit: TERRAIN_S, label: "South", icon: ArrowDownIcon },
  { bit: TERRAIN_SE, label: "South East", icon: ArrowDownRightIcon },
];

const NEIGHBOUR_CELL = "size-7 pointer-coarse:size-11";

/**
 * The neighbours a terrain tile joins, around the tile itself. A toggle is
 * pressed when every edited tile joins that neighbour; corners show only for
 * blob terrains and need both of their sides.
 */
function TerrainNeighboursField({
  style,
  masks,
  center,
  onToggle,
}: {
  style: TilesetTerrainStyle;
  masks: readonly number[];
  center: ReactNode;
  onToggle: (bit: number, on: boolean) => void;
}) {
  const joins = (bits: number) =>
    masks.length > 0 && masks.every((mask) => (canonicalTerrainMask(style, mask) & bits) === bits);
  return (
    <Field className="gap-1.5 border-b border-border/30 px-2 py-1.5" data-testid="tileset-terrain-neighbours">
      <FieldTitle id="tileset-terrain-neighbours-title" className="text-xs">
        Terrain Neighbours
      </FieldTitle>
      <div role="group" aria-labelledby="tileset-terrain-neighbours-title" className="grid w-fit grid-cols-3 gap-1">
        {NEIGHBOUR_GRID.map((cell) => {
          if (!cell) return <div key="tile" className={NEIGHBOUR_CELL}>{center}</div>;
          const corner = CORNER_SIDES.get(cell.bit);
          if (corner !== undefined && style === "sides") {
            return <span key={cell.bit} aria-hidden className={NEIGHBOUR_CELL} />;
          }
          const Icon = cell.icon;
          return (
            <Toggle
              key={cell.bit}
              variant="outline"
              size="sm"
              aria-label={cell.label}
              title={cell.label}
              pressed={joins(cell.bit)}
              disabled={corner !== undefined && !joins(corner)}
              className={cn(NEIGHBOUR_CELL, "min-w-0 p-0")}
              onPressedChange={(next) => onToggle(cell.bit, next)}
              data-testid={`tileset-terrain-neighbour-${cell.label.toLowerCase().replace(" ", "-")}`}
            >
              <Icon />
            </Toggle>
          );
        })}
      </div>
      <FieldDescription className="text-xs">
        {style === "blob"
          ? "Pressed sides and corners continue the same terrain. A corner needs both of its sides."
          : "Pressed sides continue the same terrain."}
      </FieldDescription>
    </Field>
  );
}

function terrainCoverage(tileset: TilesetPayload, terrain: TilesetTerrain): string {
  const members = tileset.tiles.filter((tile) => tile.terrain?.id === terrain.id);
  const variants = new Set(members.map((tile) => canonicalTerrainMask(terrain.style, tile.terrain?.mask ?? 0)));
  const total = terrainVariantMasks(terrain.style).length;
  if (members.length === 0) return `No tiles yet. Set this terrain on tiles to cover its ${total} variants.`;
  const tiles = members.length === 1 ? "1 tile covers" : `${members.length} tiles cover`;
  return variants.size < total
    ? `${tiles} ${variants.size} of ${total} variants; the rest paint the closest tile.`
    : `${tiles} all ${total} variants.`;
}

function withoutTerrain(tile: TilesetTile): TilesetTile {
  const next = { ...tile };
  delete next.terrain;
  return next;
}

function tileGridLabel(tileset: TilesetPayload, tileId: number): string {
  const rect = tilesetTileRect(tileset, tileId);
  if (!rect) return "Outside the atlas";
  const column = Math.round((rect.x - tileset.margin) / (tileset.tileWidth + tileset.spacing)) + 1;
  const row = Math.round((rect.y - tileset.margin) / (tileset.tileHeight + tileset.spacing)) + 1;
  return `Column ${column}, Row ${row}`;
}
