import {
  normalizeAudioChannelPayload,
  normalizeAudioMixerPayload,
  normalizeAudioPayload,
  normalizeSoundAttenuationPayload,
  soundAttenuationLibraryEntry,
  type AudioChannelPayload,
  type AudioMixerPayload,
  type AudioPayload,
  type SoundAttenuationLibraryEntry,
} from "@haptic/assets";
import { CURVE_ASSET_TYPES } from "@haptic/core";

export type PlayAudioLibrary = {
  mixerGuid: string | null;
  mixers: Map<string, AudioMixerPayload>;
  channels: Map<string, AudioChannelPayload>;
  audio: Map<string, AudioPayload>;
  attenuations: Map<string, SoundAttenuationLibraryEntry>;
};

export type PlayAudioSourceLoader = (request: {
  assetGuid: string;
  chunkId: string;
}) => Promise<Uint8Array | null | undefined>;

export function emptyPlayAudioLibrary(
  mixerGuid: string | null = null,
): PlayAudioLibrary {
  return {
    mixerGuid,
    mixers: new Map(),
    channels: new Map(),
    audio: new Map(),
    attenuations: new Map(),
  };
}

/** The Float Curves the Custom falloffs of these attenuation payloads name. */
export function attenuationCurveGuids(payloads: Iterable<unknown>): Set<string> {
  const guids = new Set<string>();
  for (const payload of payloads) {
    const attenuation = normalizeSoundAttenuationPayload(payload);
    if (attenuation.falloff === "custom" && attenuation.falloffCurveGuid) guids.add(attenuation.falloffCurveGuid);
  }
  return guids;
}

/**
 * Build a Play audio library from registry/open-document payloads. Float Curve assets among them resolve the Custom
 * falloff of the attenuations that name them.
 */
export function playAudioLibraryFromAssets(options: {
  mixerGuid: string | null;
  assets: ReadonlyArray<{ guid: string; type: string; payload: unknown }>;
}): PlayAudioLibrary {
  const library = emptyPlayAudioLibrary(options.mixerGuid);
  const floatCurves = new Map(options.assets
    .filter((asset) => asset.type === CURVE_ASSET_TYPES.float)
    .map((asset) => [asset.guid, asset.payload] as const));
  for (const asset of options.assets) {
    if (asset.type === "Audio") {
      library.audio.set(asset.guid, normalizeAudioPayload(asset.payload));
    } else if (asset.type === "AudioMixer") {
      library.mixers.set(asset.guid, normalizeAudioMixerPayload(asset.payload));
    } else if (asset.type === "AudioChannel") {
      library.channels.set(
        asset.guid,
        normalizeAudioChannelPayload(asset.payload),
      );
    } else if (asset.type === "SoundAttenuation") {
      library.attenuations.set(
        asset.guid,
        soundAttenuationLibraryEntry(asset.payload, (guid) => floatCurves.get(guid)),
      );
    }
  }
  return library;
}

/** Read Audio clip bytes on first playSound — unused assets stay on disk. */
export function createPlayAudioSourceLoader(options: {
  assets: ReadonlyArray<{
    guid: string;
    path: string;
    type: string;
    payload: unknown;
  }>;
  readChunk: (
    path: string,
    chunkId: string,
  ) => Promise<Uint8Array | null | undefined>;
}): PlayAudioSourceLoader {
  const byGuid = new Map(
    options.assets
      .filter((asset) => asset.type === "Audio")
      .map((asset) => [asset.guid, asset] as const),
  );
  return async ({ assetGuid, chunkId }) => {
    const asset = byGuid.get(assetGuid);
    if (!asset) return null;
    return options.readChunk(asset.path, chunkId);
  };
}
