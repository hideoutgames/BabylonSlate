import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  assetRowIdentity,
  type PropertyRow,
} from "@haptic/editor-kit";
import {
  attenuationPlotEnd,
  attenuationPlotPoints,
  clampAudioGain,
  normalizeAudioChannelPayload,
  normalizeAudioMixerPayload,
  normalizeSoundAttenuationPayload,
  resolveSoundAttenuationCurve,
  setAudioChannelEffect,
  validateAudioMixer,
  type ResolvedSoundAttenuation,
  type SoundAttenuationPayload,
} from "@haptic/assets";
import { normalizeCurveAssetPayload, type Curve } from "@haptic/core";
import { Button } from "@haptic/ui/components/button";
import { FieldDescription } from "@haptic/ui/components/field";
import {
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  AUDIO_MIXER_EMPTY_CHANNELS_COPY,
  applyMixerChannelPick,
  type MixerChannelPickTarget,
} from "../lib/audio-mixer-edit";
import { soundAttenuationDetailRows } from "../lib/sound-attenuation-rows";
import { asRecord } from "../lib/as-record";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";

const FLOAT_CURVE_DOCUMENT_KINDS = ["float-curve"] as const;

function pickerAssets(
  list: ReadonlyArray<{
    header: { guid: string; name: string; type: string };
    path: string;
  }>,
  allowedTypes: readonly string[],
) {
  return list
    .filter((asset) => allowedTypes.includes(asset.header.type))
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));
}

/**
 * Volume (up) by distance (across) from 0 to a little past Max Radius, with the steps where the volume jumps and
 * faint guides at Inner Radius and Max Radius.
 */
export function AttenuationFalloffPlot({
  attenuation,
}: {
  attenuation: Pick<ResolvedSoundAttenuation, "innerRadius" | "maxRadius" | "curve">;
}) {
  const points = attenuationPlotPoints(attenuation, 48);
  const end = attenuationPlotEnd(attenuation);
  const x = (distance: number) => (distance / end) * 200;
  const path = points
    .map((point, index) => {
      const y = 60 - point.gain * 56;
      return `${index === 0 ? "M" : "L"} ${x(point.distance).toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox="0 0 200 64"
      className="w-full"
      data-testid="attenuation-falloff-plot"
      role="img"
      aria-label="Attenuation falloff"
    >
      <rect width="200" height="64" fill="transparent" />
      {[attenuation.innerRadius, attenuation.maxRadius].map((radius, index) => (
        <line
          key={index}
          x1={x(radius)}
          x2={x(radius)}
          y1={4}
          y2={60}
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeDasharray="2 2"
        />
      ))}
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function AudioMixerDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const doc = useOpenDocument(documentId);
  const mixer = normalizeAudioMixerPayload(asRecord(doc?.content));
  const [pickTarget, setPickTarget] = useState<MixerChannelPickTarget | null>(
    null,
  );
  const channels = assetRegistry?.list() ?? [];
  /** `mergeKey` groups one volume scrub into one undo entry. */
  const commit = (next: typeof mixer, mergeKey?: string) => {
    void applyAssetDocumentChange(documentId, next as unknown as Record<string, unknown>, mergeKey);
  };
  const duplicate = !validateAudioMixer(mixer).ok;

  const rows: PropertyRow[] = [
    {
      id: "globalVolume",
      kind: "number",
      label: "Global Volume",
      value: mixer.globalVolume,
      min: 0,
      max: 1,
      onChange: (globalVolume) =>
        commit(
          { ...mixer, globalVolume: clampAudioGain(globalVolume) },
          "audio-mixer:globalVolume",
        ),
    },
  ];

  mixer.channels.forEach((entry, index) => {
    const asset = channels.find((item) => item.header.guid === entry.channelGuid);
    const identity = asset
      ? assetRowIdentity({ name: asset.header.name, type: asset.header.type })
      : {};
    rows.push(
      {
        id: `channel-${index}`,
        kind: "asset",
        label: `Channel ${index + 1}`,
        value: entry.channelGuid,
        displayLabel: identity.displayLabel,
        displayType: identity.displayType,
        visual: identity.visual,
        placeholder: "None",
        onPick: () => setPickTarget(index),
        onChange: (channelGuid) =>
          commit(applyMixerChannelPick(mixer, index, channelGuid)),
      },
      {
        id: `channel-volume-${index}`,
        kind: "number",
        label: "Volume",
        value: entry.volume,
        min: 0,
        max: 1,
        onChange: (volume) => {
          const next = mixer.channels.map((row, i) =>
            i === index ? { ...row, volume: clampAudioGain(volume) } : row,
          );
          commit({ ...mixer, channels: next }, `audio-mixer:channel:${index}:volume`);
        },
      },
    );
  });

  return (
    <PanelFrame data-testid="audio-mixer-details-panel">
      <div className="flex flex-col gap-3 p-2">
        <PropertyGrid rows={rows} />
        {mixer.channels.length === 0 ? (
          <FieldDescription data-testid="audio-mixer-empty-channels">
            {AUDIO_MIXER_EMPTY_CHANNELS_COPY}
          </FieldDescription>
        ) : null}
        {duplicate ? (
          <p className="text-sm text-destructive" data-testid="audio-mixer-duplicate">
            Duplicate Audio Channel entries are invalid.
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className="min-h-[var(--touch-target,44px)]"
          data-testid="audio-mixer-add-channel"
          onClick={() => setPickTarget("new")}
        >
          Add Channel
        </Button>
      </div>
      <AssetPicker
        open={pickTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPickTarget(null);
        }}
        assets={pickerAssets(channels, ["AudioChannel"])}
        allowedTypes={["AudioChannel"]}
        title="Pick Audio Channel"
        allowNone={pickTarget !== "new"}
        onPick={(guid) => {
          if (pickTarget === null) return;
          commit(applyMixerChannelPick(mixer, pickTarget, guid));
          setPickTarget(null);
        }}
        data-testid="audio-mixer-channel-picker"
      />
    </PanelFrame>
  );
}

export function AudioChannelDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const doc = useOpenDocument(documentId);
  const channel = normalizeAudioChannelPayload(asRecord(doc?.content));
  const [pickParent, setPickParent] = useState(false);
  const channels = assetRegistry?.list() ?? [];
  const parent = channels.find(
    (asset) => asset.header.guid === channel.parentChannelGuid,
  );
  const identity = parent
    ? assetRowIdentity({ name: parent.header.name, type: parent.header.type })
    : {};
  const reverb = channel.effects.find((effect) => effect.kind === "environmentReverb");
  const muffle = channel.effects.find((effect) => effect.kind === "muffleThroughWalls");
  const commit = (next: typeof channel) => {
    void applyAssetDocumentChange(documentId, next as unknown as Record<string, unknown>);
  };

  return (
    <PanelFrame data-testid="audio-channel-details-panel">
      <div className="flex flex-col gap-3 p-2">
        <PropertyGrid
          rows={[
            {
              id: "parentChannelGuid",
              kind: "asset",
              label: "Parent Channel",
              value: channel.parentChannelGuid,
              displayLabel: identity.displayLabel,
              displayType: identity.displayType,
              visual: identity.visual,
              placeholder: "None",
              onPick: () => setPickParent(true),
              onChange: (parentChannelGuid) =>
                commit({ ...channel, parentChannelGuid }),
            },
            {
              id: "environmentReverb",
              kind: "boolean",
              label: "Environment Reverb",
              value: reverb?.enabled === true,
              onChange: (enabled) =>
                commit(setAudioChannelEffect(channel, "environmentReverb", enabled)),
            },
            {
              id: "muffleThroughWalls",
              kind: "boolean",
              label: "Muffle Through Walls",
              value: muffle?.enabled === true,
              onChange: (enabled) =>
                commit(setAudioChannelEffect(channel, "muffleThroughWalls", enabled)),
            },
          ]}
        />
      </div>
      <AssetPicker
        open={pickParent}
        onOpenChange={setPickParent}
        assets={pickerAssets(channels, ["AudioChannel"]).filter(
          (asset) => asset.path !== doc?.ref.path,
        )}
        allowedTypes={["AudioChannel"]}
        title="Pick Parent Channel"
        allowNone
        onPick={(parentChannelGuid) => {
          commit({ ...channel, parentChannelGuid });
          setPickParent(false);
        }}
        data-testid="audio-channel-parent-picker"
      />
    </PanelFrame>
  );
}

type RegistryEntry = { header: { guid: string; name: string; type: string; payload?: Record<string, unknown> }; path: string };

/**
 * The Float Curve a Custom falloff names, as the plot draws it: the curve's open tab (unsaved edits included), else
 * its saved header snapshot; null when the project has no such Float Curve.
 */
function useFalloffCurve(guid: string | null, entries: readonly RegistryEntry[]): Curve<number> | null {
  const drafts = useOpenDocumentsOfKinds(FLOAT_CURVE_DOCUMENT_KINDS);
  const entry = guid ? entries.find((asset) => asset.header.guid === guid && asset.header.type === "FloatCurve") : undefined;
  if (!entry) return null;
  const draft = drafts.find((doc) => doc.ref.path === entry.path);
  return normalizeCurveAssetPayload("float", draft?.content ?? entry.header.payload).curve;
}

export function SoundAttenuationDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const doc = useOpenDocument(documentId);
  const [pickCurve, setPickCurve] = useState(false);
  const entries = (assetRegistry?.list() ?? []) as readonly RegistryEntry[];
  const attenuation = normalizeSoundAttenuationPayload(asRecord(doc?.content));
  const customCurve = useFalloffCurve(attenuation.falloff === "custom" ? attenuation.falloffCurveGuid : null, entries);
  const { curve } = resolveSoundAttenuationCurve({ falloff: attenuation.falloff, customCurve });
  const commit = (next: SoundAttenuationPayload, field?: string) => {
    void applyAssetDocumentChange(
      documentId,
      normalizeSoundAttenuationPayload(next) as unknown as Record<string, unknown>,
      field ? `sound-attenuation:${field}` : undefined,
    );
  };
  const rows = soundAttenuationDetailRows(attenuation, commit, () => setPickCurve(true),
    (guid) => entries.find((asset) => asset.header.guid === guid && asset.header.type === "FloatCurve")?.header.name);

  return (
    <PanelFrame data-testid="sound-attenuation-details-panel">
      <div className="flex flex-col gap-3 p-2">
        <AttenuationFalloffPlot attenuation={{ ...attenuation, curve }} />
        <PropertyGrid rows={rows} />
      </div>
      <AssetPicker
        open={pickCurve}
        onOpenChange={setPickCurve}
        assets={pickerAssets(entries, ["FloatCurve"])}
        allowedTypes={["FloatCurve"]}
        title="Pick Float Curve"
        allowNone
        onPick={(falloffCurveGuid) => {
          commit({ ...attenuation, falloffCurveGuid });
          setPickCurve(false);
        }}
        data-testid="sound-attenuation-curve-picker"
      />
    </PanelFrame>
  );
}
