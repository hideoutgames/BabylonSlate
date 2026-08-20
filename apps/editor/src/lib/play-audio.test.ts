import { describe, expect, it } from "vitest";
import {
  audioAssetGuidsFromLibrary,
  createPlayAudioSourceLoader,
  playAudioLibraryFromAssets,
} from "./play-audio";

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
    expect(audioAssetGuidsFromLibrary(library)).toEqual(["jump"]);
  });
});

describe("createPlayAudioSourceLoader", () => {
  it("does not read unused Audio source chunks until that guid plays", async () => {
    const reads: string[] = [];
    const chunks = new Map<string, Uint8Array>([
      ["assets/jump.audio.babasset:source", new Uint8Array([1, 2])],
      ["assets/bed.audio.babasset:source", new Uint8Array([9])],
    ]);
    const loader = createPlayAudioSourceLoader({
      assets: [
        {
          guid: "jump",
          path: "assets/jump.audio.babasset",
          type: "Audio",
          payload: { clips: [{ chunkId: "source", weight: 1 }] },
        },
        {
          guid: "bed",
          path: "assets/bed.audio.babasset",
          type: "Audio",
          payload: { clips: [{ chunkId: "source", weight: 1 }] },
        },
      ],
      readChunk: async (path, chunkId) => {
        reads.push(`${path}:${chunkId}`);
        return chunks.get(`${path}:${chunkId}`) ?? null;
      },
    });
    expect(reads).toEqual([]);
    await expect(
      loader({ assetGuid: "jump", chunkId: "source" }),
    ).resolves.toEqual(new Uint8Array([1, 2]));
    expect(reads).toEqual(["assets/jump.audio.babasset:source"]);
    await expect(
      loader({ assetGuid: "bed", chunkId: "source" }),
    ).resolves.toEqual(new Uint8Array([9]));
    expect(reads).toEqual([
      "assets/jump.audio.babasset:source",
      "assets/bed.audio.babasset:source",
    ]);
  });

  it("returns null for an unknown Audio guid without touching VFS", async () => {
    const reads: string[] = [];
    const loader = createPlayAudioSourceLoader({
      assets: [
        {
          guid: "jump",
          path: "assets/jump.audio.babasset",
          type: "Audio",
          payload: {},
        },
      ],
      readChunk: async (path, chunkId) => {
        reads.push(`${path}:${chunkId}`);
        return new Uint8Array([1]);
      },
    });
    await expect(
      loader({ assetGuid: "missing", chunkId: "source" }),
    ).resolves.toBeNull();
    expect(reads).toEqual([]);
  });
});
