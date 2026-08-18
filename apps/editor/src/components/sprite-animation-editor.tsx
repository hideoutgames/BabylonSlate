import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  createDefaultSpriteAnimationPayload,
  parseSpriteAnimationPayload,
  parseSpriteCollision,
  parseSpritePivot,
  pngPixelSize,
  type SpriteAnimationPayload,
} from "@babylonslate/assets";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { SpriteCollisionOverlay } from "./sprite-collision-overlay";
import { objectContainRect } from "../lib/object-contain";
import { IconActionButton } from "./icon-action-button";
import { PlusIcon, Trash2Icon } from "lucide-react";

type SpriteAnimationEditingValue = {
  selectedFrameIndex: number;
  setSelectedFrameIndex: (index: number) => void;
};

const SpriteAnimationEditingContext =
  createContext<SpriteAnimationEditingValue | null>(null);

export function SpriteAnimationEditingProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0);
  const value = useMemo(
    () => ({ selectedFrameIndex, setSelectedFrameIndex }),
    [selectedFrameIndex],
  );
  return (
    <SpriteAnimationEditingContext.Provider value={value}>
      {children}
    </SpriteAnimationEditingContext.Provider>
  );
}

function useSpriteAnimationSelection(frameCount: number) {
  const ctx = useContext(SpriteAnimationEditingContext);
  const [localIndex, setLocalIndex] = useState(0);
  const selectedFrameIndex = ctx?.selectedFrameIndex ?? localIndex;
  const setSelectedFrameIndex = ctx?.setSelectedFrameIndex ?? setLocalIndex;
  const clamped =
    frameCount <= 0
      ? 0
      : Math.min(Math.max(0, selectedFrameIndex), frameCount - 1);
  useEffect(() => {
    if (clamped !== selectedFrameIndex) setSelectedFrameIndex(clamped);
  }, [clamped, selectedFrameIndex, setSelectedFrameIndex]);
  return { selectedFrameIndex: clamped, setSelectedFrameIndex };
}

function asPayload(payload: Record<string, unknown>): SpriteAnimationPayload {
  return parseSpriteAnimationPayload(payload);
}

export function SpriteAnimationPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="sprite-animation-preview-panel">
      <SpriteAnimationPreview
        payload={payload}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}

export function SpriteAnimationDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="sprite-animation-details-panel">
      <SpriteAnimationDetails
        payload={payload}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}

export function SpriteAnimationPreview({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange?: (next: Record<string, unknown>) => void;
}) {
  const animation = asPayload(payload);
  const { selectedFrameIndex, setSelectedFrameIndex } =
    useSpriteAnimationSelection(animation.frames.length);
  const { assetRegistry, readAssetChunk } = useDocuments();
  const frame = animation.frames[selectedFrameIndex];
  const texture = (assetRegistry?.list() ?? []).find(
    (asset) => asset.header.guid === frame?.textureGuid,
  );
  const [url, setUrl] = useState<string | null>(null);

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

  const pivot = parseSpritePivot(frame?.pivot);
  const collision = parseSpriteCollision(frame?.collision);
  const imageWidth = frame?.width && frame.width > 0 ? frame.width : 0;
  const imageHeight = frame?.height && frame.height > 0 ? frame.height : 0;
  const contain =
    imageWidth > 0 && imageHeight > 0
      ? objectContainRect(1, 1, imageWidth, imageHeight)
      : { left: 0, top: 0, width: 1, height: 1 };

  return (
    <div className="flex min-h-0 flex-col gap-2 p-3" data-testid="sprite-animation-preview">
      <div
        className="relative aspect-square w-full overflow-hidden rounded-md border border-border"
        style={{
          backgroundImage:
            "repeating-conic-gradient(var(--muted) 0% 25%, var(--background) 0% 50%)",
          backgroundSize: "16px 16px",
        }}
      >
        {url ? (
          <img src={url} alt="" className="absolute inset-0 size-full object-contain" />
        ) : (
          <p className="absolute inset-0 flex items-center justify-center p-3 text-center text-sm text-muted-foreground">
            {frame?.textureGuid ? "Loading texture…" : "No Texture"}
          </p>
        )}
        <div
          data-testid="sprite-animation-image-box"
          className="absolute z-10"
          style={{
            left: `${contain.left * 100}%`,
            top: `${contain.top * 100}%`,
            width: `${contain.width * 100}%`,
            height: `${contain.height * 100}%`,
          }}
        >
          <div
            data-testid="sprite-pivot-marker"
            className="pointer-events-none absolute z-10"
            style={{
              left: `${pivot.x * 100}%`,
              top: `${pivot.y * 100}%`,
              transform: "translate(-50%, -50%)",
            }}
          >
            <div className="relative size-4">
              <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-primary" />
              <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-primary" />
            </div>
          </div>
          <SpriteCollisionOverlay
            collision={collision}
            onChange={(next) => {
              if (!onChange) return;
              const frames = animation.frames.map((entry, index) =>
                index === selectedFrameIndex
                  ? { ...entry, collision: next }
                  : entry,
              );
              onChange({ ...animation, frames });
            }}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-1" data-testid="sprite-animation-frame-strip">
        {animation.frames.map((entry, index) => (
          <Button
            key={`${entry.textureGuid}-${index}`}
            type="button"
            size="sm"
            variant={index === selectedFrameIndex ? "default" : "outline"}
            data-testid={`sprite-animation-frame-${index}`}
            onClick={() => setSelectedFrameIndex(index)}
          >
            {index + 1}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function SpriteAnimationDetails({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const animation = asPayload(payload);
  const { selectedFrameIndex, setSelectedFrameIndex } =
    useSpriteAnimationSelection(animation.frames.length);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { assetRegistry, readAssetChunk } = useDocuments();
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const frame = animation.frames[selectedFrameIndex];
  const textureName = assets.find((asset) => asset.guid === frame?.textureGuid)
    ?.name;
  const collision = parseSpriteCollision(frame?.collision);
  const pivot = parseSpritePivot(frame?.pivot);

  const patchFrame = (
    patch: Partial<NonNullable<typeof frame>>,
  ): void => {
    const frames = [...animation.frames];
    if (!frames[selectedFrameIndex]) return;
    frames[selectedFrameIndex] = {
      ...frames[selectedFrameIndex]!,
      ...patch,
    };
    onChange({ ...animation, frames });
  };

  const applyTextureGuid = (guid: string | null): void => {
    if (!guid) {
      patchFrame({ textureGuid: "" });
      return;
    }
    const path = assets.find((asset) => asset.guid === guid)?.path;
    if (!path || !readAssetChunk) {
      patchFrame({ textureGuid: guid });
      return;
    }
    void (async () => {
      const pixels = await readAssetChunk(path, "pixels");
      const source =
        pixels && pixels.byteLength > 0
          ? pixels
          : await readAssetChunk(path, "source");
      const size = source && source.byteLength > 0 ? pngPixelSize(source) : null;
      patchFrame(
        size
          ? { textureGuid: guid, width: size.width, height: size.height }
          : { textureGuid: guid },
      );
    })();
  };

  const rows: PropertyRow[] = [
    {
      id: "texture",
      kind: "asset",
      label: "Texture",
      value: frame?.textureGuid || null,
      placeholder: "None",
      onPick: () => setPickerOpen(true),
      onChange: (value) => applyTextureGuid(value),
      ...assetRowIdentity(
        textureName ? { name: textureName, type: "Texture" } : undefined,
      ),
    },
    {
      id: "frame-duration",
      kind: "number",
      label: "Frame Duration MS",
      value: frame?.durationMs ?? 100,
      min: 1,
      onChange: (durationMs) => patchFrame({ durationMs }),
    },
    {
      id: "pivot",
      kind: "vector3",
      label: "Pivot",
      value: [pivot.x, pivot.y, 0],
      axes: ["X", "Y"],
      onChange: ([x, y]) => patchFrame({ pivot: { x, y } }),
    },
    {
      id: "collision",
      kind: "vector3",
      label: "Collision",
      value: [collision.x, collision.y, collision.width, collision.height],
      axes: ["X", "Y", "W", "H"],
      onChange: ([x, y, width, height]) =>
        patchFrame({
          collision: parseSpriteCollision({ x, y, width, height }),
        }),
    },
  ];

  return (
    <div data-testid="sprite-animation-editor" className="flex flex-col gap-2 p-3">
      <div className="flex gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="sprite-animation-add-frame"
          onClick={() => {
            const next = {
              ...createDefaultSpriteAnimationPayload().frames[0]!,
            };
            onChange({ ...animation, frames: [...animation.frames, next] });
            setSelectedFrameIndex(animation.frames.length);
          }}
        >
          <PlusIcon className="icon-sm" />
          Add Frame
        </Button>
        <IconActionButton
          label="Remove Frame"
          disabled={animation.frames.length <= 1}
          onClick={() => {
            const frames = animation.frames.filter(
              (_entry, index) => index !== selectedFrameIndex,
            );
            onChange({
              ...animation,
              frames:
                frames.length > 0
                  ? frames
                  : createDefaultSpriteAnimationPayload().frames,
            });
            setSelectedFrameIndex(Math.max(0, selectedFrameIndex - 1));
          }}
        >
          <Trash2Icon className="icon-sm" />
        </IconActionButton>
      </div>
      <PropertyGrid rows={rows} />
      <AssetPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        assets={assets}
        allowedTypes={["Texture"]}
        onPick={(guid) => {
          applyTextureGuid(guid);
          setPickerOpen(false);
        }}
        data-testid="sprite-animation-texture-picker"
      />
    </div>
  );
}
