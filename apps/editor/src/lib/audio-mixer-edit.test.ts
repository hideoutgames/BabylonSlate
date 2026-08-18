import { describe, expect, it } from "vitest";
import { createDefaultAudioMixerPayload } from "@babylonslate/assets";
import {
  AUDIO_MIXER_EMPTY_CHANNELS_COPY,
  applyMixerChannelPick,
} from "./audio-mixer-edit";

describe("applyMixerChannelPick", () => {
  it("does not commit a dummy channel row when Add Channel is cancelled", () => {
    const mixer = createDefaultAudioMixerPayload();
    expect(applyMixerChannelPick(mixer, "new", null)).toEqual(mixer);
    expect(AUDIO_MIXER_EMPTY_CHANNELS_COPY).toMatch(/Global Volume still applies/i);
  });

  it("appends a channel row only after an AudioChannel guid is picked", () => {
    const mixer = createDefaultAudioMixerPayload();
    expect(applyMixerChannelPick(mixer, "new", "sfx")).toEqual({
      globalVolume: 1,
      channels: [{ channelGuid: "sfx", volume: 1 }],
    });
  });

  it("replaces or removes an existing mixer table row", () => {
    const mixer = {
      globalVolume: 1,
      channels: [{ channelGuid: "sfx", volume: 0.5 }],
    };
    expect(applyMixerChannelPick(mixer, 0, "music")).toEqual({
      globalVolume: 1,
      channels: [{ channelGuid: "music", volume: 0.5 }],
    });
    expect(applyMixerChannelPick(mixer, 0, null)).toEqual({
      globalVolume: 1,
      channels: [],
    });
  });
});
