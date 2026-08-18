import { useEffect, useRef, useState } from "react";
import {
  AssetPicker,
  NamedListEditor,
  NumericDragField,
  PanelFrame,
  PropertyGrid,
  SelectableText,
  assetRowIdentity,
  selectedPickerIdentity,
} from "@babylonslate/editor-kit";
import type { PropertyRow } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Input } from "@babylonslate/ui/components/input";
import { glyphsFallingToFallback } from "@babylonslate/ui-runtime";
import {
  AUDIO_DEFAULT_SOURCE_CHUNK,
  AUDIO_MAX_CLIPS,
  AUDIO_PITCH_MAX,
  AUDIO_PITCH_MIN,
  allocateAudioClipChunkId,
  normalizeFontPayload,
  normalizeAudioPayload,
  mimeForAudioBytes,
} from "@babylonslate/assets";
import { BlackboardEditor } from "./blackboard-editor";
import { useDocuments } from "../context/document-context";
import { FontRegistry, BabylonAudioPlaybackBackend } from "@babylonslate/render";
import { familyFromAssetPayload, fontEditorStack } from "../lib/font-preview";
import {
  applyTextureMaxDimensionChange,
  patchTextureUsage,
  textureMaxDimensionSelectValue,
  TEXTURE_USAGE_OPTIONS,
  TEXTURE_MAX_DIMENSION_OPTIONS,
} from "../lib/asset-settings";
import { createAudioPreviewSession } from "../lib/audio-preview";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function AssetDocumentWorkspace({ documentId }: { documentId: string }) {
  const { openDocuments, applyAssetDocumentChange, assetRegistry } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  if (!doc) return null;
  const payload = asRecord(doc.content);
  const commit = (next: Record<string, unknown>, mergeKey?: string) => {
    void applyAssetDocumentChange(documentId, next, mergeKey);
  };
  if (doc.ref.kind === "font") {
    return (
      <FontEditor
        path={doc.ref.path}
        payload={payload}
        onChange={commit}
      />
    );
  }
  if (doc.ref.kind === "blackboard") {
    return <BlackboardEditor payload={payload} onChange={commit} />;
  }
  if (doc.ref.kind === "asset-settings") {
    const indexed = assetRegistry
      ?.list()
      .find((asset) => asset.path === doc.ref.path);
    return (
      <AssetSettingsEditor
        assetType={indexed?.header.type ?? "Texture"}
        guid={indexed?.header.guid}
        path={doc.ref.path}
        dependencies={indexed?.header.dependencies ?? []}
        payload={payload}
        onChange={commit}
      />
    );
  }
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      Unsupported document
    </div>
  );
}

function FontEditor({
  path,
  payload,
  onChange,
}: {
  path: string;
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { projectDocument, assetRegistry, readAssetChunk } = useDocuments();
  const font = normalizeFontPayload(payload, "Custom Font");
  const [sample, setSample] = useState("The quick brown fox");
  const [fontsReady, setFontsReady] = useState(false);
  const [fallbackPick, setFallbackPick] = useState<number | "new" | null>(null);
  const fontAssets = (assetRegistry?.list() ?? [])
    .filter((asset) => asset.header.type === "Font" && asset.path !== path)
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));
  const familyForGuid = (guid: string): string | null => {
    const asset = assetRegistry?.getByGuid(guid);
    return familyFromAssetPayload(asset?.header.payload);
  };
  const stack = fontEditorStack({
    family: font.family,
    fallbackGuids: font.fallbackGuids,
    defaultFontGuid: projectDocument?.settings.fonts.defaultFontGuid ?? null,
    globalFallback: projectDocument?.settings.fonts.globalFallback ?? "sans-serif",
    familyForGuid,
  });
  useEffect(() => {
    let cancelled = false;
    const registry = new FontRegistry();
    void (async () => {
      const bytes = await readAssetChunk(path, "source");
      if (bytes && bytes.byteLength > 0) {
        const guid = assetRegistry?.list().find((asset) => asset.path === path)
          ?.header.guid ?? path;
        await registry.register({
          guid,
          family: font.family,
          bytes: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
          weight: font.weight,
          style: font.style,
        });
      }
      if (!cancelled) setFontsReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    assetRegistry,
    font.family,
    font.style,
    font.weight,
    path,
    readAssetChunk,
  ]);
  const flagged = glyphsFallingToFallback(
    sample,
    font.family,
    (text, measureStack) => {
      if (typeof document === "undefined") {
        return measureStack.includes(font.family) && /[A-Za-z]/.test(text)
          ? 10
          : 7;
      }
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) return 0;
      ctx.font = `16px ${measureStack}`;
      return ctx.measureText(text).width;
    },
  );
  return (
    <PanelFrame className="flex-1" title="Font">
      <div data-testid="font-editor">
        <PropertyGrid
          rows={[
            {
              id: "family",
              kind: "text",
              label: "Family",
              value: font.family,
              onChange: (value) => onChange({ ...font, family: value }),
            },
            {
              id: "sample",
              kind: "text",
              label: "Sample Text",
              value: sample,
              onChange: setSample,
            },
          ]}
        />
        <p
          className="px-3 text-sm"
          data-testid="font-sample-preview"
          data-fonts-ready={fontsReady ? "true" : "false"}
          data-font-stack={stack}
          style={{ fontFamily: stack }}
        >
          <SelectableText>{sample}</SelectableText>
        </p>
        <p
          className="px-3 text-xs text-muted-foreground"
          data-testid="font-fallback-glyphs"
        >
          {flagged.length > 0
            ? `Fallback glyphs: ${flagged.join(" ")}`
            : "No fallback glyphs detected"}
        </p>
        <div className="p-3">
          <NamedListEditor
            values={font.fallbackGuids}
            onChange={(fallbackGuids) => onChange({ ...font, fallbackGuids })}
            title="Fallbacks"
            addLabel="Add Fallback"
            onAdd={() => setFallbackPick("new")}
            data-testid="font-fallbacks"
            renderItem={({ value, index }) => (
              <Button
                type="button"
                variant="outline"
                className="min-h-[var(--touch-target,44px)] h-auto w-full justify-start"
                data-testid={`font-fallback-${index}`}
                onClick={() => setFallbackPick(index)}
              >
                {selectedPickerIdentity(
                  assetRowIdentity(
                    (() => {
                      const asset = assetRegistry?.getByGuid(value);
                      return asset
                        ? { name: asset.header.name, type: asset.header.type }
                        : undefined;
                    })(),
                  ),
                  value,
                )}
              </Button>
            )}
          />
        </div>
        <AssetPicker
          open={fallbackPick !== null}
          onOpenChange={(open) => {
            if (!open) setFallbackPick(null);
          }}
          assets={fontAssets}
          allowedTypes={["Font"]}
          title="Pick Fallback Font"
          allowNone={fallbackPick !== "new"}
          onPick={(guid) => {
            if (fallbackPick === "new") {
              if (guid) {
                onChange({
                  ...font,
                  fallbackGuids: [...font.fallbackGuids, guid],
                });
              }
            } else if (typeof fallbackPick === "number") {
              const fallbackGuids = [...font.fallbackGuids];
              if (guid) fallbackGuids[fallbackPick] = guid;
              else fallbackGuids.splice(fallbackPick, 1);
              onChange({ ...font, fallbackGuids });
            }
            setFallbackPick(null);
          }}
          data-testid="font-fallback-picker"
        />
      </div>
    </PanelFrame>
  );
}

function TexturePreview({
  path,
  payload,
}: {
  path: string;
  payload: Record<string, unknown>;
}) {
  const { readAssetChunk } = useDocuments();
  const [url, setUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      const bytes = await readAssetChunk(path, "pixels");
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
  }, [path, readAssetChunk]);

  const payloadWidth =
    typeof payload.sourceWidth === "number" ? payload.sourceWidth : null;
  const payloadHeight =
    typeof payload.sourceHeight === "number" ? payload.sourceHeight : null;
  const width = naturalSize?.width ?? payloadWidth;
  const height = naturalSize?.height ?? payloadHeight;

  return (
    <div className="flex flex-col gap-2" data-testid="texture-preview">
      <div
        className="relative aspect-square w-full max-w-64 overflow-hidden rounded-md border border-border"
        style={{
          backgroundImage:
            "conic-gradient(#808080 0.25turn, #c0c0c0 0.25turn 0.5turn, #808080 0.5turn 0.75turn, #c0c0c0 0.75turn)",
          backgroundSize: "16px 16px",
        }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            className="size-full object-contain"
            onLoad={(event) =>
              setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {width && height ? `${width} × ${height}` : "Source size unknown"}
      </p>
    </div>
  );
}

function AssetSettingsEditor({
  assetType,
  guid,
  path,
  dependencies,
  payload,
  onChange,
}: {
  assetType: string;
  guid?: string;
  path: string;
  dependencies: string[];
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { retryTextureEncoding } = useDocuments();
  if (assetType === "Audio") {
    return (
      <PanelFrame className="flex-1" title={assetType}>
        <div className="flex flex-col gap-3" data-testid="asset-settings">
          <AudioSettingsEditor
            path={path}
            payload={payload}
            onChange={onChange}
          />
        </div>
      </PanelFrame>
    );
  }
  const rows: PropertyRow[] = [];
  if (assetType === "Texture") {
    const usage = typeof payload.usage === "string" ? payload.usage : "albedo";
    const compression =
      typeof payload.compressionState === "string"
        ? payload.compressionState
        : "none";
    const encodeError =
      typeof payload.encodeError === "string" ? payload.encodeError : "";
    rows.push(
      {
        id: "usage",
        kind: "enum",
        label: "Usage",
        value: usage,
        options: TEXTURE_USAGE_OPTIONS.map((value) => ({
          value,
          label:
            value === "pixelArt"
              ? "Pixel Art"
              : value === "ui"
                ? "UI"
                : value.charAt(0).toUpperCase() + value.slice(1),
        })),
        onChange: (value) => onChange(patchTextureUsage(payload, value)),
      },
      {
        id: "maxDimension",
        kind: "enum",
        label: "Max Dimension",
        value: textureMaxDimensionSelectValue(payload),
        options: TEXTURE_MAX_DIMENSION_OPTIONS.map((value) => ({
          value,
          label: value === "source" ? "Source" : value,
        })),
        onChange: (value) => {
          const { payload: next, shouldRequeue } =
            applyTextureMaxDimensionChange(payload, value);
          onChange(next);
          if (!guid || !shouldRequeue) return;
          void retryTextureEncoding(guid, {
            force: true,
            maxDimension:
              typeof next.maxDimension === "number"
                ? next.maxDimension
                : undefined,
          });
        },
      },
      {
        id: "compression",
        kind: "text",
        label: "Compression",
        value: compression,
        disabled: true,
        onChange: () => undefined,
      },
    );
    if (encodeError) {
      rows.push({
        id: "encodeError",
        kind: "text",
        label: "Encode Error",
        value: encodeError,
        disabled: true,
        onChange: () => undefined,
      });
    }
  } else {
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === "number") {
        rows.push({
          id: key,
          kind: "number",
          label: key,
          value,
          onChange: (next) => onChange({ ...payload, [key]: next }),
        });
      } else if (typeof value === "boolean") {
        rows.push({
          id: key,
          kind: "boolean",
          label: key,
          value,
          onChange: (next) => onChange({ ...payload, [key]: next }),
        });
      } else if (typeof value === "string") {
        rows.push({
          id: key,
          kind: "text",
          label: key,
          value,
          onChange: (next) => onChange({ ...payload, [key]: next }),
        });
      }
    }
  }
  if (dependencies.length > 0) {
    rows.push({
      id: "dependencies",
      kind: "text",
      label: "Dependencies",
      value: String(dependencies.length),
      disabled: true,
      onChange: () => undefined,
    });
  }

  return (
    <PanelFrame className="flex-1" title={assetType}>
      <div className="flex flex-col gap-3" data-testid="asset-settings">
        {assetType === "Texture" ? (
          <TexturePreview path={path} payload={payload} />
        ) : null}
        <PropertyGrid rows={rows} />
      </div>
    </PanelFrame>
  );
}

function AudioSettingsEditor({
  path,
  payload,
  onChange,
}: {
  path: string;
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const {
    assetRegistry,
    readAssetChunk,
    writeAudioClipChunk,
    removeAudioClipChunk,
  } = useDocuments();
  const audio = normalizeAudioPayload(payload);
  const [pick, setPick] = useState<"channel" | "atten" | null>(null);
  const [playing, setPlaying] = useState(false);
  const clipInputRef = useRef<HTMLInputElement | null>(null);
  const previewSessionRef = useRef<ReturnType<
    typeof createAudioPreviewSession
  > | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const clipIds = audio.clips.map((clip) => clip.chunkId).join("|");
  const audioRef = useRef(audio);
  audioRef.current = audio;
  useEffect(() => {
    if (typeof AudioContext === "undefined") return;
    let session: ReturnType<typeof createAudioPreviewSession>;
    try {
      session = createAudioPreviewSession({
        backend: new BabylonAudioPlaybackBackend(),
        readChunk: (chunkId) => readAssetChunk(path, chunkId),
        onError: (error) => {
          setPreviewError(error.message);
          setPlaying(false);
        },
      });
    } catch {
      return;
    }
    previewSessionRef.current = session;
    void session.prefetch(audioRef.current);
    return () => {
      session.dispose();
      previewSessionRef.current = null;
    };
  }, [path, readAssetChunk, clipIds]);
  const assets = assetRegistry?.list() ?? [];
  const channel = assets.find(
    (asset) => asset.header.guid === audio.audioChannelGuid,
  );
  const atten = assets.find(
    (asset) => asset.header.guid === audio.soundAttenuationGuid,
  );
  const channelIdentity = channel
    ? assetRowIdentity({
        name: channel.header.name,
        type: channel.header.type,
      })
    : {};
  const attenIdentity = atten
    ? assetRowIdentity({
        name: atten.header.name,
        type: atten.header.type,
      })
    : {};

  const stopPreview = () => {
    previewSessionRef.current?.stop();
    setPlaying(false);
  };

  const playPreview = () => {
    const session = previewSessionRef.current;
    if (!session) {
      setPreviewError("Audio preview is unavailable.");
      setPlaying(false);
      return;
    }
    const result = session.play(audio);
    if (!result.ok) {
      setPreviewError(result.message ?? "Audio preview failed.");
      setPlaying(false);
      return;
    }
    setPreviewError(null);
    setPlaying(true);
  };

  return (
    <>
      <div className="flex flex-col gap-3" data-testid="audio-preview">
        <Button
          type="button"
          variant="outline"
          className="min-h-[var(--touch-target,44px)] w-fit"
          data-testid={playing ? "audio-preview-stop" : "audio-preview-play"}
          onClick={() => {
            if (playing) {
              stopPreview();
              return;
            }
            playPreview();
          }}
        >
          {playing ? "Stop" : "Play"}
        </Button>
        {previewError ? (
          <Alert data-testid="audio-preview-error">
            <AlertTitle>Preview Failed</AlertTitle>
            <AlertDescription>{previewError}</AlertDescription>
          </Alert>
        ) : null}
        <PropertyGrid
          rows={[
            {
              id: "volume",
              kind: "number",
              label: "Volume",
              value: audio.volume,
              min: 0,
              max: 1,
              onChange: (volume) => onChange({ ...audio, volume }),
            },
            {
              id: "pitch",
              kind: "number",
              label: "Pitch",
              value: audio.pitch,
              min: AUDIO_PITCH_MIN,
              max: AUDIO_PITCH_MAX,
              onChange: (pitch) => onChange({ ...audio, pitch }),
            },
            {
              id: "pitchRandom",
              kind: "boolean",
              label: "Randomize Pitch",
              value: audio.pitchRandom,
              onChange: (pitchRandom) => onChange({ ...audio, pitchRandom }),
            },
            ...(audio.pitchRandom
              ? [
                  {
                    id: "pitchMin",
                    kind: "number" as const,
                    label: "Pitch Min",
                    value: audio.pitchMin,
                    min: AUDIO_PITCH_MIN,
                    max: AUDIO_PITCH_MAX,
                    onChange: (pitchMin: number) =>
                      onChange({ ...audio, pitchMin }),
                  },
                  {
                    id: "pitchMax",
                    kind: "number" as const,
                    label: "Pitch Max",
                    value: audio.pitchMax,
                    min: AUDIO_PITCH_MIN,
                    max: AUDIO_PITCH_MAX,
                    onChange: (pitchMax: number) =>
                      onChange({ ...audio, pitchMax }),
                  },
                ]
              : []),
            {
              id: "audioChannelGuid",
              kind: "asset",
              label: "Audio Channel",
              value: audio.audioChannelGuid,
              displayLabel: channelIdentity.displayLabel,
              displayType: channelIdentity.displayType,
              visual: channelIdentity.visual,
              placeholder: "None",
              onPick: () => setPick("channel"),
              onChange: (audioChannelGuid) =>
                onChange({ ...audio, audioChannelGuid }),
            },
            {
              id: "soundAttenuationGuid",
              kind: "asset",
              label: "Sound Attenuation",
              value: audio.soundAttenuationGuid,
              displayLabel: attenIdentity.displayLabel,
              displayType: attenIdentity.displayType,
              visual: attenIdentity.visual,
              placeholder: "None",
              onPick: () => setPick("atten"),
              onChange: (soundAttenuationGuid) =>
                onChange({ ...audio, soundAttenuationGuid }),
            },
          ]}
        />
        <FieldGroup className="gap-2" data-testid="audio-clips">
          {audio.clips.map((clip, index) => (
            <Field
              key={clip.chunkId}
              className="gap-1 rounded-md border border-border p-2"
            >
              <FieldLabel htmlFor={`audio-clip-${index}-name`}>Name</FieldLabel>
              <Input
                id={`audio-clip-${index}-name`}
                className="min-h-[var(--touch-target,44px)]"
                value={clip.name}
                data-testid={`audio-clip-${index}-name`}
                onChange={(event) => {
                  const clips = audio.clips.map((entry, clipIndex) =>
                    clipIndex === index
                      ? { ...entry, name: event.target.value }
                      : entry,
                  );
                  onChange({ ...audio, clips });
                }}
              />
              <FieldLabel htmlFor={`audio-clip-${index}-weight`}>
                Weight
              </FieldLabel>
              <NumericDragField
                id={`audio-clip-${index}-weight`}
                value={clip.weight}
                min={0}
                data-testid={`audio-clip-${index}-weight`}
                onChange={(weight) => {
                  const clips = audio.clips.map((entry, clipIndex) =>
                    clipIndex === index ? { ...entry, weight } : entry,
                  );
                  onChange({ ...audio, clips });
                }}
              />
              {clip.chunkId === AUDIO_DEFAULT_SOURCE_CHUNK ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-[var(--touch-target,44px)] w-fit"
                  data-testid={`audio-clip-${index}-remove`}
                  onClick={() => {
                    const clips = audio.clips.filter(
                      (entry) => entry.chunkId !== clip.chunkId,
                    );
                    void removeAudioClipChunk?.(path, clip.chunkId, {
                      ...audio,
                      clips,
                    });
                    onChange({ ...audio, clips });
                  }}
                >
                  Remove
                </Button>
              )}
            </Field>
          ))}
          <input
            ref={clipInputRef}
            type="file"
            accept=".wav,.mp3,.ogg"
            className="hidden"
            data-testid="audio-add-clip-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              const chunkId = allocateAudioClipChunkId(
                audio.clips.map((clip) => clip.chunkId),
              );
              if (!chunkId) return;
              void file.arrayBuffer().then((buffer) => {
                const bytes = new Uint8Array(buffer);
                const clips = [
                  ...audio.clips,
                  {
                    chunkId,
                    name: file.name.replace(/\.[^.]+$/, ""),
                    weight: 1,
                  },
                ];
                void writeAudioClipChunk?.(
                  path,
                  chunkId,
                  bytes,
                  mimeForAudioBytes(bytes),
                  { ...audio, clips },
                );
                onChange({ ...audio, clips });
              });
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="min-h-[var(--touch-target,44px)] w-fit"
            data-testid="audio-add-clip"
            disabled={audio.clips.length >= AUDIO_MAX_CLIPS}
            onClick={() => clipInputRef.current?.click()}
          >
            Add Clip
          </Button>
        </FieldGroup>
      </div>
      <AssetPicker
        open={pick === "channel"}
        onOpenChange={(open) => {
          if (!open) setPick(null);
        }}
        assets={assets
          .filter((asset) => asset.header.type === "AudioChannel")
          .map((asset) => ({
            guid: asset.header.guid,
            name: asset.header.name,
            type: asset.header.type,
            path: asset.path,
          }))}
        allowedTypes={["AudioChannel"]}
        title="Pick Audio Channel"
        allowNone
        onPick={(audioChannelGuid) => {
          onChange({ ...audio, audioChannelGuid });
          setPick(null);
        }}
        data-testid="audio-channel-picker"
      />
      <AssetPicker
        open={pick === "atten"}
        onOpenChange={(open) => {
          if (!open) setPick(null);
        }}
        assets={assets
          .filter((asset) => asset.header.type === "SoundAttenuation")
          .map((asset) => ({
            guid: asset.header.guid,
            name: asset.header.name,
            type: asset.header.type,
            path: asset.path,
          }))}
        allowedTypes={["SoundAttenuation"]}
        title="Pick Sound Attenuation"
        allowNone
        onPick={(soundAttenuationGuid) => {
          onChange({ ...audio, soundAttenuationGuid });
          setPick(null);
        }}
        data-testid="audio-attenuation-picker"
      />
    </>
  );
}
