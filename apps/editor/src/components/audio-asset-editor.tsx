import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  attenuationPlotPoints,
  clampAudioGain,
  normalizeAudioChannelPayload,
  normalizeAudioMixerPayload,
  normalizeSoundAttenuationPayload,
  validateAudioMixer,
  type AudioMixerChannelEntry,
  type SoundAttenuationPayload,
} from "@babylonslate/assets";
import { Button } from "@babylonslate/ui/components/button";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

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

export function AttenuationFalloffPlot({
  attenuation,
}: {
  attenuation: SoundAttenuationPayload;
}) {
  const points = attenuationPlotPoints(attenuation, 48);
  const maxDistance = Math.max(attenuation.maxRadius, 1);
  const path = points
    .map((point, index) => {
      const x = (point.distance / maxDistance) * 200;
      const y = 60 - point.gain * 56;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
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
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function AudioMixerDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange, assetRegistry } =
    useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const mixer = normalizeAudioMixerPayload(asRecord(doc?.content));
  const [pickIndex, setPickIndex] = useState<number | null>(null);
  const channels = assetRegistry?.list() ?? [];
  const commit = (next: typeof mixer) => {
    void applyAssetDocumentChange(documentId, next as unknown as Record<string, unknown>);
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
        commit({ ...mixer, globalVolume: clampAudioGain(globalVolume) }),
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
        onPick: () => setPickIndex(index),
        onChange: (channelGuid) => {
          if (!channelGuid) {
            commit({
              ...mixer,
              channels: mixer.channels.filter((_, i) => i !== index),
            });
            return;
          }
          const next = mixer.channels.map((row, i) =>
            i === index ? { ...row, channelGuid } : row,
          );
          commit({ ...mixer, channels: next });
        },
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
          commit({ ...mixer, channels: next });
        },
      },
    );
  });

  return (
    <PanelFrame data-testid="audio-mixer-details-panel">
      <div className="flex flex-col gap-3 p-2">
        <PropertyGrid rows={rows} />
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
          onClick={() =>
            commit({
              ...mixer,
              channels: [
                ...mixer.channels,
                { channelGuid: `new-channel-${mixer.channels.length}`, volume: 1 },
              ],
            })
          }
        >
          Add Channel
        </Button>
      </div>
      <AssetPicker
        open={pickIndex !== null}
        onOpenChange={(open) => {
          if (!open) setPickIndex(null);
        }}
        assets={pickerAssets(channels, ["AudioChannel"])}
        allowedTypes={["AudioChannel"]}
        title="Pick Audio Channel"
        allowNone
        onPick={(guid) => {
          if (pickIndex === null) return;
          const next: AudioMixerChannelEntry[] = mixer.channels.map((row, i) =>
            i === pickIndex
              ? { ...row, channelGuid: guid ?? row.channelGuid }
              : row,
          );
          if (!guid) {
            commit({
              ...mixer,
              channels: mixer.channels.filter((_, i) => i !== pickIndex),
            });
          } else {
            commit({ ...mixer, channels: next });
          }
          setPickIndex(null);
        }}
        data-testid="audio-mixer-channel-picker"
      />
    </PanelFrame>
  );
}

export function AudioChannelDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange, assetRegistry } =
    useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
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
                commit({
                  ...channel,
                  effects: [{ kind: "environmentReverb", enabled }],
                }),
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

export function SoundAttenuationDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const attenuation = normalizeSoundAttenuationPayload(asRecord(doc?.content));
  const commit = (next: SoundAttenuationPayload) => {
    void applyAssetDocumentChange(
      documentId,
      normalizeSoundAttenuationPayload(next) as unknown as Record<string, unknown>,
    );
  };

  return (
    <PanelFrame data-testid="sound-attenuation-details-panel">
      <div className="flex flex-col gap-3 p-2">
        <AttenuationFalloffPlot attenuation={attenuation} />
        <PropertyGrid
          rows={[
            {
              id: "innerRadius",
              kind: "number",
              label: "Inner Radius",
              value: attenuation.innerRadius,
              min: 0,
              onChange: (innerRadius) => commit({ ...attenuation, innerRadius }),
            },
            {
              id: "maxRadius",
              kind: "number",
              label: "Max Radius",
              value: attenuation.maxRadius,
              min: 0,
              onChange: (maxRadius) => commit({ ...attenuation, maxRadius }),
            },
            {
              id: "distanceModel",
              kind: "enum",
              label: "Distance Model",
              value: attenuation.distanceModel,
              options: [
                { value: "linear", label: "Linear" },
                { value: "inverse", label: "Inverse" },
                { value: "exponential", label: "Exponential" },
              ],
              onChange: (distanceModel) =>
                commit({
                  ...attenuation,
                  distanceModel: distanceModel as SoundAttenuationPayload["distanceModel"],
                }),
            },
            {
              id: "rolloff",
              kind: "number",
              label: "Rolloff",
              value: attenuation.rolloff,
              min: 0,
              onChange: (rolloff) => commit({ ...attenuation, rolloff }),
            },
            {
              id: "spatialisation",
              kind: "enum",
              label: "Spatialisation",
              value: attenuation.spatialisation,
              options: [
                { value: "equalPower", label: "Equal Power" },
                { value: "hrtf", label: "HRTF" },
              ],
              onChange: (spatialisation) =>
                commit({
                  ...attenuation,
                  spatialisation:
                    spatialisation as SoundAttenuationPayload["spatialisation"],
                }),
            },
          ]}
        />
      </div>
    </PanelFrame>
  );
}

