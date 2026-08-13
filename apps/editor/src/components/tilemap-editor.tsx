import { useEffect, useRef, useState } from "react";
import {
  EraserIcon,
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
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  SearchSheet,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  applyTilemapPaint,
  cellsAlongSegment,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  paintCanvasTileAt,
  pickTileId,
  tilemapStrokeMergeKey,
  type TilemapPaintTool,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";
import { useDocuments } from "../context/document-context";

const CELL_SIZE = 16;
const VIEW_TILES = 16;
const CANVAS_SIZE = CELL_SIZE * VIEW_TILES;

const TOOLS: Array<{
  id: TilemapPaintTool;
  label: string;
  icon: typeof PencilIcon;
}> = [
  { id: "brush", label: "Brush", icon: PencilIcon },
  { id: "eraser", label: "Eraser", icon: EraserIcon },
  { id: "rect", label: "Rect", icon: SquareIcon },
  { id: "bucket", label: "Bucket", icon: PaintBucketIcon },
  { id: "stamp", label: "Stamp", icon: StampIcon },
  { id: "picker", label: "Picker", icon: PipetteIcon },
];

export function TilemapEditor({
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tool, setTool] = useState<TilemapPaintTool>("brush");
  const [tileId, setTileId] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const panStartRef = useRef({ panX: 0, panY: 0, cx: 0, cy: 0 });
  const strokeRef = useRef<{
    id: string;
    base: TilemapPayload;
    start: { x: number; y: number };
    last: { x: number; y: number };
    cells: Array<{ x: number; y: number }>;
  } | null>(null);
  const { assetRegistry, openDocuments } = useDocuments();
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const tileset = resolveTileset(tilemap.tilesetGuid, assetRegistry, openDocuments);
  const layer = tilemap.layers[0];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawTilemapCanvas(ctx, tilemap, pan);
  }, [tilemap, pan]);

  const rows: PropertyRow[] = [
    {
      id: "tileset",
      kind: "asset",
      label: "Tileset",
      value: tilemap.tilesetGuid,
      placeholder: "None",
      onPick: () => setPickerOpen(true),
      onChange: (value) => onChange({ ...tilemap, tilesetGuid: value }),
    },
    {
      id: "tileWidth",
      kind: "number",
      label: "Tile Width",
      value: tilemap.tileWidth,
      onChange: (value) => onChange({ ...tilemap, tileWidth: value }),
    },
    {
      id: "tileHeight",
      kind: "number",
      label: "Tile Height",
      value: tilemap.tileHeight,
      onChange: (value) => onChange({ ...tilemap, tileHeight: value }),
    },
    {
      id: "chunkSize",
      kind: "number",
      label: "Chunk Size",
      value: tilemap.chunkSize,
      onChange: (value) => onChange({ ...tilemap, chunkSize: value }),
    },
  ];
  if (layer) {
    rows.push(
      {
        id: "layer-name",
        kind: "text",
        label: "Layer Name",
        value: layer.name,
        onChange: (name) =>
          onChange({
            ...tilemap,
            layers: tilemap.layers.map((entry) =>
              entry.id === layer.id ? { ...entry, name } : entry,
            ),
          }),
      },
      {
        id: "layer-collision",
        kind: "boolean",
        label: "Collision",
        value: layer.collision,
        onChange: (collision) =>
          onChange({
            ...tilemap,
            layers: tilemap.layers.map((entry) =>
              entry.id === layer.id ? { ...entry, collision } : entry,
            ),
          }),
      },
    );
  }

  const paletteItems = [
    { id: "0", label: "Empty", description: "Tile 0" },
    ...(tileset.tiles).map((tile) => ({
      id: String(tile.id),
      label: `Tile ${tile.id}`,
      description: collisionLabel(tile.collision),
    })),
  ];

  const cellAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return paintCanvasTileAt({
      localX: clientX - rect.left,
      localY: clientY - rect.top,
      canvasHeight: rect.height || CANVAS_SIZE,
      panX: pan.x,
      panY: pan.y,
      cellSize: CELL_SIZE,
    });
  };

  const commitStroke = (next: TilemapPayload, strokeId: string) => {
    onChange(next as unknown as Record<string, unknown>, tilemapStrokeMergeKey(strokeId));
  };

  const paintAt = (
    cell: { x: number; y: number },
    pointerType: "down" | "move",
  ) => {
    if (!layer || tool === "picker") return;
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
      tileId,
      start: stroke.start,
      end: stroke.last,
      cells: stroke.cells,
      stamp:
        tool === "stamp"
          ? { width: 2, height: 2, tiles: [tileId, tileId, tileId, tileId] }
          : undefined,
    });
    latestRef.current = painted;
    commitStroke(painted, stroke.id);
  };

  return (
    <PanelFrame className="flex-1" title="Tilemap">
      <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="tilemap-editor">
        <PropertyGrid rows={rows} />
        <div className="flex flex-wrap items-center gap-2 px-2">
          <ToggleGroup
            variant="outline"
            size="sm"
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
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="tilemap-palette-open"
            onClick={() => setPaletteOpen(true)}
          >
            Palette
          </Button>
        </div>
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          className="mx-2 mb-2 shrink-0 touch-none rounded-md border border-border bg-background"
          style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
          data-testid="tilemap-paint-canvas"
          data-tool={tool}
          data-tile={String(tileId)}
          data-cell-size={String(CELL_SIZE)}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            pointersRef.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            if (pointersRef.current.size >= 2) {
              strokeRef.current = null;
              const centroid = pointerCentroid(pointersRef.current);
              panStartRef.current = {
                panX: pan.x,
                panY: pan.y,
                cx: centroid.x,
                cy: centroid.y,
              };
              return;
            }
            const cell = cellAt(event.clientX, event.clientY);
            if (!cell || !layer) return;
            if (tool === "picker") {
              setTileId(pickTileId(tilemap, layer.id, cell.x, cell.y));
              return;
            }
            paintAt(cell, "down");
          }}
          onPointerMove={(event) => {
            const tracked = pointersRef.current.get(event.pointerId);
            if (!tracked) return;
            pointersRef.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            if (pointersRef.current.size >= 2) {
              const centroid = pointerCentroid(pointersRef.current);
              setPan({
                x: panStartRef.current.panX + (centroid.x - panStartRef.current.cx),
                y: panStartRef.current.panY + (centroid.y - panStartRef.current.cy),
              });
              return;
            }
            const cell = cellAt(event.clientX, event.clientY);
            if (!cell) return;
            paintAt(cell, "move");
          }}
          onPointerUp={(event) => {
            pointersRef.current.delete(event.pointerId);
            if (pointersRef.current.size === 0) strokeRef.current = null;
          }}
          onPointerCancel={(event) => {
            pointersRef.current.delete(event.pointerId);
            if (pointersRef.current.size === 0) strokeRef.current = null;
          }}
        />
        <AssetPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          assets={assets}
          allowedTypes={["Tileset"]}
          onPick={(guid) => {
            onChange({ ...tilemap, tilesetGuid: guid });
            setPickerOpen(false);
          }}
          data-testid="tilemap-tileset-picker"
        />
        <SearchSheet
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          title="Tile Palette"
          description="Choose a tile for brush, rect, bucket, and stamp."
          items={paletteItems}
          onSelect={(id) => setTileId(Number(id))}
          side="bottom"
          data-testid="tilemap-palette-sheet"
        />
      </div>
    </PanelFrame>
  );
}

function resolveTileset(
  guid: string | null,
  registry: ReturnType<typeof useDocuments>["assetRegistry"],
  openDocuments: ReturnType<typeof useDocuments>["openDocuments"],
): TilesetPayload {
  if (!guid) return normalizeTilesetPayload({});
  const asset = registry?.list().find((entry) => entry.header.guid === guid);
  if (!asset) return normalizeTilesetPayload({});
  const open = openDocuments.find((doc) => doc.ref.path === asset.path);
  if (open?.content) return normalizeTilesetPayload(open.content);
  return normalizeTilesetPayload({});
}

function collisionLabel(value: unknown): string {
  if (value === "full") return "Full";
  if (value === "none" || value == null) return "None";
  return "Chain";
}

function drawTilemapCanvas(
  ctx: CanvasRenderingContext2D,
  tilemap: TilemapPayload,
  pan: { x: number; y: number },
): void {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.fillStyle = "oklch(0.2 0 0)";
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const layer = tilemap.layers[0];
  if (layer) {
    for (const chunk of layer.chunks) {
      const size = tilemap.chunkSize;
      for (let ly = 0; ly < size; ly++) {
        for (let lx = 0; lx < size; lx++) {
          const id = chunk.tiles[ly * size + lx] ?? 0;
          if (id <= 0) continue;
          const gx = chunk.cx * size + lx;
          const gy = chunk.cy * size + ly;
          const screenX = gx * CELL_SIZE + pan.x;
          const screenY = CANVAS_SIZE - (gy + 1) * CELL_SIZE - pan.y;
          ctx.fillStyle = `hsl(${(id * 47) % 360} 55% 48%)`;
          ctx.fillRect(screenX, screenY, CELL_SIZE - 1, CELL_SIZE - 1);
        }
      }
    }
  }
  ctx.strokeStyle = "oklch(0.4 0 0 / 0.4)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= VIEW_TILES; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL_SIZE, 0);
    ctx.lineTo(i * CELL_SIZE, CANVAS_SIZE);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * CELL_SIZE);
    ctx.lineTo(CANVAS_SIZE, i * CELL_SIZE);
    ctx.stroke();
  }
}

function pointerCentroid(pointers: Map<number, { x: number; y: number }>): {
  x: number;
  y: number;
} {
  let x = 0;
  let y = 0;
  for (const point of pointers.values()) {
    x += point.x;
    y += point.y;
  }
  const n = Math.max(1, pointers.size);
  return { x: x / n, y: y / n };
}

function newStrokeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
