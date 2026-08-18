import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readGoldenBinary, writeGoldenBinary } from "@babylonslate/test-kit";
import {
  AUDIO_ASSET_TYPES,
  AUDIO_BAKE_DEBOUNCE_MS,
  AUDIO_BAKE_WORKER_TIMEOUT_MS,
  AUDIO_CROSSFADING_PROFILES,
  AUDIO_DECODED_PCM_LRU_BYTES,
  AUDIO_GEOMETRY_COLLECT_SLICE,
  AUDIO_MAX_CONCURRENT_VOICES,
  AUDIO_MAX_PROBES,
  AUDIO_OCCUPANCY_GRID_MAX_X,
  AUDIO_OCCUPANCY_GRID_MAX_Y,
  AUDIO_OCCUPANCY_GRID_MAX_Z,
  AUDIO_PRE_UNLOCK_QUEUE_CAP,
  AUDIO_REVERB_CHUNK_MAX_BYTES,
  AUDIO_SHARED_REVERB_BUSES,
  AUDIO_VOXEL_SIZE,
  audioAssetDependencies,
  remapAudioPayloadGuids,
  computeAttenuationGain,
  audioChannelHasParentCycle,
  clampAudioGain,
  computeAudioOutputGain,
  resolveAudioPlayback,
  encodePackedAudioAsset,
  decodePackedAudioAsset,
  createDefaultAudioChannelPayload,
  createDefaultAudioMixerPayload,
  createDefaultAudioPayload,
  createDefaultSoundAttenuationPayload,
  normalizeAudioChannelPayload,
  normalizeAudioMixerPayload,
  normalizeAudioPayload,
  normalizeSoundAttenuationPayload,
  resolveAudioReferences,
  validateAudioChannelGraph,
  validateAudioMixer,
} from "./audio-payload";
import { decodeAssetDocument, encodeAssetDocument } from "./asset-document";
import { decodeBabasset, encodeBabasset } from "./babasset";
import { bytesEqual } from "./bytes";
import { importAudio } from "./importers/audio";
import { loadPayloadWithMigration } from "./migrate-on-load";
import { createDefaultMigrationRegistry } from "./migration";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";

describe("audio payloads", () => {
  it("checks in the A16 audio budgets as named constants", () => {
    expect(AUDIO_OCCUPANCY_GRID_MAX_X).toBe(24);
    expect(AUDIO_OCCUPANCY_GRID_MAX_Y).toBe(24);
    expect(AUDIO_OCCUPANCY_GRID_MAX_Z).toBe(16);
    expect(AUDIO_VOXEL_SIZE).toBe(2);
    expect(AUDIO_MAX_PROBES).toBe(32);
    expect(AUDIO_REVERB_CHUNK_MAX_BYTES).toBe(64 * 1024);
    expect(AUDIO_BAKE_WORKER_TIMEOUT_MS).toBe(8_000);
    expect(AUDIO_GEOMETRY_COLLECT_SLICE).toBe(8);
    expect(AUDIO_BAKE_DEBOUNCE_MS).toBe(1_500);
    expect(AUDIO_SHARED_REVERB_BUSES).toBe(1);
    expect(AUDIO_CROSSFADING_PROFILES).toBe(2);
    expect(AUDIO_PRE_UNLOCK_QUEUE_CAP).toBe(32);
    expect(AUDIO_DECODED_PCM_LRU_BYTES).toBe(64 * 1024 * 1024);
    expect(AUDIO_MAX_CONCURRENT_VOICES).toBe(32);
  });

  it("normalizes empty imported Audio without inventing channel or attenuation", () => {
    expect(normalizeAudioPayload({})).toEqual({
      volume: 1,
      audioChannelGuid: null,
      soundAttenuationGuid: null,
    });
    expect(normalizeAudioPayload(undefined)).toEqual(createDefaultAudioPayload());
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
      effects: [{ kind: "environmentReverb", enabled: false }],
    });
    expect(createDefaultSoundAttenuationPayload()).toEqual({
      innerRadius: 1,
      maxRadius: 50,
      distanceModel: "linear",
      rolloff: 1,
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
    expect(AUDIO_ASSET_TYPES).toEqual([
      "Audio",
      "AudioMixer",
      "AudioChannel",
      "SoundAttenuation",
    ]);
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
    expect(audioAssetDependencies("Class", { audioChannelGuid: "ch-1" })).toEqual(
      [],
    );
  });

  it("remaps Audio, mixer, and channel guids in payloads", () => {
    const remap = new Map([
      ["ch-old", "ch-new"],
      ["att-old", "att-new"],
    ]);
    expect(
      remapAudioPayloadGuids(
        "Audio",
        {
          volume: 1,
          audioChannelGuid: "ch-old",
          soundAttenuationGuid: "att-old",
        },
        remap,
      ),
    ).toEqual({
      volume: 1,
      audioChannelGuid: "ch-new",
      soundAttenuationGuid: "att-new",
    });
    expect(
      remapAudioPayloadGuids(
        "AudioMixer",
        { globalVolume: 1, channels: [{ channelGuid: "ch-old", volume: 0.5 }] },
        remap,
      ),
    ).toEqual({
      globalVolume: 1,
      channels: [{ channelGuid: "ch-new", volume: 0.5 }],
    });
    expect(
      remapAudioPayloadGuids(
        "AudioChannel",
        { parentChannelGuid: "ch-old", effects: [] },
        remap,
      ),
    ).toMatchObject({ parentChannelGuid: "ch-new" });
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

  it("keeps attenuation full inside the inner radius and silent at max", () => {
    const atten = createDefaultSoundAttenuationPayload();
    expect(computeAttenuationGain(0, atten)).toBe(1);
    expect(computeAttenuationGain(1, atten)).toBe(1);
    expect(computeAttenuationGain(50, atten)).toBe(0);
    expect(computeAttenuationGain(25.5, atten)).toBeCloseTo(0.5);
    const farther = computeAttenuationGain(40, atten);
    const nearer = computeAttenuationGain(10, atten);
    expect(farther).toBeLessThan(nearer);
    expect(farther).toBeGreaterThan(0);
  });

  it("enforces attenuation radii and known distance models", () => {
    const swapped = normalizeSoundAttenuationPayload({
      innerRadius: 20,
      maxRadius: 5,
      distanceModel: "bogus",
      spatialisation: "hrtf",
    });
    expect(swapped.innerRadius).toBe(5);
    expect(swapped.maxRadius).toBe(20);
    expect(swapped.distanceModel).toBe("linear");
    expect(swapped.spatialisation).toBe("hrtf");
    expect(
      normalizeSoundAttenuationPayload({ innerRadius: -4, maxRadius: -1 })
        .innerRadius,
    ).toBe(0);
  });
});

describe("audio asset containers", () => {
  it("round-trips a new Audio babasset and keeps the source chunk", async () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    const encoded = await encodeBabasset({
      header: {
        guid: "00000000-0000-4000-8000-00000000a001",
        type: "Audio",
        name: "Jump",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: ["att-1", "ch-1"],
        parentClass: null,
        payload: {
          volume: 0.5,
          audioChannelGuid: "ch-1",
          soundAttenuationGuid: "att-1",
        },
      },
      chunks: [{ id: "source", kind: "audio", mime: "audio/wav", data: source }],
    });
    const relative = "__fixtures__/audio-v1.babasset";
    if (UPDATE) writeGoldenBinary(FIXTURE_DIR, relative, encoded);
    const golden = readGoldenBinary(FIXTURE_DIR, relative);
    expect(bytesEqual(encoded, golden)).toBe(true);
    const decoded = await decodeBabasset(golden);
    expect(decoded.header.payload).toEqual({
      volume: 0.5,
      audioChannelGuid: "ch-1",
      soundAttenuationGuid: "att-1",
    });
    expect(decoded.header.dependencies).toEqual(["att-1", "ch-1"]);
    expect(decoded.chunks.get("source")).toEqual(source);
  });

  it("normalizes an old Audio babasset without rewriting source bytes", async () => {
    const source = new Uint8Array([9, 8, 7]);
    const encoded = await encodeBabasset({
      header: {
        guid: "00000000-0000-4000-8000-00000000a000",
        type: "Audio",
        name: "Hit",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: {},
      },
      chunks: [{ id: "source", kind: "audio", mime: "audio/wav", data: source }],
    });
    const relative = "__fixtures__/audio-legacy.babasset";
    if (UPDATE) writeGoldenBinary(FIXTURE_DIR, relative, encoded);
    const golden = readGoldenBinary(FIXTURE_DIR, relative);
    expect(bytesEqual(encoded, golden)).toBe(true);
    const decoded = await decodeBabasset(golden);
    expect(decoded.header.payload).toEqual({});
    expect(decoded.chunks.get("source")).toEqual(source);
    const loaded = loadPayloadWithMigration(createDefaultMigrationRegistry(), {
      type: "Audio",
      version: decoded.header.version,
      payload: decoded.header.payload,
      path: "assets/Hit.babasset",
    });
    expect(normalizeAudioPayload(loaded.payload)).toEqual(
      createDefaultAudioPayload(),
    );
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

  it("imports audio as version 1 with an empty payload and source chunk", async () => {
    const results = await importAudio(new Uint8Array([4, 5, 6]), {
      fileName: "jump.wav",
      existingGuids: new Set(),
    });
    expect(results[0]!.payload).toEqual({});
    expect(results[0]!.version).toBe(1);
    expect(results[0]!.chunks[0]).toMatchObject({
      id: "source",
      kind: "audio",
      mime: "audio/wav",
    });
    expect(normalizeAudioPayload(results[0]!.payload)).toEqual(
      createDefaultAudioPayload(),
    );
  });

  it("packs Audio payload with source bytes and round-trips", () => {
    const payload = {
      volume: 0.5,
      audioChannelGuid: "sfx",
      soundAttenuationGuid: "near",
    };
    const source = new Uint8Array([1, 2, 3, 4, 5]);
    const packed = encodePackedAudioAsset(payload, source);
    expect(decodePackedAudioAsset(source)).toBeNull();
    expect(decodePackedAudioAsset(packed)).toEqual({ payload, source });
  });
});
