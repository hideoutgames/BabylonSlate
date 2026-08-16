import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  createDefaultSpritePayload,
  type SpritePayload,
} from "@babylonslate/assets";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";

export function SpritePreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="sprite-preview-panel">
      <SpritePreview payload={payload} />
    </PanelFrame>
  );
}

export function SpriteDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="sprite-details-panel" title="Details">
      <SpriteEditor
        payload={payload}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}

export function SpritePreview({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const sprite = normalizeSprite(payload);
  const { assetRegistry, readAssetChunk } = useDocuments();
  const [url, setUrl] = useState<string | null>(null);
  const texture = (assetRegistry?.list() ?? []).find(
    (asset) => asset.header.guid === sprite.textureGuid,
  );
  const frame = sprite.frames[0];

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

  const u = frame?.u ?? 0;
  const v = frame?.v ?? 0;
  const uSize = Math.max(frame?.uSize ?? 1, 0.0001);
  const vSize = Math.max(frame?.vSize ?? 1, 0.0001);
  const pivotX = frame?.pivot.x ?? 0.5;
  const pivotY = frame?.pivot.y ?? 0.5;

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="sprite-preview">
      <div
        className="relative aspect-square w-full overflow-hidden rounded-md border border-border"
        style={{
          backgroundImage:
            "conic-gradient(#808080 0.25turn, #c0c0c0 0.25turn 0.5turn, #808080 0.5turn 0.75turn, #c0c0c0 0.75turn)",
          backgroundSize: "16px 16px",
        }}
      >
        {url ? (
          <div className="absolute inset-0 overflow-hidden">
            <img
              src={url}
              alt=""
              className="absolute max-w-none"
              style={{
                width: `${100 / uSize}%`,
                height: `${100 / vSize}%`,
                left: `${(-u / uSize) * 100}%`,
                top: `${(-v / vSize) * 100}%`,
              }}
            />
          </div>
        ) : (
          <p className="absolute inset-0 flex items-center justify-center p-3 text-center text-sm text-muted-foreground">
            {sprite.textureGuid ? "Loading texture…" : "No Texture"}
          </p>
        )}
        <div
          data-testid="sprite-pivot-marker"
          className="pointer-events-none absolute z-10"
          style={{
            left: `${pivotX * 100}%`,
            top: `${pivotY * 100}%`,
            transform: "translate(-50%, -50%)",
          }}
        >
          <div className="relative size-4">
            <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-primary" />
            <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-primary" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function SpriteEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const sprite = normalizeSprite(payload);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { assetRegistry } = useDocuments();
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const textureName = assets.find((asset) => asset.guid === sprite.textureGuid)
    ?.name;
  const frame = sprite.frames[0];
  const clip = sprite.clips[0];
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
      onChange: (value) => onChange({ ...sprite, pixelsPerUnit: value }),
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
        onChange({ ...sprite, frames });
      },
    },
    {
      id: "frame-duration",
      kind: "number",
      label: "Frame Duration MS",
      value: frame?.durationMs ?? 100,
      min: 1,
      onChange: (durationMs) => {
        const frames = [...sprite.frames];
        if (frames[0]) {
          frames[0] = { ...frames[0], durationMs };
        }
        onChange({ ...sprite, frames });
      },
    },
    {
      id: "clip-name",
      kind: "text",
      label: "Clip Name",
      value: clip?.name ?? "Idle",
      onChange: (name) => {
        const clips = [...sprite.clips];
        if (clips[0]) {
          clips[0] = { ...clips[0], name };
        } else {
          clips.push({ name, frames: frame ? [frame.name] : [] });
        }
        onChange({ ...sprite, clips });
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
      ? source.frames
      : defaults.frames,
    clips: Array.isArray(source.clips) && source.clips.length > 0
      ? source.clips
      : defaults.clips,
  };
}
