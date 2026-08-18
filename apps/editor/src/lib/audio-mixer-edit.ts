import type { AudioMixerPayload } from "@babylonslate/assets";

export const AUDIO_MIXER_EMPTY_CHANNELS_COPY =
  "Global Volume still applies. Add a channel to control per-channel volume.";

export type MixerChannelPickTarget = "new" | number;

export function applyMixerChannelPick(
  mixer: AudioMixerPayload,
  target: MixerChannelPickTarget,
  guid: string | null,
): AudioMixerPayload {
  if (target === "new") {
    if (!guid) return mixer;
    return {
      ...mixer,
      channels: [...mixer.channels, { channelGuid: guid, volume: 1 }],
    };
  }
  if (!guid) {
    return {
      ...mixer,
      channels: mixer.channels.filter((_, index) => index !== target),
    };
  }
  return {
    ...mixer,
    channels: mixer.channels.map((row, index) =>
      index === target ? { ...row, channelGuid: guid } : row,
    ),
  };
}
