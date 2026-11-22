import { describe, expect, it } from "vitest";
import {
  attenuationCurveGuids,
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
  });

  it("resolves a Custom falloff from the Float Curve among the assets, and only that one", () => {
    const curve = { Keys: [{ Time: 0, Value: 0.5, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 }], Before: "constant", After: "constant" };
    const library = playAudioLibraryFromAssets({
      mixerGuid: null,
      assets: [
        { guid: "fade", type: "FloatCurve", payload: { curve } },
        { guid: "push", type: "VectorCurve", payload: { curve } },
        { guid: "near", type: "SoundAttenuation", payload: { falloff: "custom", falloffCurveGuid: "fade" } },
        { guid: "wrong-kind", type: "SoundAttenuation", payload: { falloff: "custom", falloffCurveGuid: "push" } },
        { guid: "built-in", type: "SoundAttenuation", payload: { falloff: "inverse", falloffCurveGuid: "fade" } },
      ],
    });
    expect(library.attenuations.get("near")?.customCurve).toEqual(curve);
    expect(library.attenuations.get("wrong-kind")?.customCurve).toBeNull();
    expect(library.attenuations.get("built-in")?.customCurve).toBeNull();
  });

  it("lists the Float Curves Custom falloffs name", () => {
    expect([...attenuationCurveGuids([
      { falloff: "custom", falloffCurveGuid: "fade" },
      { falloff: "natural", falloffCurveGuid: "kept" },
      { falloff: "custom", falloffCurveGuid: null },
    ])]).toEqual(["fade"]);
  });
});

describe("createPlayAudioSourceLoader", () => {
  it("does not read unused Audio source chunks until that guid plays", async () => {
    const reads: string[] = [];
    const chunks = new Map<string, Uint8Array>([
      ["assets/jump.audio.hasset:source", new Uint8Array([1, 2])],
      ["assets/bed.audio.hasset:source", new Uint8Array([9])],
    ]);
    const loader = createPlayAudioSourceLoader({
      assets: [
        {
          guid: "jump",
          path: "assets/jump.audio.hasset",
          type: "Audio",
          payload: { clips: [{ chunkId: "source", weight: 1 }] },
        },
        {
          guid: "bed",
          path: "assets/bed.audio.hasset",
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
    expect(reads).toEqual(["assets/jump.audio.hasset:source"]);
    await expect(
      loader({ assetGuid: "bed", chunkId: "source" }),
    ).resolves.toEqual(new Uint8Array([9]));
    expect(reads).toEqual([
      "assets/jump.audio.hasset:source",
      "assets/bed.audio.hasset:source",
    ]);
  });

  it("returns null for an unknown Audio guid without touching VFS", async () => {
    const reads: string[] = [];
    const loader = createPlayAudioSourceLoader({
      assets: [
        {
          guid: "jump",
          path: "assets/jump.audio.hasset",
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
