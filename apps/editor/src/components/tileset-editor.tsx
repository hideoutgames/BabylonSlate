import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  BrushIcon,
  HandIcon,
  MousePointerIcon,
  SplineIcon,
  SquareDashedIcon,
  SquareIcon,
} from "lucide-react";
import {
  AssetPicker,
  AtlasTileGrid,
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
import { Separator } from "@babylonslate/ui/components/separator";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import {
  ensureTilesetTiles,
  tilesetTileRect,
  DEFAULT_TILE_ANIMATION_FRAME_DURATION_MS,
  normalizeTilesetPayload,
  type TilesetCollision,
  type TilesetPayload,
  type TilesetTile,
} from "@babylonslate/assets";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { TexturePreviewStatus, useTexturePreview } from "./texture-preview-status";
import { useOptionalTilesetEditing } from "../context/tileset-editing-context";

const TOOL_ITEM = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";

export function TilesetPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="tileset-preview-panel">
      <TilesetPreview
        payload={payload}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}

export function TilesetDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="tileset-details-panel">
      <TilesetEditor
        payload={payload}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
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
  onChange?: (next: Record<string, unknown>) => void;
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

  const commit = (next: TilesetPayload) => {
    onChange?.(ensureTilesetTiles(next) as unknown as Record<string, unknown>);
  };

  const patchTiles = (tileIds: number[], patch: Partial<TilesetTile>) => {
    const ids = new Set(tileIds);
    commit({
      ...tileset,
      tiles: tileset.tiles.map((tile) =>
        ids.has(tile.id) ? { ...tile, ...patch } : tile,
      ),
    });
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
            patchTiles([id], { collision: selected.collision });
          }
        }}
        onSelectionChange={(ids) => {
          if (editing) editing.setSelectedTileIds(ids);
          else setLocalSelectedIds(ids);
          if (editing?.paintCollision && selected) {
            patchTiles(ids, { collision: selected.collision });
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
  onChange: (next: Record<string, unknown>) => void;
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

  const commit = (next: TilesetPayload) => {
    onChange(ensureTilesetTiles(next) as unknown as Record<string, unknown>);
  };

  const patchTile = (patch: Partial<TilesetTile>) => {
    if (!selected) return;
    const ids = new Set(selectedIds);
    commit({
      ...tileset,
      tiles: tileset.tiles.map((tile) =>
        ids.has(tile.id) ? { ...tile, ...patch } : tile,
      ),
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
      onChange: (value) => commit({ ...tileset, margin: value }),
    },
    {
      id: "spacing",
      kind: "number",
      label: "Spacing",
      value: tileset.spacing,
      onChange: (value) => commit({ ...tileset, spacing: value }),
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
      label: "Frame Duration MS",
      value: selected?.animationFrameDurationMs ?? DEFAULT_TILE_ANIMATION_FRAME_DURATION_MS,
      min: 1,
      onChange: (value) => patchTile({ animationFrameDurationMs: Math.max(1, Math.floor(value)) }),
    },
  ];
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
      </div>
      <PropertyGrid rows={tileRows} />
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
  const { assetRegistry } = useDocuments();
  return (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
}

function TileSwatch({
  tileset,
  tileId,
  imageUrl,
}: {
  tileset: TilesetPayload;
  tileId: number;
  imageUrl: string | null;
}) {
  const rect = tilesetTileRect(tileset, tileId);
  const size = 40;
  const scale = rect ? size / Math.max(rect.width, rect.height) : 1;
  return (
    <span
      aria-hidden
      data-testid="tileset-selected-swatch"
      className="size-10 shrink-0 overflow-hidden rounded-md ring-1 ring-border"
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
            backgroundSize: `${tileset.atlasWidth * scale}px ${tileset.atlasHeight * scale}px`,
            backgroundPosition: `${-rect.x * scale}px ${-rect.y * scale}px`,
            imageRendering: "pixelated",
          }}
        />
      ) : null}
    </span>
  );
}

function tileGridLabel(tileset: TilesetPayload, tileId: number): string {
  const rect = tilesetTileRect(tileset, tileId);
  if (!rect) return "Outside the atlas";
  const column = Math.round((rect.x - tileset.margin) / (tileset.tileWidth + tileset.spacing)) + 1;
  const row = Math.round((rect.y - tileset.margin) / (tileset.tileHeight + tileset.spacing)) + 1;
  return `Column ${column}, Row ${row}`;
}
