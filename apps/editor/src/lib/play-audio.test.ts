import { describe, expect, it } from "vitest";
import { playAudioLibraryFromAssets } from "./play-audio";

describe("playAudioLibraryFromAssets", () => {
  it("normalizes mixer, channel, audio, and attenuation payloads", () => {
    const library = playAudioLibraryFromAssets({
      mixerGuid: "mixer-1",
      assets: [
        { guid: "mixer-1", type: "AudioMixer", payload: { globalVolume: 0.5 } },
        {
          guid: "sfx",
          type: "AudioChannel",
          payload: { parentChannelGuid: null, effects: [] },
        },
        { guid: "jump", type: "Audio", payload: { volume: 0.5 } },
        { guid: "near", type: "SoundAttenuation", payload: { innerRadius: 2 } },
      ],
    });
    expect(library.mixerGuid).toBe("mixer-1");
    expect(library.mixers.get("mixer-1")?.globalVolume).toBe(0.5);
    expect(library.channels.get("sfx")?.parentChannelGuid).toBeNull();
    expect(library.audio.get("jump")?.volume).toBe(0.5);
    expect(library.attenuations.get("near")?.innerRadius).toBe(2);
  });
});
