import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Maximize2Icon, RotateCcwIcon, ScanIcon, SquareDashedIcon } from "lucide-react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  ToolbarStrip,
  assetRowIdentity,
  usePanZoomSurface,
  type PanZoomBase,
  type PropertyRow,
} from "@haptic/editor-kit";
import {
  createDefaultSpritePayload,
  parseSpriteCollision,
  parseSpritePivot,
  type SpriteCollision,
  type SpritePayload,
} from "@haptic/assets";
import { Button } from "@haptic/ui/components/button";
import { Separator } from "@haptic/ui/components/separator";
import { Toggle } from "@haptic/ui/components/toggle";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { cn } from "@haptic/ui/lib/utils";
import {
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { SpriteCollisionOverlay } from "./sprite-collision-overlay";
import { TexturePreviewStatus, useTexturePreview } from "./texture-preview-status";

export function SpritePreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="sprite-preview-panel">
      <SpritePreview
        payload={payload}
        onChange={(next, mergeKey) => {
          void applyAssetDocumentChange(documentId, next, mergeKey);
        }}
      />
    </PanelFrame>
  );
}

export function SpriteDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="sprite-details-panel">
      <SpriteEditor
        payload={payload}
        onChange={(next, mergeKey) => {
          void applyAssetDocumentChange(documentId, next, mergeKey);
        }}
      />
    </PanelFrame>
  );
}

const TOOL_ITEM = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const CHECKERBOARD =
  "conic-gradient(var(--muted) 0.25turn, var(--background) 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, var(--background) 0.75turn)";
/** Surface pixels kept clear around a fitted frame. */
const FIT_INSET = 24;

const isFullFrame = (box: SpriteCollision) => box.x === 0 && box.y === 0 && box.width === 1 && box.height === 1;

export function SpritePreview({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  /** A collision drag passes one merge key so the whole drag is one undo step. */
  onChange?: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const sprite = normalizeSprite(payload);
  const preview = useTexturePreview(sprite.textureGuid);
  const { url } = preview;
  const frame = sprite.frames[0];
  const [zoom, setZoom] = useState<PanZoomBase>("fit");
  const [showCollision, setShowCollision] = useState(true);
  const [textureSize, setTextureSize] = useState<{ width: number; height: number } | null>(null);

  const u = frame?.u ?? 0;
  const v = frame?.v ?? 0;
  const uSize = Math.max(frame?.uSize ?? 1, 0.0001);
  const vSize = Math.max(frame?.vSize ?? 1, 0.0001);
  const pivotX = frame?.pivot.x ?? 0.5;
  const pivotY = frame?.pivot.y ?? 0.5;
  const collision = parseSpriteCollision(frame?.collision);
  // The frame's own pixel size keeps its aspect ratio and lets collision snap to pixels.
  const framePixels = url && textureSize
    ? { width: Math.max(1, Math.round(textureSize.width * uSize)), height: Math.max(1, Math.round(textureSize.height * vSize)) }
    : null;
  const panZoom = usePanZoomSurface({ content: framePixels, base: zoom, inset: FIT_INSET, enabled: url !== null });
  const view = panZoom.view;
  const scale = view?.scale ?? 1;

  const writeCollision = (next: SpriteCollision) => {
    if (!onChange) return;
    const frames = [...sprite.frames];
    if (frames[0]) {
      frames[0] = { ...frames[0], collision: next };
    }
    onChange({ ...sprite, frames }, "sprite:collision");
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="sprite-preview">
      <ToolbarStrip className="shrink-0 gap-2 py-1" data-testid="sprite-preview-toolbar">
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          // After a pan or zoom neither is pressed; either one returns to its view.
          value={panZoom.adjusted ? [] : [zoom]}
          onValueChange={(value) => {
            const next = value[0] as PanZoomBase | undefined;
            if (!next) return;
            setZoom(next);
            panZoom.reset();
          }}
          aria-label="Preview Zoom"
        >
          <ToggleGroupItem value="fit" className={TOOL_ITEM} data-testid="sprite-zoom-fit">
            <Maximize2Icon />
            Fit
          </ToggleGroupItem>
          <ToggleGroupItem value="actual" className={TOOL_ITEM} data-testid="sprite-zoom-actual">
            <ScanIcon />
            Actual Size
          </ToggleGroupItem>
        </ToggleGroup>
        <Separator orientation="vertical" className="my-1" />
        <Toggle
          size="sm"
          variant="outline"
          className={TOOL_ITEM}
          pressed={showCollision}
          onPressedChange={setShowCollision}
          aria-label="Edit Collision"
          data-testid="sprite-collision-toggle"
        >
          <SquareDashedIcon />
          Collision
        </Toggle>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={TOOL_ITEM}
          disabled={!onChange || isFullFrame(collision)}
          onClick={() => writeCollision({ x: 0, y: 0, width: 1, height: 1 })}
          data-testid="sprite-collision-reset"
        >
          <RotateCcwIcon />
          Reset Collision
        </Button>
        <span className="ml-auto flex min-w-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
          {framePixels ? (
            <>
              <span className="truncate" data-testid="sprite-preview-size">{framePixels.width} × {framePixels.height}</span>
              <span data-testid="sprite-preview-zoom">{Math.round(scale * 100)}%</span>
            </>
          ) : null}
        </span>
      </ToolbarStrip>
      <div
        ref={panZoom.surfaceRef}
        {...(url ? panZoom.surfaceProps : {})}
        data-testid="sprite-preview-surface"
        className={cn("relative min-h-0 flex-1 overflow-hidden bg-sidebar", url && "cursor-grab touch-none active:cursor-grabbing")}
      >
        {url ? (
          <div
            data-testid="sprite-preview-frame"
            className={cn("absolute ring-1 ring-border", !view && "invisible")}
            style={{
              backgroundImage: CHECKERBOARD,
              backgroundSize: "16px 16px",
              ...(view && framePixels
                ? { left: view.x, top: view.y, width: framePixels.width * scale, height: framePixels.height * scale }
                : {}),
            }}
          >
            <div className="absolute inset-0 overflow-hidden">
              <img
                src={url}
                onError={preview.fail}
                onLoad={(event) => setTextureSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                alt=""
                draggable={false}
                className={cn("absolute max-w-none select-none", scale >= 2 && "[image-rendering:pixelated]")}
                style={{
                  width: `${100 / uSize}%`,
                  height: `${100 / vSize}%`,
                  left: `${(-u / uSize) * 100}%`,
                  top: `${(-v / vSize) * 100}%`,
                }}
              />
            </div>
            <SpritePivotMarker x={pivotX} y={pivotY} />
            {showCollision ? (
              <SpriteCollisionOverlay collision={collision} pixels={framePixels} onChange={writeCollision} />
            ) : null}
          </div>
        ) : (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/90">
            <TexturePreviewStatus preview={preview} />
          </div>
        )}
      </div>
    </div>
  );
}

function SpritePivotMarker({ x, y }: { x: number; y: number }) {
  return (
    <div
      data-testid="sprite-pivot-marker"
      className="pointer-events-none absolute z-30"
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, transform: "translate(-50%, -50%)" }}
    >
      <div className="relative size-4">
        <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-primary" />
        <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-primary" />
      </div>
    </div>
  );
}

export function SpriteEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  /** `mergeKey` groups one scrub's edits into one undo entry. */
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const sprite = normalizeSprite(payload);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Continuous field edit: one scrub on `field` is one undo step. */
  const edit = (next: SpritePayload, field: string) =>
    onChange(next as unknown as Record<string, unknown>, `sprite:${field}`);
  const { assetRegistry } = useRegistryState();
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const textureName = assets.find((asset) => asset.guid === sprite.textureGuid)
    ?.name;
  const frame = sprite.frames[0];
  const rows: PropertyRow[] = [
    {
      id: "texture",
      kind: "asset",
      label: "Texture",
      value: sprite.textureGuid,
      placeholder: "None",
      onPick: () => setPickerOpen(true),
      onChange: (value) => onChange({ ...sprite, textureGuid: value }),
      ...assetRowIdentity(
        textureName ? { name: textureName, type: "Texture" } : undefined,
      ),
    },
    {
      id: "ppu",
      kind: "number",
      label: "Pixels Per Unit",
      value: sprite.pixelsPerUnit,
      onChange: (value) => edit({ ...sprite, pixelsPerUnit: value }, "pixelsPerUnit"),
    },
    {
      id: "pivot",
      kind: "vector3",
      label: "Pivot",
      value: [frame?.pivot.x ?? 0.5, frame?.pivot.y ?? 0.5, 0],
      axes: ["X", "Y"],
      onChange: ([x, y]) => {
        const frames = [...sprite.frames];
        if (frames[0]) {
          frames[0] = { ...frames[0], pivot: { x, y } };
        }
        edit({ ...sprite, frames }, "pivot");
      },
    },
    {
      id: "frame-duration",
      kind: "number",
      label: "Frame Duration",
      unit: "ms",
      value: frame?.durationMs ?? 100,
      min: 1,
      onChange: (durationMs) => {
        const frames = [...sprite.frames];
        if (frames[0]) {
          frames[0] = { ...frames[0], durationMs };
        }
        edit({ ...sprite, frames }, "durationMs");
      },
    },
    {
      id: "collision",
      kind: "vector3",
      label: "Collision",
      value: [
        parseSpriteCollision(frame?.collision).x,
        parseSpriteCollision(frame?.collision).y,
        parseSpriteCollision(frame?.collision).width,
        parseSpriteCollision(frame?.collision).height,
      ],
      axes: ["X", "Y", "W", "H"],
      onChange: ([x, y, width, height]) => {
        const frames = [...sprite.frames];
        if (frames[0]) {
          frames[0] = {
            ...frames[0],
            collision: parseSpriteCollision({ x, y, width, height }),
          };
        }
        edit({ ...sprite, frames }, "collision");
      },
    },
  ];
  return (
    <div data-testid="sprite-editor">
      <PropertyGrid rows={rows} />
      <AssetPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        assets={assets}
        allowedTypes={["Texture"]}
        onPick={(guid) => {
          onChange({ ...sprite, textureGuid: guid });
          setPickerOpen(false);
        }}
        data-testid="sprite-texture-picker"
      />
    </div>
  );
}

function normalizeSprite(payload: Record<string, unknown>): SpritePayload {
  const defaults = createDefaultSpritePayload();
  const source = payload as Partial<SpritePayload>;
  return {
    textureGuid:
      typeof source.textureGuid === "string" && source.textureGuid.length > 0
        ? source.textureGuid
        : source.textureGuid === null
          ? null
          : defaults.textureGuid,
    pixelsPerUnit:
      typeof source.pixelsPerUnit === "number" && Number.isFinite(source.pixelsPerUnit)
        ? source.pixelsPerUnit
        : defaults.pixelsPerUnit,
    frames: Array.isArray(source.frames) && source.frames.length > 0
      ? source.frames.map((frame) => ({
          ...frame,
          pivot: parseSpritePivot(frame.pivot),
          collision: parseSpriteCollision(frame.collision),
        }))
      : defaults.frames,
    clips: Array.isArray(source.clips) && source.clips.length > 0
      ? source.clips
      : defaults.clips,
  };
}
