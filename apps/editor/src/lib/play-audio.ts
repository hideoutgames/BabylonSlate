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
