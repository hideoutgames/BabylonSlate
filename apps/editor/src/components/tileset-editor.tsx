import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  AtlasTileGrid,
  PanelFrame,
  PropertyGrid,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Toggle } from "@babylonslate/ui/components/toggle";
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
import {
  useOptionalTilesetEditing,
} from "../context/tileset-editing-context";

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
    <PanelFrame data-testid="tileset-details-panel" title="Details">
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
  const tileset = ensureTilesetTiles(normalizeTilesetPayload(payload));
  const editing = useOptionalTilesetEditing();
  const [localSelectedId, setLocalSelectedId] = useState(
    tileset.tiles[0]?.id ?? 1,
  );
  const selectedId = editing?.selectedTileId ?? localSelectedId;
  const { assetRegistry, readAssetChunk } = useDocuments();
  const [url, setUrl] = useState<string | null>(null);
  const texture = (assetRegistry?.list() ?? []).find(
    (asset) => asset.header.guid === tileset.textureGuid,
  );
  const selected =
    tileset.tiles.find((tile) => tile.id === selectedId) ?? tileset.tiles[0];

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    if (!texture || !readAssetChunk) return;
    void (async () => {
      const bytes = await readAssetChunk(texture.path, "pixels");
      if (!bytes || cancelled || bytes.byteLength === 0) return;
      objectUrl = URL.createObjectURL(
        new Blob([bytes], { type: "image/png" }),
      );
      if (!cancelled) setUrl(objectUrl);
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [readAssetChunk, texture]);

  const commit = (next: TilesetPayload) => {
    onChange?.(ensureTilesetTiles(next) as unknown as Record<string, unknown>);
  };

  const patchTile = (tileId: number, patch: Partial<TilesetTile>) => {
    commit({
      ...tileset,
      tiles: tileset.tiles.map((tile) =>
        tile.id === tileId ? { ...tile, ...patch } : tile,
      ),
    });
  };

  const collisionValue = collisionEnum(selected?.collision);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={1}
          value={[collisionValue]}
          onValueChange={(value) => {
            const next = value[0];
            if (!next || !selected) return;
            patchTile(selected.id, { collision: collisionFromEnum(next) });
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
        panZoom
        emptyLabel={tileset.textureGuid ? "Loading texture…" : "No Texture"}
        data-testid="tileset-preview"
        onSelect={(id) => {
          if (editing) editing.setSelectedTileId(id);
          else setLocalSelectedId(id);
          if (editing?.paintCollision && selected) {
            patchTile(id, { collision: selected.collision });
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
  const tileset = ensureTilesetTiles(normalizeTilesetPayload(payload));
  const [pickerOpen, setPickerOpen] = useState(false);
  const editing = useOptionalTilesetEditing();
  const selectedId = editing?.selectedTileId ?? tileset.tiles[0]?.id ?? 1;
  const { assetRegistry } = useDocuments();
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const textureName = assets.find((asset) => asset.guid === tileset.textureGuid)
    ?.name;
  const selected =
    tileset.tiles.find((tile) => tile.id === selectedId) ?? tileset.tiles[0];

  const commit = (next: TilesetPayload) => {
    onChange(ensureTilesetTiles(next) as unknown as Record<string, unknown>);
  };

  const patchTile = (patch: Partial<TilesetTile>) => {
    if (!selected) return;
    commit({
      ...tileset,
      tiles: tileset.tiles.map((tile) =>
        tile.id === selected.id ? { ...tile, ...patch } : tile,
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
      value: tileset.tileWidth,
      onChange: (value) => commit({ ...tileset, tileWidth: value }),
    },
    {
      id: "tileHeight",
      kind: "number",
      label: "Tile Height",
      value: tileset.tileHeight,
      onChange: (value) => commit({ ...tileset, tileHeight: value }),
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
      <p className="px-2 pt-2 text-sm font-medium" data-testid="tileset-selected-label">
        Selected Tile {selected?.id ?? 1}
      </p>
      <PropertyGrid title="Selected Tile" rows={tileRows} />
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
        { x: 1, y: 1 },
        { x: 0, y: 1 },
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
