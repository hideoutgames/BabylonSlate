import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { HandIcon, MousePointerIcon } from "lucide-react";
import {
  AssetPicker,
  AtlasTileGrid,
  PanelFrame,
  PropertyGrid,
  assetRowIdentity,
  type AtlasTileGridTool,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Toggle } from "@babylonslate/ui/components/toggle";
import { Button } from "@babylonslate/ui/components/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import {
  ensureTilesetTiles,
  normalizeTilesetPayload,
  type TilesetCollision,
  type TilesetPayload,
  type TilesetTile,
} from "@babylonslate/assets";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { TexturePreviewStatus, useTexturePreview } from "./texture-preview-status";
import { useOptionalTilesetEditing } from "../context/tileset-editing-context";

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
    <div className="flex min-h-0 flex-1 flex-col" onErrorCapture={preview.fail}>
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
        <ToggleGroup
          variant="outline"
          size="touch"
          spacing={1}
          value={[previewTool]}
          onValueChange={(value) => {
            const next = value[0] as AtlasTileGridTool | undefined;
            if (next) setPreviewTool(next);
          }}
          aria-label="Tileset preview tool"
          data-testid="tileset-preview-tools"
        >
          <ToggleGroupItem value="move" data-testid="tileset-tool-move">
            <HandIcon />
            Move
          </ToggleGroupItem>
          <ToggleGroupItem value="select" data-testid="tileset-tool-select">
            <MousePointerIcon />
            Select
          </ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={1}
          value={[collisionValue]}
          onValueChange={(value) => {
            const next = value[0];
            if (!next || !selected) return;
            patchTiles(selectedIds, { collision: collisionFromEnum(next) });
          }}
          aria-label="Tile Collision"
          data-testid="tileset-collision-tools"
        >
          <ToggleGroupItem value="none" data-testid="tileset-collision-none">
            None
          </ToggleGroupItem>
          <ToggleGroupItem value="full" data-testid="tileset-collision-full">
            Full
          </ToggleGroupItem>
          <ToggleGroupItem value="chain" data-testid="tileset-collision-chain">
            Chain
          </ToggleGroupItem>
        </ToggleGroup>
        <Toggle
          variant="outline"
          size="sm"
          pressed={editing?.paintCollision ?? false}
          onPressedChange={(pressed) => editing?.setPaintCollision(pressed)}
          data-testid="tileset-paint-collision"
        >
          Paint Collision
        </Toggle>
      </div>
      <AtlasTileGrid
        tileset={tileset}
        imageUrl={url}
        selectedId={selectedId}
        selectedIds={selectedIds}
        panZoom
        tool={previewTool}
        emptyLabel={preview.status === "failed" ? "" : preview.status === "missing" ? "Missing Texture" : preview.status === "empty" ? "No Texture" : "Loading Texture…"}
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
  const { assetRegistry } = useDocuments();
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
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
      <div className="px-2 py-2">
        <Button
          variant="outline"
          size="sm"
          disabled={
            Math.floor(tileSize.width) === tileset.tileWidth &&
            Math.floor(tileSize.height) === tileset.tileHeight
          }
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
      <p
        className="px-2 pt-2 text-sm font-medium"
        data-testid="tileset-selected-label"
      >
        {selectedIds.length > 1
          ? `Selected Tiles (${selectedIds.length})`
          : `Selected Tile ${selected?.id ?? 1}`}
      </p>
      <PropertyGrid
        title={selectedIds.length > 1 ? "Selected Tiles" : "Selected Tile"}
        rows={tileRows}
      />
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
