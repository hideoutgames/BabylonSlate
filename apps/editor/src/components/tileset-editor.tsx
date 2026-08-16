import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  SearchDropdown,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  ensureTilesetTiles,
  normalizeTilesetPayload,
  tilesetAtlasColumns,
  type TilesetCollision,
  type TilesetPayload,
  type TilesetTile,
} from "@babylonslate/assets";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";

export function TilesetPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="tileset-preview-panel">
      <TilesetPreview payload={payload} />
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
}: {
  payload: Record<string, unknown>;
}) {
  const tileset = ensureTilesetTiles(normalizeTilesetPayload(payload));
  const { assetRegistry, readAssetChunk } = useDocuments();
  const [url, setUrl] = useState<string | null>(null);
  const texture = (assetRegistry?.list() ?? []).find(
    (asset) => asset.header.guid === tileset.textureGuid,
  );

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

  const columns = tilesetAtlasColumns(tileset);

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="tileset-preview">
      <div
        className="relative w-full overflow-hidden rounded-md border border-border"
        style={{
          aspectRatio: `${Math.max(1, tileset.atlasWidth)} / ${Math.max(1, tileset.atlasHeight)}`,
          backgroundImage:
            "conic-gradient(#808080 0.25turn, #c0c0c0 0.25turn 0.5turn, #808080 0.5turn 0.75turn, #c0c0c0 0.75turn)",
          backgroundSize: "16px 16px",
        }}
      >
        {url ? (
          <img src={url} alt="" className="absolute inset-0 size-full" />
        ) : (
          <p className="absolute inset-0 flex items-center justify-center p-3 text-center text-sm text-muted-foreground">
            {tileset.textureGuid ? "Loading texture…" : "No Texture"}
          </p>
        )}
        <div
          className="pointer-events-none absolute inset-0 grid"
          style={{
            gridTemplateColumns: `repeat(${columns}, 1fr)`,
          }}
        >
          {tileset.tiles.map((tile) => (
            <span
              key={tile.id}
              className="border border-border/40 text-[10px] text-foreground/80"
              data-testid={`tileset-preview-cell-${tile.id}`}
            />
          ))}
        </div>
      </div>
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
  const [tilePickOpen, setTilePickOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(tileset.tiles[0]?.id ?? 1);
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
  const rows: PropertyRow[] = [
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
      onChange: (value) => commit({ ...tileset, atlasWidth: value }),
    },
    {
      id: "atlasHeight",
      kind: "number",
      label: "Atlas Height",
      value: tileset.atlasHeight,
      onChange: (value) => commit({ ...tileset, atlasHeight: value }),
    },
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
    rows.push({
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
      <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
        <SearchDropdown
          open={tilePickOpen}
          onOpenChange={setTilePickOpen}
          title="Tile"
          description="Choose a tile id to edit collision, flags, and animation."
          items={tileset.tiles.map((tile) => ({
            id: String(tile.id),
            label: `Tile ${tile.id}`,
            description: collisionLabel(tile.collision),
          }))}
          onSelect={(id) => setSelectedId(Number(id))}
          data-testid="tileset-tile-menu"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="tileset-tile-open"
          >
            Tile {selected?.id ?? 1}
          </Button>
        </SearchDropdown>
      </div>
      <PropertyGrid rows={rows} />
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

function collisionLabel(value: TilesetCollision): string {
  if (value === "full") return "Full";
  if (value && typeof value === "object") return "Chain";
  return "None";
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
