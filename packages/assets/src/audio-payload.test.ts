import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readGoldenBinary, writeGoldenBinary } from "@haptic/test-kit";
import {
  AUDIO_AUTO_STREAM_MIN_BYTES,
  AUDIO_SPEED_OF_SOUND,
  audioAssetDependencies,
  fillEmptySourceClipName,
  computeAttenuationGain,
  computeDopplerPlaybackRate,
  audioChannelHasParentCycle,
  clampAudioGain,
  computeAudioOutputGain,
  resolveAudioPlayback,
  encodePackedAudioAsset,
  decodePackedAudioAsset,
  peekPackedAudioPayload,
  extractPackedAudioClipBytes,
  pickWeightedAudioClip,
  resolveAudioPitch,
  collectPackedAudioClipBlobs,
  allocateAudioClipChunkId,
  createDefaultAudioChannelPayload,
  createDefaultAudioMixerPayload,
  createDefaultAudioPayload,
  createDefaultSoundAttenuationPayload,
  normalizeAudioChannelPayload,
  normalizeAudioMixerPayload,
  normalizeAudioPayload,
  normalizeSoundAttenuationPayload,
  setAudioChannelEffect,
  resolveAudioReferences,
  sanitizeAudioLibrary,
  validateAudioChannelGraph,
  validateAudioMixer,
  BUILT_IN_FALLOFF_CURVES,
  attenuationPlotPoints,
  resolveSoundAttenuationCurve,
  sampleFalloffCurve,
  soundAttenuationLibraryEntry,
  type BuiltInSoundAttenuationFalloff,
} from "./audio-payload";
import type { Curve } from "@haptic/core";
import { collectAssetDependencyMetadata } from "./asset-dependencies";
import { decodeAssetDocument, encodeAssetDocument } from "./asset-document";
import { decodeHasset, encodeHasset } from "./hasset";
import { bytesEqual } from "./test-support/bytes";
import { importAudio } from "./importers/audio";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";

describe("audio payloads", () => {
  it("normalizes empty imported Audio without inventing channel or attenuation", () => {
    expect(normalizeAudioPayload({})).toEqual({
      volume: 1,
      audioChannelGuid: null,
      soundAttenuationGuid: null,
      clips: [{ chunkId: "source", name: "", weight: 1 }],
      pitch: 1,
      pitchRandom: false,
      pitchMin: 1,
      pitchMax: 1,
      loop: false,
      playbackMode: "decoded",
    });
    expect(normalizeAudioPayload(undefined)).toEqual(createDefaultAudioPayload());
  });

  it("defaults loop to false and preserves a true flag", () => {
    expect(createDefaultAudioPayload().loop).toBe(false);
    expect(normalizeAudioPayload({}).loop).toBe(false);
    expect(normalizeAudioPayload({ loop: true }).loop).toBe(true);
    expect(normalizeAudioPayload({ loop: "yes" }).loop).toBe(false);
  });

  it("normalizes playbackMode and defaults large imports to streamed", async () => {
    expect(normalizeAudioPayload({}).playbackMode).toBe("decoded");
    expect(normalizeAudioPayload({ playbackMode: "streamed" }).playbackMode).toBe("streamed");
    expect(normalizeAudioPayload({ playbackMode: "invalid" }).playbackMode).toBe("decoded");
    expect(
      resolveAudioPlayback({
        audio: { playbackMode: "streamed" },
        playCallVolume: 1,
        mixer: null,
        channels: new Map(),
      }).playbackMode,
    ).toBe("streamed");

    const shortClip = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
    const [shortImport] = await importAudio(shortClip, { fileName: "jump.mp3", existingGuids: new Set() });
    expect(normalizeAudioPayload(shortImport!.payload).playbackMode).toBe("decoded");

    const longMusic = new Uint8Array(AUDIO_AUTO_STREAM_MIN_BYTES);
    longMusic.set([0x49, 0x44, 0x33, 0x04]);
    const [longImport] = await importAudio(longMusic, { fileName: "theme.mp3", existingGuids: new Set() });
    expect(normalizeAudioPayload(longImport!.payload).playbackMode).toBe("streamed");
  });

  it("caps clips at eight, defaults equal weights, and swaps inverted pitch range", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      chunkId: i === 0 ? "source" : `source:${i + 1}`,
      name: `clip-${i}`,
      weight: 0,
    }));
    const normalized = normalizeAudioPayload({
      clips: many,
      pitch: 8,
      pitchRandom: true,
      pitchMin: 2,
      pitchMax: 0.5,
    });
    expect(normalized.clips).toHaveLength(8);
    expect(normalized.clips.every((clip) => clip.weight === 1)).toBe(true);
    expect(normalized.pitch).toBe(4);
    expect(normalized.pitchMin).toBe(0.5);
    expect(normalized.pitchMax).toBe(2);
  });

  it("picks a weighted clip and a random pitch in range", () => {
    const clips = [
      { chunkId: "source", name: "a", weight: 1 },
      { chunkId: "source:2", name: "b", weight: 3 },
    ];
    expect(pickWeightedAudioClip(clips, () => 0).chunkId).toBe("source");
    expect(pickWeightedAudioClip(clips, () => 0.24).chunkId).toBe("source");
    expect(pickWeightedAudioClip(clips, () => 0.25).chunkId).toBe("source:2");
    expect(pickWeightedAudioClip(clips, () => 0.99).chunkId).toBe("source:2");
    // All-zero weights are equal weights, not always the first clip.
    const silent = clips.map((clip) => ({ ...clip, weight: 0 }));
    expect(pickWeightedAudioClip(silent, () => 0.49).chunkId).toBe("source");
    expect(pickWeightedAudioClip(silent, () => 0.5).chunkId).toBe("source:2");
    expect(
      resolveAudioPitch(
        {
          ...createDefaultAudioPayload(),
          pitch: 1,
          pitchRandom: false,
        },
        () => 0.5,
      ),
    ).toBe(1);
    expect(
      resolveAudioPitch(
        {
          ...createDefaultAudioPayload(),
          pitchRandom: true,
          pitchMin: 0.5,
          pitchMax: 1.5,
        },
        () => 0.5,
      ),
    ).toBeCloseTo(1, 5);
  });

  it("allocates source:N clip chunk ids and packs clip blobs in payload order", async () => {
    expect(allocateAudioClipChunkId([])).toBe("source");
    expect(allocateAudioClipChunkId(["source"])).toBe("source:2");
    expect(
      allocateAudioClipChunkId([
        "source",
        "source:2",
        "source:3",
        "source:4",
        "source:5",
        "source:6",
        "source:7",
        "source:8",
      ]),
    ).toBeNull();
    const blobs = await collectPackedAudioClipBlobs({
      payload: {
        clips: [
          { chunkId: "source", weight: 1 },
          { chunkId: "source:2", weight: 1 },
        ],
      },
      readChunk: async (chunkId) =>
        chunkId === "source"
          ? new Uint8Array([1, 2, 3])
          : chunkId === "source:2"
            ? new Uint8Array([9, 8])
            : null,
    });
    expect(blobs).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([9, 8])]);
  });

  it("clamps Audio volume to 0..1 and keeps nullable guids", () => {
    expect(
      normalizeAudioPayload({
        volume: 1.5,
        audioChannelGuid: "ch-1",
        soundAttenuationGuid: "att-1",
      }),
    ).toEqual({
      volume: 1,
      audioChannelGuid: "ch-1",
      soundAttenuationGuid: "att-1",
      clips: [{ chunkId: "source", name: "", weight: 1 }],
      pitch: 1,
      pitchRandom: false,
      pitchMin: 1,
      pitchMax: 1,
      loop: false,
      playbackMode: "decoded",
    });
    expect(normalizeAudioPayload({ volume: -2 }).volume).toBe(0);
    expect(normalizeAudioPayload({ audioChannelGuid: "" }).audioChannelGuid).toBe(
      null,
    );
  });

  it("creates default mixer, channel, and attenuation payloads", () => {
    expect(createDefaultAudioMixerPayload()).toEqual({
      globalVolume: 1,
      channels: [],
    });
    expect(createDefaultAudioChannelPayload()).toEqual({
      parentChannelGuid: null,
      effects: [
        { kind: "environmentReverb", enabled: false },
        { kind: "muffleThroughWalls", enabled: false },
      ],
    });
    expect(createDefaultSoundAttenuationPayload()).toEqual({
      innerRadius: 10,
      maxRadius: 250,
      falloff: "natural",
      falloffCurveGuid: null,
      spatialisation: "equalPower",
      cone: null,
      doppler: null,
    });
  });

  it("rejects duplicate mixer channel entries and clamps mixer volumes", () => {
    const mixer = normalizeAudioMixerPayload({
      globalVolume: 2,
      channels: [
        { channelGuid: "ch-a", volume: -1 },
        { channelGuid: "ch-a", volume: 0.5 },
        { channelGuid: "ch-b", volume: 0.25 },
      ],
    });
    expect(mixer.globalVolume).toBe(1);
    expect(validateAudioMixer(mixer).ok).toBe(false);
    expect(validateAudioMixer(mixer).diagnostics.map((row) => row.code)).toContain(
      "audio.mixer.duplicate_channel",
    );
    expect(
      validateAudioMixer({
        globalVolume: 1,
        channels: [
          { channelGuid: "ch-a", volume: 0.5 },
          { channelGuid: "ch-b", volume: 0.25 },
        ],
      }).ok,
    ).toBe(true);
  });

  it("detects AudioChannel parent cycles and routes a missing parent to master", () => {
    expect(
      audioChannelHasParentCycle(
        new Map([
          ["a", "b"],
          ["b", "a"],
        ]),
        "a",
      ),
    ).toBe(true);
    expect(
      audioChannelHasParentCycle(new Map([["a", "b"], ["b", null]]), "a"),
    ).toBe(false);
    const graph = validateAudioChannelGraph({
      a: { parentChannelGuid: "missing" },
      b: { parentChannelGuid: "a" },
    });
    expect(graph.resolvedParents.a).toBeNull();
    expect(graph.diagnostics.map((row) => row.code)).toEqual(
      expect.arrayContaining(["audio.channel.missing_parent"]),
    );
    const cycle = validateAudioChannelGraph({
      a: { parentChannelGuid: "b" },
      b: { parentChannelGuid: "a" },
    });
    expect(cycle.ok).toBe(false);
    expect(cycle.diagnostics.map((row) => row.code)).toContain(
      "audio.channel.parent_cycle",
    );
    expect(cycle.resolvedParents.a).toBeNull();
    expect(cycle.resolvedParents.b).toBeNull();

    // A channel that only leads into the cycle keeps its parent.
    const lead = validateAudioChannelGraph({
      a: { parentChannelGuid: "b" },
      b: { parentChannelGuid: "a" },
      sfx: { parentChannelGuid: "a" },
    });
    expect(lead.ok).toBe(false);
    expect(lead.resolvedParents).toEqual({ a: null, b: null, sfx: "a" });
    expect(audioChannelHasParentCycle(new Map([["a", "b"], ["b", "a"], ["sfx", "a"]]), "sfx")).toBe(false);
  });

  it("sanitizes missing Audio refs and cyclic channel parents for Play", () => {
    const result = sanitizeAudioLibrary({
      audio: new Map([
        [
          "jump",
          {
            volume: 1,
            audioChannelGuid: "gone",
            soundAttenuationGuid: "near",
          },
        ],
      ]),
      channels: new Map([
        [
          "a",
          {
            parentChannelGuid: "b",
            effects: [{ kind: "environmentReverb", enabled: false }],
          },
        ],
        [
          "b",
          {
            parentChannelGuid: "a",
            effects: [{ kind: "environmentReverb", enabled: false }],
          },
        ],
      ]),
      attenuations: new Map(),
    });
    expect(result.audio.get("jump")?.audioChannelGuid).toBeNull();
    expect(result.audio.get("jump")?.soundAttenuationGuid).toBeNull();
    expect(result.channels.get("a")?.parentChannelGuid).toBeNull();
    expect(result.channels.get("b")?.parentChannelGuid).toBeNull();
    expect(result.diagnostics.map((row) => row.code).sort()).toEqual([
      "audio.channel.parent_cycle",
      "audio.missing_attenuation",
      "audio.missing_channel",
    ]);
  });

  it("falls missing Audio references back to null with one diagnostic each", () => {
    const resolved = resolveAudioReferences(
      {
        volume: 1,
        audioChannelGuid: "gone-channel",
        soundAttenuationGuid: "gone-atten",
      },
      new Set(["kept"]),
    );
    expect(resolved.payload.audioChannelGuid).toBeNull();
    expect(resolved.payload.soundAttenuationGuid).toBeNull();
    expect(resolved.diagnostics).toHaveLength(2);
    expect(resolved.diagnostics.map((row) => row.code).sort()).toEqual([
      "audio.missing_attenuation",
      "audio.missing_channel",
    ]);
  });

  it("indexes Audio, mixer, and channel guid dependencies", () => {
    expect(
      audioAssetDependencies("Audio", {
        volume: 1,
        audioChannelGuid: "ch-1",
        soundAttenuationGuid: "att-1",
      }),
    ).toEqual(["att-1", "ch-1"]);
    expect(
      audioAssetDependencies("AudioMixer", {
        globalVolume: 1,
        channels: [
          { channelGuid: "ch-b", volume: 0.2 },
          { channelGuid: "ch-a", volume: 1 },
        ],
      }),
    ).toEqual(["ch-a", "ch-b"]);
    expect(
      audioAssetDependencies("AudioChannel", {
        parentChannelGuid: "master-sfx",
        effects: [],
      }),
    ).toEqual(["master-sfx"]);
    expect(audioAssetDependencies("SoundAttenuation", {})).toEqual([]);
    // Only a Custom falloff plays its curve; a curve kept behind a built-in is not loaded or shipped.
    expect(audioAssetDependencies("SoundAttenuation", { falloff: "custom", falloffCurveGuid: "curve-1" })).toEqual(["curve-1"]);
    expect(audioAssetDependencies("SoundAttenuation", { falloff: "natural", falloffCurveGuid: "curve-1" })).toEqual([]);
    expect(audioAssetDependencies("SoundAttenuation", { falloff: "custom", falloffCurveGuid: null })).toEqual([]);
    expect(audioAssetDependencies("Class", { audioChannelGuid: "ch-1" })).toEqual(
      [],
    );
  });

  it("resolves session playback gain without inventing mixer or channel factors", () => {
    const channels = new Map([
      [
        "sfx",
        {
          parentChannelGuid: "master",
          effects: [{ kind: "environmentReverb" as const, enabled: true }],
        },
      ],
      [
        "master",
        {
          parentChannelGuid: null,
          effects: [{ kind: "environmentReverb" as const, enabled: false }],
        },
      ],
    ]);
    const mixer = {
      globalVolume: 0.5,
      channels: [
        { channelGuid: "sfx", volume: 0.5 },
        { channelGuid: "master", volume: 0.5 },
      ],
    };
    expect(
      resolveAudioPlayback({
        audio: { volume: 0.5, audioChannelGuid: null, soundAttenuationGuid: null },
        playCallVolume: 0.5,
        mixer: null,
        channels,
      }).gain,
    ).toBe(0.25);
    expect(
      resolveAudioPlayback({
        audio: {
          volume: 1,
          audioChannelGuid: "sfx",
          soundAttenuationGuid: null,
        },
        playCallVolume: 1,
        mixer,
        channels,
      }),
    ).toMatchObject({
      gain: 0.125,
      environmentReverb: true,
      channelGuids: ["sfx", "master"],
    });
    expect(
      resolveAudioPlayback({
        audio: {
          volume: 1,
          audioChannelGuid: null,
          soundAttenuationGuid: null,
        },
        playCallVolume: 1,
        mixer,
        channels,
      }).gain,
    ).toBe(0.5);
    expect(
      resolveAudioPlayback({
        audio: {
          volume: 1,
          audioChannelGuid: "sfx",
          soundAttenuationGuid: null,
        },
        playCallVolume: 1,
        mixer: null,
        channels,
      }),
    ).toMatchObject({ gain: 1, environmentReverb: true });
  });

  it("keeps both channel effects and walks muffle through parents", () => {
    const payload = createDefaultAudioChannelPayload();
    expect(
      setAudioChannelEffect(payload, "muffleThroughWalls", true).effects,
    ).toEqual([
      { kind: "environmentReverb", enabled: false },
      { kind: "muffleThroughWalls", enabled: true },
    ]);
    expect(
      setAudioChannelEffect(
        { parentChannelGuid: null, effects: [{ kind: "environmentReverb", enabled: true }] },
        "muffleThroughWalls",
        true,
      ).effects,
    ).toEqual([
      { kind: "environmentReverb", enabled: true },
      { kind: "muffleThroughWalls", enabled: true },
    ]);
    expect(
      normalizeAudioChannelPayload({
        effects: [{ kind: "environmentReverb", enabled: true }],
      }).effects,
    ).toEqual([
      { kind: "environmentReverb", enabled: true },
      { kind: "muffleThroughWalls", enabled: false },
    ]);
    const channels = new Map([
      [
        "sfx",
        {
          parentChannelGuid: "master",
          effects: [{ kind: "environmentReverb" as const, enabled: false }],
        },
      ],
      [
        "master",
        {
          parentChannelGuid: null,
          effects: [
            { kind: "environmentReverb" as const, enabled: false },
            { kind: "muffleThroughWalls" as const, enabled: true },
          ],
        },
      ],
    ]);
    expect(
      resolveAudioPlayback({
        audio: {
          volume: 1,
          audioChannelGuid: "sfx",
          soundAttenuationGuid: null,
        },
        playCallVolume: 1,
        mixer: null,
        channels,
      }),
    ).toMatchObject({ environmentReverb: false, muffleThroughWalls: true });
    expect(
      resolveAudioPlayback({
        audio: {
          volume: 1,
          audioChannelGuid: null,
          soundAttenuationGuid: null,
        },
        playCallVolume: 1,
        mixer: null,
        channels,
      }).muffleThroughWalls,
    ).toBe(false);
  });

  it("computes mixer gain as asset × play × channel chain × global", () => {
    expect(clampAudioGain(1.4)).toBe(1);
    expect(clampAudioGain(-0.2)).toBe(0);
    expect(
      computeAudioOutputGain({
        assetVolume: 0.5,
        playCallVolume: 0.5,
      }),
    ).toBe(0.25);
    expect(
      computeAudioOutputGain({
        assetVolume: 1,
        playCallVolume: 1,
        channelGains: [0.5, 0.5],
        globalGain: 0.5,
      }),
    ).toBe(0.125);
    expect(
      computeAudioOutputGain({
        assetVolume: 0.8,
        playCallVolume: 1,
        channelGains: [],
        globalGain: 0.5,
      }),
    ).toBe(0.4);
    expect(
      computeAudioOutputGain({
        assetVolume: 1,
        playCallVolume: 1,
        channelGains: [0.5],
      }),
    ).toBe(0.5);
  });

  it("keeps attenuation full inside the inner radius and silent beyond max", () => {
    const atten = { ...createDefaultSoundAttenuationPayload(), curve: BUILT_IN_FALLOFF_CURVES.linear };
    expect(computeAttenuationGain(0, atten)).toBe(1);
    expect(computeAttenuationGain(10, atten)).toBe(1);
    expect(computeAttenuationGain(250, atten)).toBe(0);
    expect(computeAttenuationGain(130, atten)).toBeCloseTo(0.5);
    expect(computeAttenuationGain(1000, atten)).toBe(0);
  });

  it("silences a distance that is not a finite number", () => {
    const atten = { ...createDefaultSoundAttenuationPayload(), curve: BUILT_IN_FALLOFF_CURVES.natural };
    expect(computeAttenuationGain(Number.NaN, atten)).toBe(0);
    expect(computeAttenuationGain(Number.POSITIVE_INFINITY, atten)).toBe(0);
  });

  it("cuts a curve that ends above 0 at Max Radius and steps at Inner Radius when it starts below 1", () => {
    const flat: Curve<number> = { Keys: [{ Time: 0, Value: 0.5, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 }], Before: "constant", After: "constant" };
    const atten = { innerRadius: 10, maxRadius: 20, curve: flat };
    expect(computeAttenuationGain(10, atten)).toBe(1);
    expect(computeAttenuationGain(10.001, atten)).toBe(0.5);
    expect(computeAttenuationGain(20, atten)).toBe(0.5);
    expect(computeAttenuationGain(20.001, atten)).toBe(0);
  });

  it("treats Max Radius equal to Inner Radius as a hard edge without dividing by zero", () => {
    const curve = BUILT_IN_FALLOFF_CURVES.natural;
    expect(computeAttenuationGain(5, { innerRadius: 5, maxRadius: 5, curve })).toBe(1);
    expect(computeAttenuationGain(5.0001, { innerRadius: 5, maxRadius: 5, curve })).toBe(0);
    expect(computeAttenuationGain(0, { innerRadius: 0, maxRadius: 0, curve })).toBe(1);
    expect(computeAttenuationGain(0.1, { innerRadius: 0, maxRadius: 0, curve })).toBe(0);
  });

  it("samples a custom curve at X 0..1 between the radii, clamped in X and Y", () => {
    // Rises from 0 to 2 over X 0..2: past X 1 must not be read, and values over 1 play at 1.
    const rising: Curve<number> = {
      Keys: [
        { Time: 0, Value: 0, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 },
        { Time: 2, Value: 2, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 },
      ],
      Before: "linear",
      After: "linear",
    };
    expect(sampleFalloffCurve(rising, 0.25)).toBeCloseTo(0.25);
    expect(sampleFalloffCurve(rising, -3)).toBe(0);
    expect(sampleFalloffCurve(rising, 1)).toBe(1);
    expect(sampleFalloffCurve(rising, 5)).toBe(1);
    expect(sampleFalloffCurve(rising, Number.NaN)).toBe(0);
    const negative: Curve<number> = { Keys: [{ Time: 0, Value: -4, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 }], Before: "constant", After: "constant" };
    expect(sampleFalloffCurve(negative, 0.5)).toBe(0);
    // Between the radii: 10 + 0.25 × 40 = 20 reads X 0.25.
    expect(computeAttenuationGain(20, { innerRadius: 10, maxRadius: 50, curve: rising })).toBeCloseTo(0.25);
  });

  it("plays a non-finite curve value as silence, never full volume", () => {
    const broken = { Keys: [{ Time: 0, Value: Number.NaN }, { Time: 1, Value: Number.POSITIVE_INFINITY }], Before: "constant", After: "constant" } as unknown as Curve<number>;
    expect(sampleFalloffCurve(broken, 0.5)).toBe(0);
  });

  it("authors the built-in falloffs from full volume at Inner Radius to silence at Max Radius", () => {
    const expected: Record<BuiltInSoundAttenuationFalloff, number> = {
      natural: 0.3125, // (1 − 0.5)³ (1 + 1.5)
      linear: 0.5,
      inverse: 1 / 3, // (1 − 0.5) / (1 + 0.5)
      exponential: (Math.exp(-0.5) - Math.exp(-1)) / (1 - Math.exp(-1)),
    };
    for (const [falloff, half] of Object.entries(expected) as Array<[BuiltInSoundAttenuationFalloff, number]>) {
      const curve = BUILT_IN_FALLOFF_CURVES[falloff];
      expect(sampleFalloffCurve(curve, 0), falloff).toBe(1);
      expect(sampleFalloffCurve(curve, 0.5), falloff).toBeCloseTo(half, 5);
      expect(sampleFalloffCurve(curve, 1), falloff).toBe(0);
      let previous = 1;
      for (let i = 1; i <= 200; i += 1) {
        const value = sampleFalloffCurve(curve, i / 200);
        expect(value, `${falloff} at ${i / 200}`).toBeLessThanOrEqual(previous);
        previous = value;
      }
    }
  });

  it("keeps the built-in keys within 0.001 of their shapes, Inverse and Exponential being the rolloff-1 formulas they replace", () => {
    const formulas = {
      natural: (t: number) => (1 - t) ** 3 * (1 + 3 * t),
      inverse: (t: number) => (1 - t) / (1 + t),
      exponential: (t: number) => (Math.exp(-t) - Math.exp(-1)) / (1 - Math.exp(-1)),
    };
    for (const [falloff, formula] of Object.entries(formulas) as Array<["natural" | "inverse" | "exponential", (t: number) => number]>) {
      for (let i = 0; i <= 100; i += 1) {
        expect(Math.abs(sampleFalloffCurve(BUILT_IN_FALLOFF_CURVES[falloff], i / 100) - formula(i / 100)), `${falloff} at ${i / 100}`).toBeLessThan(0.001);
      }
    }
  });

  it("resolves Custom to its curve, and without one to Natural as missing", () => {
    const custom: Curve<number> = { Keys: [], Before: "constant", After: "constant" };
    expect(resolveSoundAttenuationCurve({ falloff: "inverse" })).toEqual({ curve: BUILT_IN_FALLOFF_CURVES.inverse, missing: false });
    expect(resolveSoundAttenuationCurve({ falloff: "custom", customCurve: custom })).toEqual({ curve: custom, missing: false });
    expect(resolveSoundAttenuationCurve({ falloff: "custom", customCurve: null })).toEqual({ curve: BUILT_IN_FALLOFF_CURVES.natural, missing: true });
  });

  it("builds a library entry with its Custom curve, or none when the library lacks it", () => {
    const curve = { Keys: [{ Time: 0, Value: 0.75, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 }], Before: "constant", After: "constant" };
    const lookups: string[] = [];
    const lookup = (guid: string) => {
      lookups.push(guid);
      return guid === "curve-1" ? { curve } : undefined;
    };
    expect(soundAttenuationLibraryEntry({ falloff: "custom", falloffCurveGuid: "curve-1" }, lookup).customCurve).toEqual(curve);
    expect(soundAttenuationLibraryEntry({ falloff: "custom", falloffCurveGuid: "gone" }, lookup).customCurve).toBeNull();
    // A built-in falloff never reads the curve it keeps.
    expect(soundAttenuationLibraryEntry({ falloff: "linear", falloffCurveGuid: "curve-1" }, lookup).customCurve).toBeNull();
    expect(lookups).toEqual(["curve-1", "gone"]);
  });

  it("reports a Custom falloff without its curve once and plays Natural", () => {
    const result = sanitizeAudioLibrary({
      audio: new Map(),
      channels: new Map(),
      attenuations: new Map([
        ["att-missing", soundAttenuationLibraryEntry({ falloff: "custom", falloffCurveGuid: "gone" }, () => undefined)],
        ["att-none", soundAttenuationLibraryEntry({ falloff: "custom" }, () => undefined)],
        ["att-linear", soundAttenuationLibraryEntry({ falloff: "linear" }, () => undefined)],
      ]),
    });
    expect(result.diagnostics.map((row) => [row.code, row.guid])).toEqual([
      ["audio.missing_falloff_curve", "att-missing"],
      ["audio.missing_falloff_curve", "att-none"],
    ]);
    expect(result.attenuations.get("att-missing")?.curve).toBe(BUILT_IN_FALLOFF_CURVES.natural);
    expect(result.attenuations.get("att-linear")?.curve).toBe(BUILT_IN_FALLOFF_CURVES.linear);
    expect(result.attenuations.get("att-linear")).not.toHaveProperty("customCurve");
  });

  it("plots the steps at Inner and Max Radius and the silence past Max", () => {
    const half: Curve<number> = { Keys: [{ Time: 0, Value: 0.5, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 }], Before: "constant", After: "constant" };
    expect(attenuationPlotPoints({ innerRadius: 10, maxRadius: 20, curve: half }, 2)).toEqual([
      { distance: 0, gain: 1 },
      { distance: 10, gain: 1 },
      { distance: 10, gain: 0.5 },
      { distance: 20, gain: 0.5 },
      { distance: 20, gain: 0 },
      { distance: 22, gain: 0 },
    ]);
    // A curve from 1 to 0 needs no step.
    expect(attenuationPlotPoints({ innerRadius: 0, maxRadius: 10, curve: BUILT_IN_FALLOFF_CURVES.linear }, 3)).toEqual([
      { distance: 0, gain: 1 },
      { distance: 0, gain: 1 },
      { distance: 5, gain: 0.5 },
      { distance: 10, gain: 0 },
      { distance: 11, gain: 0 },
    ]);
    // Max equal to Inner: full volume to the radius, then silent.
    expect(attenuationPlotPoints({ innerRadius: 4, maxRadius: 4, curve: BUILT_IN_FALLOFF_CURVES.linear })).toEqual([
      { distance: 0, gain: 1 },
      { distance: 4, gain: 1 },
      { distance: 4, gain: 0 },
      { distance: 4.4, gain: 0 },
    ]);
  });

  it("raises Doppler playbackRate when the emitter moves toward the listener", () => {
    expect(
      computeDopplerPlaybackRate({
        previousEmitter: { x: 10, y: 0, z: 0 },
        emitter: { x: 5, y: 0, z: 0 },
        listener: { x: 0, y: 0, z: 0 },
        dt: 0.1,
        factor: 1,
      }),
    ).toBeCloseTo(1 + 50 / AUDIO_SPEED_OF_SOUND, 5);
    expect(
      computeDopplerPlaybackRate({
        previousEmitter: null,
        emitter: { x: 5, y: 0, z: 0 },
        listener: { x: 0, y: 0, z: 0 },
        dt: 0.1,
        factor: 1,
      }),
    ).toBe(1);
  });

  it("enforces attenuation radii and known falloffs", () => {
    expect(normalizeSoundAttenuationPayload({})).toMatchObject({ innerRadius: 10, maxRadius: 250, falloff: "natural", falloffCurveGuid: null });
    expect(normalizeSoundAttenuationPayload({ innerRadius: NaN, maxRadius: Infinity })).toMatchObject({ innerRadius: 10, maxRadius: 250 });
    expect(normalizeSoundAttenuationPayload({ innerRadius: 1, maxRadius: 50 })).toMatchObject({ innerRadius: 1, maxRadius: 50 });
    const swapped = normalizeSoundAttenuationPayload({
      innerRadius: 20,
      maxRadius: 5,
      falloff: "bogus",
      spatialisation: "hrtf",
    });
    expect(swapped.innerRadius).toBe(5);
    expect(swapped.maxRadius).toBe(20);
    expect(swapped.falloff).toBe("natural");
    expect(swapped.spatialisation).toBe("hrtf");
    expect(
      normalizeSoundAttenuationPayload({ innerRadius: -4, maxRadius: -1 })
        .innerRadius,
    ).toBe(0);
    expect(normalizeSoundAttenuationPayload({ falloff: "custom", falloffCurveGuid: " curve-1 " })).toMatchObject({ falloff: "custom", falloffCurveGuid: "curve-1" });
    expect(normalizeSoundAttenuationPayload({ falloff: "exponential", falloffCurveGuid: "" })).toMatchObject({ falloff: "exponential", falloffCurveGuid: null });
  });
});

describe("audio asset containers", () => {
  it("round-trips a new Audio hasset and keeps the source chunk", async () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    const payload = {
      volume: 0.5,
      audioChannelGuid: "ch-1",
      soundAttenuationGuid: "att-1",
    };
    const encoded = await encodeHasset({
      header: {
        ...collectAssetDependencyMetadata("Audio", payload),
        guid: "00000000-0000-4000-8000-00000000a001",
        type: "Audio",
        name: "Jump",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        parentClass: null,
        payload,
      },
      chunks: [{ id: "source", kind: "audio", mime: "audio/wav", data: source }],
    });
    const relative = "__fixtures__/audio-v1.hasset";
    if (UPDATE) writeGoldenBinary(FIXTURE_DIR, relative, encoded);
    const golden = readGoldenBinary(FIXTURE_DIR, relative);
    expect(bytesEqual(encoded, golden)).toBe(true);
    const decoded = await decodeHasset(golden);
    expect(decoded.header.payload).toEqual({
      volume: 0.5,
      audioChannelGuid: "ch-1",
      soundAttenuationGuid: "att-1",
    });
    expect(decoded.header.dependencies).toEqual(["att-1", "ch-1"]);
    expect(decoded.header.chunks[0]!.byteLength).toBe(source.byteLength);
    expect(decoded.chunks.get("source")).toEqual(source);
  });

  it("round-trips mixer, channel, and attenuation documents", async () => {
    for (const [type, payload] of [
      [
        "AudioMixer",
        normalizeAudioMixerPayload({
          globalVolume: 0.8,
          channels: [{ channelGuid: "ch-1", volume: 0.5 }],
        }),
      ],
      [
        "AudioChannel",
        normalizeAudioChannelPayload({
          parentChannelGuid: null,
          effects: [{ kind: "environmentReverb", enabled: true }],
        }),
      ],
      ["SoundAttenuation", normalizeSoundAttenuationPayload({})],
    ] as const) {
      const encoded = await encodeAssetDocument({
        type,
        name: type,
        guid: `00000000-0000-4000-8000-${type.padEnd(12, "0").slice(0, 12)}`,
        version: 1,
        payload: payload as unknown as Record<string, unknown>,
      });
      const decoded = await decodeAssetDocument(encoded);
      expect(decoded.type).toBe(type);
      expect(decoded.payload).toEqual(payload);
    }
  });

  it("imports audio as version 1 with a named source clip and source chunk", async () => {
    const results = await importAudio(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]), {
      fileName: "jump.wav",
      existingGuids: new Set(),
    });
    expect(results[0]!.payload).toEqual({
      playbackMode: "decoded",
      clips: [{ chunkId: "source", name: "jump", weight: 1 }],
    });
    expect(results[0]!.version).toBe(1);
    expect(results[0]!.chunks[0]).toMatchObject({
      id: "source",
      kind: "audio",
      mime: "audio/wav",
    });
    expect(normalizeAudioPayload(results[0]!.payload).clips).toEqual([
      { chunkId: "source", name: "jump", weight: 1 },
    ]);
  });

  it("fills an empty source clip name from the asset name", () => {
    expect(
      fillEmptySourceClipName(createDefaultAudioPayload(), "beep").clips[0],
    ).toEqual({ chunkId: "source", name: "beep", weight: 1 });
    expect(
      fillEmptySourceClipName(
        { clips: [{ chunkId: "source", name: "jump", weight: 1 }] },
        "beep",
      ).clips[0]!.name,
    ).toBe("jump");
    expect(
      fillEmptySourceClipName(
        {
          clips: [
            { chunkId: "source", name: "  ", weight: 1 },
            { chunkId: "source:2", name: "", weight: 2 },
          ],
        },
        "beep",
      ).clips,
    ).toEqual([
      { chunkId: "source", name: "beep", weight: 1 },
      { chunkId: "source:2", name: "", weight: 2 },
    ]);
  });

  it("packs Audio payload with source bytes and round-trips", () => {
    const payload = normalizeAudioPayload({
      volume: 0.5,
      audioChannelGuid: "sfx",
      soundAttenuationGuid: "near",
    });
    const source = new Uint8Array([1, 2, 3, 4, 5]);
    const packed = encodePackedAudioAsset(payload, source);
    expect(decodePackedAudioAsset(source)).toBeNull();
    expect(peekPackedAudioPayload(packed)).toEqual(payload);
    expect(extractPackedAudioClipBytes(packed, "source")).toEqual(source);
    expect(decodePackedAudioAsset(packed)).toEqual({
      payload,
      source,
      sources: [source],
    });
  });

  it("packs several clip blobs and reads each back", () => {
    const payload = normalizeAudioPayload({
      clips: [
        { chunkId: "source", name: "a", weight: 1 },
        { chunkId: "source:2", name: "b", weight: 2 },
      ],
    });
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([9, 8, 7, 6]);
    const packed = encodePackedAudioAsset(payload, [first, second]);
    expect(decodePackedAudioAsset(packed)).toEqual({
      payload,
      source: first,
      sources: [first, second],
    });
    expect(extractPackedAudioClipBytes(packed, "source:2")).toEqual(second);
  });

  it("reads one clip whose bytes look like a clip table as that one clip", () => {
    const payload = normalizeAudioPayload({});
    // Count 2, then lengths and bytes that fill the rest exactly: a guessing reader would split it.
    const clip = new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 7, 1, 0, 0, 0, 8]);
    const packed = encodePackedAudioAsset(payload, clip);
    expect(decodePackedAudioAsset(packed)?.sources).toEqual([clip]);
  });

  it("keeps a metadata-only envelope with no clips", () => {
    const payload = normalizeAudioPayload({ loop: true });
    const packed = encodePackedAudioAsset(payload, []);
    expect(decodePackedAudioAsset(packed)).toEqual({ payload, source: new Uint8Array(), sources: [] });
  });

  it("rejects a malformed or unsupported envelope instead of guessing", () => {
    const packed = encodePackedAudioAsset(normalizeAudioPayload({}), new Uint8Array([1, 2, 3]));
    const withWord = (offset: number, value: number) => {
      const bytes = packed.slice();
      new DataView(bytes.buffer).setUint16(offset, value, true);
      return bytes;
    };
    expect(() => decodePackedAudioAsset(withWord(4, 2))).toThrow(/version: 2/);
    expect(() => decodePackedAudioAsset(withWord(6, 1))).toThrow(/unknown flags/);
    expect(() => decodePackedAudioAsset(packed.subarray(0, packed.byteLength - 1))).toThrow(/truncated clip/);
    const trailing = new Uint8Array(packed.byteLength + 1);
    trailing.set(packed);
    expect(() => decodePackedAudioAsset(trailing)).toThrow(/trailing bytes/);
    expect(() => decodePackedAudioAsset(packed.subarray(0, 10))).toThrow(/truncated header/);
  });

  it("packs asset loop into the HPAU JSON envelope", () => {
    const payload = normalizeAudioPayload({ loop: true });
    const packed = encodePackedAudioAsset(payload, new Uint8Array([1, 2]));
    expect(decodePackedAudioAsset(packed)?.payload.loop).toBe(true);
  });
});
