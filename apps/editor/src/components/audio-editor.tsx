import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  NumericDragField,
  PanelFrame,
  PropertyGrid,
  SelectableText,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Toggle } from "@babylonslate/ui/components/toggle";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import {
  AUDIO_DEFAULT_SOURCE_CHUNK,
  AUDIO_MAX_CLIPS,
  AUDIO_PITCH_MAX,
  AUDIO_PITCH_MIN,
  allocateAudioClipChunkId,
  fillEmptySourceClipName,
  mimeForAudioBytes,
  normalizeAudioPayload,
  type AudioPayload,
  type AudioWaveformPeak,
} from "@babylonslate/assets";
import { PlayIcon, RepeatIcon, SquareIcon } from "lucide-react";
import { BabylonAudioPlaybackBackend } from "@babylonslate/render";
import { IconActionButton } from "./icon-action-button";
import { AudioPreviewWaveform } from "./audio-preview-waveform";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { createAudioPreviewSession } from "../lib/audio-preview";
import { decodeAudioWaveformPeaks } from "../lib/audio-waveform-decode";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function useAudioDocument() {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange, assetRegistry } =
    useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = asRecord(doc?.content);
  const indexed = (assetRegistry?.list() ?? []).find(
    (asset) => asset.path === doc?.ref.path,
  );
  const assetName = indexed?.header.name ?? "";
  const commit = (next: AudioPayload | Record<string, unknown>) => {
    void applyAssetDocumentChange(
      documentId,
      next as unknown as Record<string, unknown>,
    );
  };
  return {
    path: doc?.ref.path ?? "",
    payload,
    assetName,
    commit,
  };
}

function persistFilledClipName(
  payload: Record<string, unknown>,
  assetName: string,
  onChange?: (next: Record<string, unknown>) => void,
): AudioPayload {
  const filled = fillEmptySourceClipName(payload, assetName);
  const current = normalizeAudioPayload(payload);
  const changed = filled.clips.some(
    (clip, index) => clip.name !== current.clips[index]?.name,
  );
  if (changed) onChange?.(filled);
  return filled;
}

export function AudioPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { path, payload, commit } = useAudioDocument();
  return (
    <PanelFrame data-testid="audio-preview-panel">
      <AudioPreview path={path} payload={payload} onChange={commit} />
    </PanelFrame>
  );
}

export function AudioDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, assetName, commit } = useAudioDocument();
  return (
    <PanelFrame data-testid="audio-details-panel">
      <AudioDetails payload={payload} assetName={assetName} onChange={commit} />
    </PanelFrame>
  );
}

export function AudioClipsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { path, payload, assetName, commit } = useAudioDocument();
  return (
    <PanelFrame data-testid="audio-clips-panel">
      <AudioClips
        path={path}
        payload={payload}
        assetName={assetName}
        onChange={commit}
      />
    </PanelFrame>
  );
}

export function AudioPreview({
  path,
  payload,
  onChange,
}: {
  path: string;
  payload: Record<string, unknown>;
  onChange?: (next: Record<string, unknown>) => void;
}) {
  const { readAssetChunk } = useDocuments();
  const audio = normalizeAudioPayload(payload);
  const [playing, setPlaying] = useState(false);
  const [waveformPeaks, setWaveformPeaks] = useState<AudioWaveformPeak[]>([]);
  const [waveformDuration, setWaveformDuration] = useState<number | null>(null);
  const previewSessionRef = useRef<ReturnType<
    typeof createAudioPreviewSession
  > | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const clipIds = audio.clips.map((clip) => clip.chunkId).join("|");
  const audioRef = useRef(audio);
  audioRef.current = audio;
  useEffect(() => {
    if (typeof AudioContext === "undefined") return;
    let cancelled = false;
    let session: ReturnType<typeof createAudioPreviewSession>;
    try {
      session = createAudioPreviewSession({
        backend: new BabylonAudioPlaybackBackend(),
        readChunk: (chunkId) => readAssetChunk(path, chunkId),
        onError: (error) => {
          setPreviewError(error.message);
          setPlaying(false);
        },
        onEnded: () => setPlaying(false),
      });
    } catch {
      return;
    }
    previewSessionRef.current = session;
    void (async () => {
      await session.prefetch(audioRef.current);
      if (cancelled) return;
      const clipId = audioRef.current.clips[0]?.chunkId;
      const bytes = clipId ? session.clipBytes(clipId) : undefined;
      if (!bytes) return;
      const waveform = await decodeAudioWaveformPeaks(bytes);
      if (cancelled) return;
      if (waveform) {
        setWaveformPeaks(waveform.peaks);
        setWaveformDuration(waveform.durationSeconds);
      } else {
        setWaveformPeaks([]);
        setWaveformDuration(null);
      }
    })();
    return () => {
      cancelled = true;
      session.dispose();
      previewSessionRef.current = null;
    };
  }, [path, readAssetChunk, clipIds]);

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
    const clipId = result.clipChunkId;
    if (!clipId) return;
    const bytes = session.clipBytes(clipId);
    if (!bytes) return;
    void decodeAudioWaveformPeaks(bytes).then((waveform) => {
      if (!waveform) return;
      setWaveformPeaks(waveform.peaks);
      setWaveformDuration(waveform.durationSeconds);
    });
  };

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="audio-preview">
      <div className="flex min-w-0 items-center gap-1">
        <IconActionButton
          type="button"
          size="touch-icon"
          label={playing ? "Stop" : "Play"}
          data-testid={playing ? "audio-preview-stop" : "audio-preview-play"}
          onClick={() => {
            if (playing) {
              stopPreview();
              return;
            }
            playPreview();
          }}
        >
          {playing ? (
            <SquareIcon className="icon-sm" />
          ) : (
            <PlayIcon className="icon-sm" />
          )}
        </IconActionButton>
        <Toggle
          size="touch"
          variant="outline"
          pressed={audio.loop}
          aria-label="Loop"
          data-testid="audio-preview-loop"
          onPressedChange={(loop) => onChange?.({ ...audio, loop })}
        >
          <RepeatIcon className="icon-sm" />
        </Toggle>
        <AudioPreviewWaveform
          peaks={waveformPeaks}
          durationSeconds={waveformDuration}
        />
      </div>
      {previewError ? (
        <Alert data-testid="audio-preview-error">
          <AlertTitle>Preview Failed</AlertTitle>
          <AlertDescription>{previewError}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function AudioDetails({
  payload,
  assetName,
  onChange,
}: {
  payload: Record<string, unknown>;
  assetName: string;
  onChange?: (next: Record<string, unknown>) => void;
}) {
  const { assetRegistry } = useDocuments();
  const audio = normalizeAudioPayload(payload);
  const [pick, setPick] = useState<"channel" | "atten" | null>(null);
  useEffect(() => {
    persistFilledClipName(payload, assetName, onChange);
  }, [assetName, onChange, payload]);
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
  const rows: PropertyRow[] = [
    {
      id: "volume",
      kind: "number",
      label: "Volume",
      value: audio.volume,
      min: 0,
      max: 1,
      onChange: (volume) => onChange?.({ ...audio, volume }),
    },
    {
      id: "loop",
      kind: "boolean",
      label: "Loop",
      value: audio.loop,
      onChange: (loop) => onChange?.({ ...audio, loop }),
    },
    {
      id: "pitchRandom",
      kind: "boolean",
      label: "Randomize Pitch",
      value: audio.pitchRandom,
      onChange: (pitchRandom) => onChange?.({ ...audio, pitchRandom }),
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
            onChange: (pitchMin: number) => onChange?.({ ...audio, pitchMin }),
          },
          {
            id: "pitchMax",
            kind: "number" as const,
            label: "Pitch Max",
            value: audio.pitchMax,
            min: AUDIO_PITCH_MIN,
            max: AUDIO_PITCH_MAX,
            onChange: (pitchMax: number) => onChange?.({ ...audio, pitchMax }),
          },
        ]
      : [
          {
            id: "pitch",
            kind: "number" as const,
            label: "Pitch",
            value: audio.pitch,
            min: AUDIO_PITCH_MIN,
            max: AUDIO_PITCH_MAX,
            onChange: (pitch: number) => onChange?.({ ...audio, pitch }),
          },
        ]),
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
      onChange: (audioChannelGuid) => onChange?.({ ...audio, audioChannelGuid }),
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
        onChange?.({ ...audio, soundAttenuationGuid }),
    },
  ];

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="audio-details">
      <PropertyGrid rows={rows} />
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
          onChange?.({ ...audio, audioChannelGuid });
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
          onChange?.({ ...audio, soundAttenuationGuid });
          setPick(null);
        }}
        data-testid="audio-attenuation-picker"
      />
    </div>
  );
}

export function AudioClips({
  path,
  payload,
  assetName,
  onChange,
}: {
  path: string;
  payload: Record<string, unknown>;
  assetName: string;
  onChange?: (next: Record<string, unknown>) => void;
}) {
  const { writeAudioClipChunk, removeAudioClipChunk } = useDocuments();
  const audio = fillEmptySourceClipName(payload, assetName);
  const clipInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    persistFilledClipName(payload, assetName, onChange);
  }, [assetName, onChange, payload]);

  return (
    <FieldGroup className="gap-2 p-3" data-testid="audio-clips">
      {audio.clips.map((clip, index) => (
        <Field
          key={clip.chunkId}
          className="gap-1 rounded-md border border-border p-2"
        >
          <FieldLabel>Name</FieldLabel>
          <span
            className="min-h-[var(--touch-target,44px)] flex items-center"
            data-testid={`audio-clip-${index}-name`}
          >
            <SelectableText>{clip.name}</SelectableText>
          </span>
          <FieldLabel htmlFor={`audio-clip-${index}-weight`}>Weight</FieldLabel>
          <NumericDragField
            id={`audio-clip-${index}-weight`}
            value={clip.weight}
            min={0}
            data-testid={`audio-clip-${index}-weight`}
            onChange={(weight) => {
              const clips = audio.clips.map((entry, clipIndex) =>
                clipIndex === index ? { ...entry, weight } : entry,
              );
              onChange?.({ ...audio, clips });
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
                onChange?.({ ...audio, clips });
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
            onChange?.({ ...audio, clips });
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
  );
}
