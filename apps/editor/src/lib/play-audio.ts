import {
  normalizeAudioChannelPayload,
  normalizeAudioMixerPayload,
  normalizeAudioPayload,
  normalizeSoundAttenuationPayload,
  type AudioChannelPayload,
  type AudioMixerPayload,
  type AudioPayload,
  type SoundAttenuationPayload,
} from "@babylonslate/assets";

export type PlayAudioLibrary = {
  mixerGuid: string | null;
  mixers: Map<string, AudioMixerPayload>;
  channels: Map<string, AudioChannelPayload>;
  audio: Map<string, AudioPayload>;
  attenuations: Map<string, SoundAttenuationPayload>;
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

/** Build a Play audio library from registry/open-document payloads. */
export function playAudioLibraryFromAssets(options: {
  mixerGuid: string | null;
  assets: ReadonlyArray<{ guid: string; type: string; payload: unknown }>;
}): PlayAudioLibrary {
  const library = emptyPlayAudioLibrary(options.mixerGuid);
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
        normalizeSoundAttenuationPayload(asset.payload),
      );
    }
  }
  return library;
}

/** Audio guids the worker uses for BT PlaySound fail-on-missing. */
export function audioAssetGuidsFromLibrary(
  library: PlayAudioLibrary,
): string[] {
  return [...library.audio.keys()];
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
