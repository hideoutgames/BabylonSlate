import { useState } from "react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  createDefaultSpritePayload,
  type SpritePayload,
} from "@babylonslate/assets";
import { useDocuments } from "../context/document-context";

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
    <PanelFrame className="flex-1" title="Sprite">
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
    </PanelFrame>
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
