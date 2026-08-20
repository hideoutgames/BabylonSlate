import { describe, expect, it } from "vitest";
import {
  AUDIO_MAX_CONCURRENT_VOICES,
  AUDIO_PRE_UNLOCK_QUEUE_CAP,
  AUDIO_REVERB_VERSION,
  AUDIO_SPEED_OF_SOUND,
  audioClipCacheKey,
  createDefaultAudioPayload,
  encodeAudioReverbChunk,
  normalizeAudioPayload,
  type AudioChannelPayload,
  type AudioMixerPayload,
  type SoundAttenuationPayload,
} from "@babylonslate/assets";
import { AudioBufferCache } from "./audio-buffer-cache";
import { FakeAudioPlaybackBackend } from "./audio-playback-backend";
import { AudioService } from "./audio-service";

function library(options?: {
  mixer?: AudioMixerPayload | null;
  mixerGuid?: string | null;
  channels?: Record<string, AudioChannelPayload>;
  audio?: Record<string, unknown>;
  attenuations?: Record<string, SoundAttenuationPayload>;
}) {
  return {
    mixerGuid: options?.mixerGuid ?? (options?.mixer ? "mixer-1" : null),
    mixers: new Map(
      options?.mixer ? [["mixer-1", options.mixer] as const] : [],
    ),
    channels: new Map(Object.entries(options?.channels ?? {})),
    audio: new Map(
      Object.entries(options?.audio ?? {}).map(([guid, payload]) => [
        guid,
        normalizeAudioPayload(payload),
      ]),
    ),
    attenuations: new Map(Object.entries(options?.attenuations ?? {})),
  };
}

describe("AudioService", () => {
  it("unlocks without creating the engine on the gesture turn after warm", async () => {
    const backend = new FakeAudioPlaybackBackend();
    await backend.warmAsync();
    expect(backend.engineCreateCount).toBe(1);
    await backend.unlockAsync();
    expect(backend.engineCreateCount).toBe(1);
    expect(backend.unlocked).toBe(true);
  });
  it("accepts a no-config play at asset × playCall gain after unlock", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const diagnostics: Array<{ code: string }> = [];
    const service = new AudioService({
      backend,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    service.setLibrary(
      library({
        audio: { jump: { ...createDefaultAudioPayload(), volume: 0.5 } },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1, 2, 3, 4]));
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 0.5,
      frameId: 1,
    });
    expect(backend.plays).toHaveLength(0);
    expect(service.stats().queued).toBe(1);
    await service.unlockAsync();
    expect(backend.plays).toEqual([
      expect.objectContaining({ assetGuid: "jump", gain: 0.25, loop: false }),
    ]);
    expect(service.stats()).toMatchObject({
      unlocked: true,
      queued: 0,
      voices: 1,
      lastGain: 0.25,
    });
    expect(diagnostics).toEqual([]);
    service.dispose();
    expect(service.stats().voices).toBe(0);
    expect(service.stats().accountedBytes).toBe(0);
  });

  it("loads source bytes on first playSound and skips unused assets", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const reads: string[] = [];
    const service = new AudioService({
      backend,
      loadSourceBytes: async ({ assetGuid, chunkId }) => {
        reads.push(`${assetGuid}:${chunkId}`);
        if (assetGuid !== "jump") return null;
        return new Uint8Array([1, 2, 3, 4]);
      },
    });
    service.setLibrary(
      library({
        audio: {
          jump: createDefaultAudioPayload(),
          bed: createDefaultAudioPayload(),
        },
      }),
    );
    await service.unlockAsync();
    expect(reads).toEqual([]);
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
    });
    await service.flush();
    expect(reads).toEqual(["jump:source"]);
    expect(backend.plays).toHaveLength(1);
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 2,
    });
    await service.flush();
    expect(reads).toEqual(["jump:source"]);
    expect(backend.plays).toHaveLength(2);
    service.dispose();
  });

  it("loads only the chosen weighted clip chunkId", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const reads: string[] = [];
    const service = new AudioService({
      backend,
      random: () => 0.99,
      loadSourceBytes: async ({ assetGuid, chunkId }) => {
        reads.push(`${assetGuid}:${chunkId}`);
        return new Uint8Array([1, 2, 3, 4]);
      },
    });
    service.setLibrary(
      library({
        audio: {
          jump: {
            clips: [
              { chunkId: "source", name: "a", weight: 1 },
              { chunkId: "source:2", name: "b", weight: 1 },
            ],
          },
        },
      }),
    );
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
    });
    await service.flush();
    expect(reads).toEqual(["jump:source:2"]);
    expect(backend.plays).toHaveLength(1);
    service.dispose();
  });

  it("diagnoses a lazy load miss without throwing", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const diagnostics: Array<{ code: string; assetGuid?: string }> = [];
    const service = new AudioService({
      backend,
      onDiagnostic: (entry) => diagnostics.push(entry),
      loadSourceBytes: async () => null,
    });
    service.setLibrary(library({ audio: { jump: createDefaultAudioPayload() } }));
    await service.unlockAsync();
    expect(() =>
      service.handleCommand({
        type: "playSound",
        assetGuid: "jump",
        volume: 1,
        frameId: 1,
      }),
    ).not.toThrow();
    await service.flush();
    expect(backend.plays).toHaveLength(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "audio.missing_source", assetGuid: "jump" }),
    ]);
    service.dispose();
  });

  it("resumes the backend on unlock before loading queued source bytes", async () => {
    const order: string[] = [];
    const backend = new FakeAudioPlaybackBackend();
    const resume = backend.unlockAsync.bind(backend);
    backend.unlockAsync = async () => {
      order.push("unlock");
      await resume();
    };
    const service = new AudioService({
      backend,
      loadSourceBytes: async ({ assetGuid, chunkId }) => {
        order.push(`load:${assetGuid}:${chunkId}`);
        return new Uint8Array([1, 2, 3, 4]);
      },
    });
    service.setLibrary(
      library({ audio: { jump: createDefaultAudioPayload() } }),
    );
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
    });
    const unlocking = service.unlockAsync();
    expect(order).toEqual(["unlock"]);
    await unlocking;
    expect(order).toEqual(["unlock", "load:jump:source"]);
    expect(backend.plays).toHaveLength(1);
    service.dispose();
  });

  it("nulls missing Audio Channel and Attenuation refs with diagnostics", () => {
    const diagnostics: Array<{ code: string }> = [];
    const service = new AudioService({
      backend: new FakeAudioPlaybackBackend(),
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    service.setLibrary(
      library({
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: "gone-channel",
            soundAttenuationGuid: "gone-atten",
          },
        },
      }),
    );
    expect(diagnostics.map((entry) => entry.code).sort()).toEqual([
      "audio.missing_attenuation",
      "audio.missing_channel",
    ]);
    service.dispose();
  });

  it("caps the pre-unlock queue and drains in order", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        audio: { a: createDefaultAudioPayload(), b: createDefaultAudioPayload() },
      }),
    );
    service.setSourceBytes("a", new Uint8Array([1]));
    service.setSourceBytes("b", new Uint8Array([2]));
    for (let i = 0; i < AUDIO_PRE_UNLOCK_QUEUE_CAP + 4; i++) {
      service.handleCommand({
        type: "playSound",
        assetGuid: i % 2 === 0 ? "a" : "b",
        volume: 1,
        frameId: i,
        voiceId: `v${i}`,
      });
    }
    expect(service.stats().queued).toBe(AUDIO_PRE_UNLOCK_QUEUE_CAP);
    await service.unlockAsync();
    expect(backend.plays[0]?.voiceId).toBe("v4");
    expect(backend.plays.at(-1)?.voiceId).toBe(
      `v${AUDIO_PRE_UNLOCK_QUEUE_CAP + 3}`,
    );
    expect(backend.plays).toHaveLength(AUDIO_PRE_UNLOCK_QUEUE_CAP);
  });

  it("diagnoses missing source bytes without throwing", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const diagnostics: Array<{ code: string; assetGuid?: string }> = [];
    const service = new AudioService({
      backend,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    service.setLibrary(library({ audio: { missing: createDefaultAudioPayload() } }));
    await service.unlockAsync();
    expect(() =>
      service.handleCommand({
        type: "playSound",
        assetGuid: "missing",
        volume: 1,
        frameId: 1,
      }),
    ).not.toThrow();
    await service.flush();
    expect(backend.plays).toHaveLength(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "audio.missing_source", assetGuid: "missing" }),
    ]);
  });

  it("applies mixer session volumes without mutating asset defaults", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const mixer: AudioMixerPayload = {
      globalVolume: 1,
      channels: [{ channelGuid: "sfx", volume: 1 }],
    };
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        mixer,
        channels: {
          sfx: {
            parentChannelGuid: null,
            effects: [{ kind: "environmentReverb", enabled: false }],
          },
        },
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: "sfx",
            soundAttenuationGuid: null,
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.handleCommand({ type: "setChannelVolume", channelGuid: "sfx", volume: 0.5 });
    service.handleCommand({ type: "setGlobalVolume", volume: 0.5 });
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
    });
    await service.flush();
    expect(backend.plays[0]?.gain).toBe(0.25);
    expect(mixer.globalVolume).toBe(1);
    expect(mixer.channels[0]?.volume).toBe(1);
  });

  it("stops a voice and returns buffers to the LRU baseline", async () => {
    const cache = new AudioBufferCache({ byteCeiling: 1024 });
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend, cache });
    service.setLibrary(library({ audio: { jump: createDefaultAudioPayload() } }));
    service.setSourceBytes("jump", new Uint8Array(8));
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "v1",
    });
    await service.flush();
    expect(service.stats().voices).toBe(1);
    expect(service.stats().accountedBytes).toBeGreaterThan(0);
    service.handleCommand({ type: "stopSound", voiceId: "v1" });
    await service.flush();
    expect(backend.stopped).toEqual(["v1"]);
    expect(service.stats().voices).toBe(0);
    service.dispose();
    expect(cache.accountedBytes()).toBe(0);
    expect(AUDIO_MAX_CONCURRENT_VOICES).toBe(32);
  });

  it("plays attenuated sounds without an actor as non-spatial and diagnoses once", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const diagnostics: Array<{ code: string }> = [];
    const service = new AudioService({
      backend,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    service.setLibrary(
      library({
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: null,
            soundAttenuationGuid: "near",
          },
        },
        attenuations: {
          near: {
            innerRadius: 1,
            maxRadius: 10,
            distanceModel: "linear",
            rolloff: 1,
            spatialisation: "equalPower",
            cone: null,
            doppler: null,
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "v1",
    });
    await service.flush();
    expect(backend.plays[0]?.spatial).toBeNull();
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "audio.missing_emitter" }),
    ]);
    service.dispose();
  });

  it("follows snapshot poses and reports lastDistance", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: null,
            soundAttenuationGuid: "near",
          },
        },
        attenuations: {
          near: {
            innerRadius: 1,
            maxRadius: 50,
            distanceModel: "linear",
            rolloff: 1,
            spatialisation: "equalPower",
            cone: null,
            doppler: null,
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.noteActorSlot("speaker", 1);
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "v1",
      emitterActorGuid: "speaker",
    });
    await service.flush();
    service.syncListener({ x: 0, y: 0, z: 0 });
    service.syncSnapshot([{ slotId: 1, position: { x: 10, y: 0, z: 0 } }]);
    expect(service.stats().lastDistance).toBe(10);
    expect(backend.poses.get("v1")).toEqual({ x: 10, y: 0, z: 0 });
    expect(backend.gains.get("v1")).toBeUndefined();
    service.dispose();
  });

  it("forwards snapshot emitter orientation so cones aim with the actor", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: null,
            soundAttenuationGuid: "near",
          },
        },
        attenuations: {
          near: {
            innerRadius: 1,
            maxRadius: 50,
            distanceModel: "linear",
            rolloff: 1,
            spatialisation: "equalPower",
            cone: { innerAngle: 90, outerAngle: 120, outerGain: 0 },
            doppler: null,
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.noteActorSlot("speaker", 1);
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "v1",
      emitterActorGuid: "speaker",
    });
    await service.flush();
    const yaw = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    service.syncSnapshot([
      {
        slotId: 1,
        position: { x: 10, y: 0, z: 0, qx: yaw.x, qy: yaw.y, qz: yaw.z, qw: yaw.w },
      },
    ]);
    expect(backend.poses.get("v1")).toEqual({
      x: 10,
      y: 0,
      z: 0,
      qx: yaw.x,
      qy: yaw.y,
      qz: yaw.z,
      qw: yaw.w,
    });
    service.dispose();
  });

  it("does not invent session gain when Set Channel / Set Global have no mixer", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const diagnostics: Array<{ code: string }> = [];
    const service = new AudioService({
      backend,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    service.setLibrary(library({ audio: { jump: createDefaultAudioPayload() } }));
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.handleCommand({
      type: "setChannelVolume",
      channelGuid: "sfx",
      volume: 0.1,
    });
    service.handleCommand({ type: "setGlobalVolume", volume: 0.1 });
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
    });
    await service.flush();
    expect(backend.plays[0]?.gain).toBe(1);
    expect(diagnostics.map((entry) => entry.code)).toEqual([
      "audio.no_mixer",
      "audio.no_mixer",
    ]);
    service.dispose();
  });

  it("warns and no-ops Set Channel Volume for a channel the mixer does not know", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const diagnostics: Array<{ code: string }> = [];
    const service = new AudioService({
      backend,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    service.setLibrary(
      library({
        mixer: {
          globalVolume: 1,
          channels: [{ channelGuid: "sfx", volume: 1 }],
        },
        channels: {
          sfx: {
            parentChannelGuid: null,
            effects: [{ kind: "environmentReverb", enabled: false }],
          },
        },
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: "sfx",
            soundAttenuationGuid: null,
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.handleCommand({
      type: "setChannelVolume",
      channelGuid: "ghost",
      volume: 0,
    });
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
    });
    await service.flush();
    expect(backend.plays[0]?.gain).toBe(1);
    expect(diagnostics.map((entry) => entry.code)).toEqual(["audio.unknown_channel"]);
    service.dispose();
  });

  it("no-ops Set Channel Volume for a library channel absent from the mixer table", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const diagnostics: Array<{ code: string }> = [];
    const service = new AudioService({
      backend,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    service.setLibrary(
      library({
        mixer: {
          globalVolume: 1,
          channels: [],
        },
        channels: {
          sfx: {
            parentChannelGuid: null,
            effects: [{ kind: "environmentReverb", enabled: false }],
          },
        },
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: "sfx",
            soundAttenuationGuid: null,
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.handleCommand({
      type: "setChannelVolume",
      channelGuid: "sfx",
      volume: 0,
    });
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
    });
    await service.flush();
    expect(backend.plays[0]?.gain).toBe(1);
    expect(diagnostics.map((entry) => entry.code)).toEqual(["audio.unknown_channel"]);
    service.dispose();
  });

  it("applies Doppler playbackRate from emitter motion, not a second distance gain", async () => {
    let now = 0;
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend, now: () => now });
    service.setLibrary(
      library({
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: null,
            soundAttenuationGuid: "near",
          },
        },
        attenuations: {
          near: {
            innerRadius: 1,
            maxRadius: 50,
            distanceModel: "linear",
            rolloff: 1,
            spatialisation: "equalPower",
            cone: null,
            doppler: { enabled: true, factor: 1 },
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.noteActorSlot("speaker", 1);
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "v1",
      emitterActorGuid: "speaker",
    });
    await service.flush();
    service.syncListener({ x: 0, y: 0, z: 0 });
    now = 0;
    service.syncSnapshot([{ slotId: 1, position: { x: 10, y: 0, z: 0 } }]);
    now = 100;
    service.syncSnapshot([{ slotId: 1, position: { x: 5, y: 0, z: 0 } }]);
    // Production calls syncListener after each snapshot; that must not reset rate to 1.
    service.syncListener({ x: 0, y: 0, z: 0 });
    expect(backend.gains.get("v1")).toBeUndefined();
    expect(backend.playbackRates.get("v1")).toBeCloseTo(
      1 + 50 / AUDIO_SPEED_OF_SOUND,
      5,
    );
    service.dispose();
  });

  it("plays a weighted clip from guid:chunk bytes at authored pitch", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({
      backend,
      random: () => 0.25,
    });
    service.setLibrary(
      library({
        audio: {
          jump: {
            ...createDefaultAudioPayload(),
            pitch: 2,
            clips: [
              { chunkId: "source", name: "a", weight: 1 },
              { chunkId: "source:2", name: "b", weight: 3 },
            ],
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    service.setSourceBytes(
      audioClipCacheKey("jump", "source"),
      new Uint8Array([1]),
    );
    service.setSourceBytes(
      audioClipCacheKey("jump", "source:2"),
      new Uint8Array([9, 8, 7]),
    );
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "v1",
    });
    await service.flush();
    expect(backend.plays[0]?.source).toEqual(new Uint8Array([9, 8, 7]));
    expect(backend.plays[0]?.clipChunkId).toBe("source:2");
    expect(backend.playbackRates.get("v1")).toBe(2);
    service.dispose();
  });

  it("composes authored pitch with Doppler playbackRate", async () => {
    let now = 0;
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend, now: () => now });
    service.setLibrary(
      library({
        audio: {
          jump: {
            ...createDefaultAudioPayload(),
            pitch: 2,
            soundAttenuationGuid: "near",
          },
        },
        attenuations: {
          near: {
            innerRadius: 1,
            maxRadius: 50,
            distanceModel: "linear",
            rolloff: 1,
            spatialisation: "equalPower",
            cone: null,
            doppler: { enabled: true, factor: 1 },
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.noteActorSlot("speaker", 1);
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "v1",
      emitterActorGuid: "speaker",
    });
    await service.flush();
    service.syncListener({ x: 0, y: 0, z: 0 });
    now = 0;
    service.syncSnapshot([{ slotId: 1, position: { x: 10, y: 0, z: 0 } }]);
    now = 100;
    service.syncSnapshot([{ slotId: 1, position: { x: 5, y: 0, z: 0 } }]);
    service.syncListener({ x: 0, y: 0, z: 0 });
    expect(backend.playbackRates.get("v1")).toBeCloseTo(
      2 * (1 + 50 / AUDIO_SPEED_OF_SOUND),
      5,
    );
    service.dispose();
  });

  it("keeps channel-less playback dry even when a reverb field is loaded", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({ audio: { jump: createDefaultAudioPayload() } }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    service.setReverbField(
      encodeAudioReverbChunk({
        version: AUDIO_REVERB_VERSION,
        dryFallback: false,
        geometryHash: "h",
        probes: [
          {
            x: 0,
            y: 0,
            z: 0,
            volume: 1,
            openness: 0,
            decay: 0.5,
            damping: 0.5,
            wet: 0.4,
          },
        ],
      }),
    );
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
    });
    await service.flush();
    service.syncListener({ x: 0, y: 0, z: 0 });
    expect(backend.plays[0]?.reverbSend).toBe(false);
    expect(service.stats().wet).toBe(0);
    expect(backend.wet).toBe(0);
    service.dispose();
  });

  it("sends enabled channels to the shared bus using at most two probes", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        channels: {
          sfx: {
            parentChannelGuid: null,
            effects: [{ kind: "environmentReverb", enabled: true }],
          },
        },
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: "sfx",
            soundAttenuationGuid: null,
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    service.setReverbField(
      encodeAudioReverbChunk({
        version: AUDIO_REVERB_VERSION,
        dryFallback: false,
        geometryHash: "h",
        probes: [
          {
            x: 0,
            y: 0,
            z: 0,
            volume: 1,
            openness: 0,
            decay: 0.5,
            damping: 0.5,
            wet: 0.4,
          },
          {
            x: 2,
            y: 0,
            z: 0,
            volume: 1,
            openness: 0,
            decay: 0.5,
            damping: 0.5,
            wet: 0.2,
          },
          {
            x: 40,
            y: 0,
            z: 0,
            volume: 1,
            openness: 1,
            decay: 0.1,
            damping: 0.1,
            wet: 0.9,
          },
        ],
      }),
    );
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
    });
    await service.flush();
    service.syncListener({ x: 0, y: 0, z: 0 });
    expect(backend.plays[0]?.reverbSend).toBe(true);
    expect(service.stats().wet).toBeGreaterThan(0.2);
    expect(service.stats().wet).toBeLessThanOrEqual(0.4);
    expect(backend.wet).toBe(service.stats().wet);
    service.dispose();
  });

  it("scales interpolated reverb wet, decay, and damping from project settings", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        channels: {
          sfx: {
            parentChannelGuid: null,
            effects: [{ kind: "environmentReverb", enabled: true }],
          },
        },
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: "sfx",
            soundAttenuationGuid: null,
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    service.setReverbField(
      encodeAudioReverbChunk({
        version: AUDIO_REVERB_VERSION,
        dryFallback: false,
        geometryHash: "h",
        probes: [
          {
            x: 0,
            y: 0,
            z: 0,
            volume: 1,
            openness: 0,
            decay: 0.4,
            damping: 0.5,
            wet: 0.4,
          },
        ],
      }),
    );
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
    });
    await service.flush();
    service.syncListener({ x: 0, y: 0, z: 0 });
    expect(backend.wet).toBeCloseTo(0.4);
    expect(backend.decay).toBeCloseTo(0.4);
    expect(backend.damping).toBeCloseTo(0.5);
    service.setProjectAudioSettings({
      reverbWetScale: 2,
      reverbDecayScale: 0.5,
      reverbDampingScale: 0,
    });
    expect(backend.wet).toBeCloseTo(0.8);
    expect(backend.decay).toBeCloseTo(0.2);
    expect(backend.damping).toBe(0);
    service.dispose();
  });

  it("stays dry when the baked field is a marked fallback", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        channels: {
          sfx: {
            parentChannelGuid: null,
            effects: [{ kind: "environmentReverb", enabled: true }],
          },
        },
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: "sfx",
            soundAttenuationGuid: null,
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    service.setReverbField(
      encodeAudioReverbChunk({
        version: AUDIO_REVERB_VERSION,
        dryFallback: true,
        geometryHash: "h",
        probes: [],
      }),
    );
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
    });
    await service.flush();
    service.syncListener({ x: 0, y: 0, z: 0 });
    expect(backend.plays[0]?.reverbSend).toBe(true);
    expect(service.stats().wet).toBe(0);
    service.dispose();
  });

  it("muffles spatial voices from occupancy walls and respects the project switch", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        channels: {
          sfx: {
            parentChannelGuid: null,
            effects: [
              { kind: "environmentReverb", enabled: false },
              { kind: "muffleThroughWalls", enabled: true },
            ],
          },
        },
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: "sfx",
            soundAttenuationGuid: "near",
          },
        },
        attenuations: {
          near: {
            innerRadius: 1,
            maxRadius: 50,
            distanceModel: "linear",
            rolloff: 1,
            spatialisation: "equalPower",
            cone: null,
            doppler: null,
          },
        },
      }),
    );
    const bits = new Uint8Array(1);
    bits[0] = 0b0000_0110;
    service.setReverbField(
      encodeAudioReverbChunk({
        version: AUDIO_REVERB_VERSION,
        dryFallback: false,
        geometryHash: "occ",
        probes: [],
        occupancy: {
          originX: 0,
          originY: 0,
          originZ: 0,
          voxelX: 2,
          voxelY: 2,
          voxelZ: 2,
          sizeX: 4,
          sizeY: 1,
          sizeZ: 1,
          bits,
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.noteActorSlot("speaker", 1);
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "v1",
      emitterActorGuid: "speaker",
    });
    await service.flush();
    service.syncSnapshot([{ slotId: 1, position: { x: 1, y: 1, z: 1 } }]);
    service.syncListener({ x: 5, y: 1, z: 1 });
    expect(backend.muffles.get("v1")).toBe(1);
    service.syncListener({ x: 3, y: 1, z: 1 });
    expect(backend.muffles.get("v1")).toBe(0.5);
    service.setProjectAudioSettings({ occlusionEnabled: false });
    service.syncListener({ x: 5, y: 1, z: 1 });
    expect(backend.muffles.get("v1")).toBe(0);
    service.dispose();
  });

  it("leaves channel-less and non-spatial voices unmuffled", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        channels: {
          sfx: {
            parentChannelGuid: null,
            effects: [{ kind: "muffleThroughWalls", enabled: true }],
          },
        },
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: "sfx",
            soundAttenuationGuid: null,
          },
          dry: createDefaultAudioPayload(),
        },
        attenuations: {
          near: {
            innerRadius: 1,
            maxRadius: 50,
            distanceModel: "linear",
            rolloff: 1,
            spatialisation: "equalPower",
            cone: null,
            doppler: null,
          },
        },
      }),
    );
    const bits = new Uint8Array(1);
    bits[0] = 0b0000_0110;
    service.setReverbField(
      encodeAudioReverbChunk({
        version: AUDIO_REVERB_VERSION,
        dryFallback: false,
        geometryHash: "occ",
        probes: [],
        occupancy: {
          originX: 0,
          originY: 0,
          originZ: 0,
          voxelX: 2,
          voxelY: 2,
          voxelZ: 2,
          sizeX: 4,
          sizeY: 1,
          sizeZ: 1,
          bits,
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    service.setSourceBytes("dry", new Uint8Array([1]));
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "channel-nonspatial",
    });
    service.handleCommand({
      type: "playSound",
      assetGuid: "dry",
      volume: 1,
      frameId: 1,
      voiceId: "channel-less",
    });
    await service.flush();
    service.syncListener({ x: 5, y: 1, z: 1 });
    expect(backend.muffles.get("channel-nonspatial")).toBe(0);
    expect(backend.muffles.get("channel-less")).toBe(0);
    service.dispose();
  });

  it("loops when the Audio asset is looping even if playSound omits loop", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        audio: { bed: { ...createDefaultAudioPayload(), loop: true } },
      }),
    );
    service.setSourceBytes("bed", new Uint8Array([1, 2, 3]));
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "bed",
      volume: 1,
      frameId: 1,
    });
    await service.flush();
    expect(backend.plays[0]?.loop).toBe(true);
    service.dispose();
  });

  it("loops a one-shot asset when playSound sets loop", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        audio: { jump: createDefaultAudioPayload() },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1, 2, 3]));
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      loop: true,
    });
    await service.flush();
    expect(backend.plays[0]?.loop).toBe(true);
    service.dispose();
  });

  it("keeps one looping voice across many snapshot follows", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        audio: { bed: { ...createDefaultAudioPayload(), loop: true } },
      }),
    );
    service.setSourceBytes("bed", new Uint8Array([1, 2, 3]));
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "bed",
      volume: 1,
      frameId: 1,
      voiceId: "bed-1",
    });
    await service.flush();
    expect(service.hasSpatialVoices()).toBe(false);
    for (let i = 0; i < 2000; i++) {
      service.syncSnapshot([{ slotId: 0, position: { x: i, y: 0, z: 0 } }]);
      service.syncListener({ x: 0, y: 0, z: 0 });
    }
    expect(backend.plays).toHaveLength(1);
    expect(service.stats().voices).toBe(1);
    expect(backend.poses.size).toBe(0);
    service.dispose();
  });

  it("removes a finished one-shot voice and leaves a looping voice playing", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        audio: {
          jump: createDefaultAudioPayload(),
          bed: { ...createDefaultAudioPayload(), loop: true },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    service.setSourceBytes("bed", new Uint8Array([1]));
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "one-shot",
    });
    service.handleCommand({
      type: "playSound",
      assetGuid: "bed",
      volume: 1,
      frameId: 1,
      voiceId: "looping",
    });
    await service.flush();
    expect(service.stats().voices).toBe(2);
    backend.finish("one-shot");
    backend.finish("looping");
    expect(service.stats().voices).toBe(1);
    service.dispose();
  });

  it("replays the same voiceId without leaking a cache pin", async () => {
    const evicted: string[] = [];
    const cache = new AudioBufferCache({
      byteCeiling: 50,
      onEvict: (guid) => evicted.push(guid),
    });
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend, cache });
    service.setLibrary(
      library({
        audio: { jump: createDefaultAudioPayload() },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array(30));
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "same",
    });
    await service.flush();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 2,
      voiceId: "same",
    });
    await service.flush();
    expect(backend.plays).toHaveLength(2);
    expect(service.stats().voices).toBe(1);
    service.handleCommand({ type: "stopSound", voiceId: "same" });
    await service.flush();
    cache.put("other", new Uint8Array(30), 30);
    expect(evicted.some((guid) => guid.startsWith("jump"))).toBe(true);
    service.dispose();
  });

  it("setPaused does not stop live voices", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(library({ audio: { jump: createDefaultAudioPayload() } }));
    service.setSourceBytes("jump", new Uint8Array([1, 2, 3]));
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "looping",
    });
    await service.flush();
    expect(backend.plays).toHaveLength(1);
    service.setPaused(true);
    expect(backend.stopped).toEqual([]);
    expect(backend.paused).toBe(true);
    expect(service.stats().voices).toBe(1);
    service.setPaused(false);
    expect(backend.paused).toBe(false);
    expect(backend.stopped).toEqual([]);
    service.dispose();
  });

  it("gates debug voice snapshots behind setShowAudioDebug", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        audio: {
          jump: {
            ...createDefaultAudioPayload(),
            clips: [{ chunkId: "source", name: "Jump", weight: 1 }],
            loop: true,
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "v1",
    });
    await service.flush();
    expect(service.stats().debugVoices).toBeUndefined();
    service.setShowAudioDebug(true);
    expect(service.stats().debugVoices).toEqual([
      expect.objectContaining({
        assetGuid: "jump",
        clipName: "Jump",
        loop: true,
        spatial: false,
        insideRadius: null,
      }),
    ]);
    service.setShowAudioDebug(false);
    expect(service.stats().debugVoices).toBeUndefined();
    service.dispose();
  });

  it("marks spatial voices inside maxRadius when pose is known", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        audio: {
          jump: {
            volume: 1,
            audioChannelGuid: null,
            soundAttenuationGuid: "near",
            clips: [{ chunkId: "source", name: "Jump", weight: 1 }],
          },
        },
        attenuations: {
          near: {
            innerRadius: 1,
            maxRadius: 50,
            distanceModel: "linear",
            rolloff: 1,
            spatialisation: "equalPower",
            cone: null,
            doppler: null,
          },
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.noteActorSlot("speaker", 1);
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "v1",
      emitterActorGuid: "speaker",
    });
    await service.flush();
    service.setShowAudioDebug(true);
    service.syncListener({ x: 0, y: 0, z: 0 });
    service.syncSnapshot([{ slotId: 1, position: { x: 10, y: 0, z: 0 } }]);
    expect(service.stats().debugVoices?.[0]).toMatchObject({
      spatial: true,
      distance: 10,
      innerRadius: 1,
      maxRadius: 50,
      insideRadius: true,
    });
    service.syncSnapshot([{ slotId: 1, position: { x: 80, y: 0, z: 0 } }]);
    expect(service.stats().debugVoices?.[0]).toMatchObject({
      distance: 80,
      insideRadius: false,
    });
    service.dispose();
  });
});
