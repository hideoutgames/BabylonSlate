import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_MAX_CONCURRENT_VOICES,
  AUDIO_PRE_UNLOCK_QUEUE_CAP,
  AUDIO_SPEED_OF_SOUND,
  audioClipCacheKey,
  createDefaultAudioPayload,
  encodeAudioReverbChunk,
  normalizeAudioPayload,
  soundAttenuationLibraryEntry,
  type AudioChannelPayload,
  type AudioMixerPayload,
  type SoundAttenuationPayload,
} from "@haptic/assets";
import { createActor, createDefaultSceneSettings, type Curve } from "@haptic/core";
import { createInProcessRuntime } from "@haptic/runtime";
import { AudioBufferCache } from "./audio-buffer-cache";
import { FakeAudioPlaybackBackend, type AudioPose } from "./audio-playback-backend";
import { AudioService } from "./audio-service";

function library(options?: {
  mixer?: AudioMixerPayload | null;
  mixerGuid?: string | null;
  channels?: Record<string, AudioChannelPayload>;
  audio?: Record<string, unknown>;
  attenuations?: Record<string, Partial<SoundAttenuationPayload>>;
  /** Float Curve assets by guid, for Custom falloffs. */
  curves?: Record<string, Curve<number>>;
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
    attenuations: new Map(Object.entries(options?.attenuations ?? {}).map(([guid, payload]) => [
      guid,
      soundAttenuationLibraryEntry(payload, (curveGuid) => {
        const curve = options?.curves?.[curveGuid];
        return curve ? { curve } : undefined;
      }),
    ])),
  };
}

/** A Float Curve from (time, value) pairs joined by straight lines, held flat past its ends. */
function linearCurve(...points: Array<[number, number]>): Curve<number> {
  return {
    Keys: points.map(([Time, Value]) => ({ Time, Value, Interpolation: "linear" as const, ArriveTangent: 0, LeaveTangent: 0 })),
    Before: "constant",
    After: "constant",
  };
}

describe("AudioService", () => {
  it("holds and releases a voice for a game pause after the voice it names has started", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend, loadSourceBytes: async () => new Uint8Array([1, 2, 3]) });
    try {
      service.setLibrary(library({ audio: { music: createDefaultAudioPayload() } }), true);
      await service.unlockAsync();
      service.handleCommand({ type: "playSound", assetGuid: "music", voiceId: "music-voice", volume: 1, frameId: 1 });
      service.handleCommand({ type: "setVoicePaused", voiceId: "music-voice", paused: true });
      await service.flush();
      expect(backend.plays.map((play) => play.voiceId)).toEqual(["music-voice"]);
      expect([...backend.pausedVoices]).toEqual(["music-voice"]);
      service.handleCommand({ type: "setVoicePaused", voiceId: "music-voice", paused: false });
      await service.flush();
      expect([...backend.pausedVoices]).toEqual([]);
    } finally { service.dispose(); }
  });

  it("prepares ordinary cold Audio before playback and releases its scope when the voice ends", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const release = vi.fn();
    const service = new AudioService({ backend,
      prepareAsset: async (guid) => {
        service.setLibrary(library({ audio: { [guid]: { ...createDefaultAudioPayload(), volume: 0.25 } } }), true);
        return release;
      },
      loadSourceBytes: async () => new Uint8Array([1, 2, 3]),
    });
    try {
      await service.unlockAsync();
      service.handleCommand({ type: "playSound", assetGuid: "cold", voiceId: "voice", volume: 1, frameId: 1 });
      await service.flush();
      expect(backend.plays[0]?.gain).toBe(0.25);
      expect(release).not.toHaveBeenCalled();
      backend.finish("voice");
      expect(release).toHaveBeenCalledOnce();
    } finally { service.dispose(); }
  });

  it("keeps old live audio valid while a revised source decodes under a distinct key", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const revisions: Array<string | undefined> = [];
    const service = new AudioService({ backend, loadSourceBytes: async ({ revision }) => {
      revisions.push(revision);
      return new Uint8Array([revision === "old" ? 1 : 2]);
    } });
    const content = library({ audio: { clip: createDefaultAudioPayload() } });
    try {
      service.setLibrary({ ...content, sourceRevisions: new Map([["clip", "old"]]) });
      await service.unlockAsync();
      service.handleCommand({ type: "playSound", assetGuid: "clip", voiceId: "first", volume: 1, frameId: 1 });
      await service.flush();
      const oldKey = backend.plays[0]!.cacheKey!;
      service.setLibrary({ ...content, sourceRevisions: new Map([["clip", "new"]]) }, true);
      expect(backend.disposedBuffers).not.toContain(oldKey);
      service.handleCommand({ type: "playSound", assetGuid: "clip", voiceId: "second", volume: 1, frameId: 2 });
      await service.flush();
      expect(revisions).toEqual(["old", "new"]);
      expect(backend.plays[1]!.cacheKey).not.toBe(oldKey);
      expect(backend.plays.map((play) => [...play.source])).toEqual([[1], [2]]);
      service.handleCommand({ type: "stopSound", voiceId: "first" });
      await service.flush();
      expect(backend.disposedBuffers).toContain(oldKey);
      expect(service.stats().voices).toBe(1);
    } finally { service.dispose(); }
  });

  it("shares preload decoding, pins live buffers, and removes decoded audio when its final source is released", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const decode = vi.spyOn(backend, "decode");
    const cache = new AudioBufferCache();
    const service = new AudioService({ backend, cache, loadSourceBytes: async () => new Uint8Array([1, 2, 3, 4]) });
    service.setLibrary(library({ audio: { clip: createDefaultAudioPayload() } }));
    try {
      const [left, right] = await Promise.all([service.preload(["clip"]), service.preload(["clip"])]);
      expect(decode).toHaveBeenCalledOnce();
      expect(backend.plays).toEqual([]);
      left();
      cache.flushUnreferenced();
      expect(cache.accountedBytes()).toBeGreaterThan(0);
      right();
      service.setLibrary(library(), true);
      expect(cache.accountedBytes()).toBe(0);
      expect(backend.disposedBuffers).toContain(audioClipCacheKey("clip", "source"));
    } finally { service.dispose(); }
  });

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

  it("loads an alternate weighted clip after the default clip was cached", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const reads: string[] = [];
    const choices = [0, 0.99];
    const service = new AudioService({
      backend,
      random: () => choices.shift() ?? 0.99,
      loadSourceBytes: async ({ assetGuid, chunkId }) => {
        reads.push(`${assetGuid}:${chunkId}`);
        return new Uint8Array(chunkId === "source" ? [1] : [2]);
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
    service.handleCommand({ type: "playSound", assetGuid: "jump", volume: 1, frameId: 2 });
    await service.flush();
    expect(reads).toEqual(["jump:source", "jump:source:2"]);
    expect(backend.plays.map((play) => [...play.source])).toEqual([[1], [2]]);
    service.dispose();
  });

  it.each(["load", "decode"] as const)("drops old-scene audio pending in %s and queued behind it", async (stage) => {
    const backend = new FakeAudioPlaybackBackend();
    let resolve!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    const pending = new Promise<void>((done) => { resolve = done; });
    if (stage === "decode") vi.spyOn(backend, "decode").mockImplementationOnce(async () => {
      entered();
      await pending;
      return { pcmBytes: 4 };
    });
    const service = new AudioService({
      backend,
      loadSourceBytes: async () => {
        if (stage === "load") { entered(); await pending; }
        return new Uint8Array([1]);
      },
    });
    service.setLibrary(library({ audio: { jump: createDefaultAudioPayload() } }));
    await service.unlockAsync();
    service.handleCommand({ type: "playSound", assetGuid: "jump", volume: 1, frameId: 1, voiceId: "loading" });
    service.handleCommand({ type: "playSound", assetGuid: "jump", volume: 1, frameId: 1, voiceId: "queued" });
    await started;
    service.resetSession();
    service.handleCommand({ type: "playSound", assetGuid: "jump", volume: 1, frameId: 2, voiceId: "new-scene" });
    resolve();
    await service.flush();
    expect(backend.plays.map((play) => play.voiceId)).toEqual(["new-scene"]);
    expect(service.stats().voices).toBe(1);
    service.dispose();
  });

  it("does not recreate audio resources when source loading finishes after disposal", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const cache = new AudioBufferCache();
    let resolve!: (bytes: Uint8Array) => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    const service = new AudioService({ backend, cache, loadSourceBytes: () => {
      entered();
      return new Promise<Uint8Array>((done) => { resolve = done; });
    } });
    await service.unlockAsync();
    service.handleCommand({ type: "playSound", assetGuid: "jump", volume: 1, frameId: 1 });
    await started;
    service.dispose();
    resolve(new Uint8Array([1]));
    await service.flush();
    expect(backend.plays).toEqual([]);
    expect(cache.accountedBytes()).toBe(0);
    expect(service.stats().voices).toBe(0);
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

  it("stops hearing a shared cache's evictions once disposed", async () => {
    const cache = new AudioBufferCache({ byteCeiling: 50 });
    const earlier = new FakeAudioPlaybackBackend();
    new AudioService({ backend: earlier, cache }).dispose();
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend, cache });
    service.setLibrary(library({ audio: { a: createDefaultAudioPayload(), b: createDefaultAudioPayload() } }));
    service.setSourceBytes("a", new Uint8Array(30));
    service.setSourceBytes("b", new Uint8Array(30));
    await service.unlockAsync();
    service.handleCommand({ type: "playSound", assetGuid: "a", volume: 1, frameId: 1, voiceId: "va" });
    await service.flush();
    service.handleCommand({ type: "stopSound", voiceId: "va" });
    await service.flush();
    service.handleCommand({ type: "playSound", assetGuid: "b", volume: 1, frameId: 2, voiceId: "vb" });
    await service.flush();
    // The live session releases the evicted clip; the disposed one is no longer reachable from the cache.
    expect(backend.disposedBuffers).toContain(audioClipCacheKey("a", "source"));
    expect(earlier.disposedBuffers).toEqual([]);
    service.dispose();
  });

  it("disposes the backend buffer when LRU evicts an unpinned clip", async () => {
    const cache = new AudioBufferCache({ byteCeiling: 50 });
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend, cache });
    service.setLibrary(
      library({
        audio: {
          a: createDefaultAudioPayload(),
          b: createDefaultAudioPayload(),
        },
      }),
    );
    service.setSourceBytes("a", new Uint8Array(30));
    service.setSourceBytes("b", new Uint8Array(30));
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "a",
      volume: 1,
      frameId: 1,
      voiceId: "va",
    });
    await service.flush();
    service.handleCommand({ type: "stopSound", voiceId: "va" });
    await service.flush();
    service.handleCommand({
      type: "playSound",
      assetGuid: "b",
      volume: 1,
      frameId: 2,
      voiceId: "vb",
    });
    await service.flush();
    expect(backend.disposedBuffers).toContain(audioClipCacheKey("a", "source"));
    expect(cache.get(audioClipCacheKey("a", "source"))).toBeUndefined();
    service.dispose();
  });

  it("steals the oldest voice when over maxVoices and trims on setMaxVoices", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend, maxVoices: 2 });
    service.setLibrary(
      library({
        audio: {
          a: createDefaultAudioPayload(),
          b: createDefaultAudioPayload(),
          c: createDefaultAudioPayload(),
        },
      }),
    );
    service.setSourceBytes("a", new Uint8Array(8));
    service.setSourceBytes("b", new Uint8Array(8));
    service.setSourceBytes("c", new Uint8Array(8));
    await service.unlockAsync();
    for (const [guid, voiceId] of [
      ["a", "v1"],
      ["b", "v2"],
      ["c", "v3"],
    ] as const) {
      service.handleCommand({
        type: "playSound",
        assetGuid: guid,
        volume: 1,
        frameId: 1,
        voiceId,
      });
      await service.flush();
    }
    expect(service.stats().voices).toBe(2);
    expect(backend.stopped).toContain("v1");
    service.setMaxVoices(1);
    expect(service.stats().voices).toBe(1);
    service.dispose();
  });

  describe("at the voice cap", () => {
    /** The voices the backend is playing, in start order. */
    class LiveBackend extends FakeAudioPlaybackBackend {
      readonly live = new Set<string>();
      override async play(request: Parameters<FakeAudioPlaybackBackend["play"]>[0]): Promise<void> {
        this.live.add(request.voiceId);
        await super.play(request);
      }
      override stop(voiceId: string): void {
        this.live.delete(voiceId);
        super.stop(voiceId);
      }
    }

    /** Music (quiet, non-spatial, looping) and Linear 2..20 spatial sounds, started at fixed places around a listener at the origin. */
    async function capped(maxVoices: number) {
      const backend = new LiveBackend();
      const ended: Array<[string, boolean | undefined]> = [];
      const evicted: string[] = [];
      const cache = new AudioBufferCache({ byteCeiling: 40, onEvict: (key) => evicted.push(key) });
      const service = new AudioService({
        backend, cache, maxVoices, onVoiceEnded: (voiceId, dropped) => ended.push([voiceId, dropped]),
      });
      service.setLibrary(library({
        audio: {
          music: { ...createDefaultAudioPayload(), volume: 0.2, loop: true },
          ui: { ...createDefaultAudioPayload(), volume: 0.2 },
          ambience: { ...createDefaultAudioPayload(), loop: true, soundAttenuationGuid: "room" },
          shot: { ...createDefaultAudioPayload(), soundAttenuationGuid: "room" },
        },
        attenuations: {
          room: { innerRadius: 2, maxRadius: 20, falloff: "linear", falloffCurveGuid: null, spatialisation: "equalPower", cone: null, doppler: null },
        },
      }));
      for (const guid of ["music", "ui", "ambience"]) service.setSourceBytes(guid, new Uint8Array([1]));
      service.setSourceBytes("shot", new Uint8Array(30));
      await service.unlockAsync();
      service.syncListener({ x: 0, y: 0, z: 0 });
      const play = async (assetGuid: string, voiceId: string, x?: number) => {
        service.handleCommand({
          type: "playSound", assetGuid, volume: 1, frameId: 1, voiceId, ...(x === undefined ? {} : { location: { x, y: 0, z: 0 } }),
        });
        await service.flush();
      };
      const playing = () => service.stats().debugVoices?.map((voice) => voice.assetGuid);
      service.setShowAudioDebug(true);
      return { backend, cache, evicted, service, ended, play, live: () => backend.live, playing };
    }

    it("cuts the least audible spatial voice and keeps the music that started first", async () => {
      const { backend, service, ended, play, live } = await capped(3);
      await play("music", "music");
      await play("ambience", "beyond", 25); // past Max Radius: silent
      await play("ambience", "mid", 11); // 0.5
      await play("ambience", "near", 1); // 1, over the cap
      expect([...live().keys()]).toEqual(["music", "mid", "near"]);
      expect(ended).toEqual([["beyond", true]]);
      expect(backend.stopped).toEqual(["beyond"]);
      // Lowering the cap ranks the same way, at the listener's current place: moving to x = 11 makes "near" the quieter.
      service.syncListener({ x: 11, y: 0, z: 0 });
      service.setMaxVoices(2);
      expect([...live().keys()]).toEqual(["music", "mid"]);
      service.setMaxVoices(1);
      expect([...live().keys()]).toEqual(["music"]);
      expect(ended.map(([voiceId]) => voiceId)).toEqual(["beyond", "near", "mid"]);
      service.dispose();
    });

    it("drops an incoming sound that is the least audible, reporting it once as dropped", async () => {
      const { backend, cache, evicted, service, ended, play, live } = await capped(2);
      await play("music", "music");
      await play("ambience", "near", 1);
      await play("shot", "far shot", 19);
      expect(backend.plays.map((request) => request.voiceId)).toEqual(["music", "near"]);
      expect([...live().keys()]).toEqual(["music", "near"]);
      expect(ended).toEqual([["far shot", true]]);
      expect(service.stats().voices).toBe(2);
      // It released its clip: the next clip over the budget evicts it.
      cache.put("other", new Uint8Array(30), 30);
      expect(evicted).toEqual([audioClipCacheKey("shot", "source")]);
      // With room, the same sound plays.
      service.setMaxVoices(3);
      await play("shot", "far shot", 19);
      expect([...live().keys()]).toEqual(["music", "near", "far shot"]);
      service.dispose();
    });

    it("breaks ties by keeping looping voices, then the newest, and cuts spatial before non-spatial", async () => {
      const { service, ended, play, playing } = await capped(3);
      // Equally loud: the one-shot goes before the older loop.
      await play("ambience", "loop", 1);
      await play("shot", "one-shot", 1);
      await play("ambience", "loop 2", 1);
      await play("ambience", "loop 3", 1);
      expect(ended).toEqual([["one-shot", true]]);
      // Equally loud loops: the oldest goes, so the incoming one plays.
      await play("ambience", "loop 4", 1);
      expect(ended.at(-1)).toEqual(["loop", true]);
      // Quiet UI sound against full-volume spatial loops: the spatial loops go first.
      await play("ui", "click");
      expect(playing()).toEqual(["ambience", "ambience", "ui"]);
      expect(ended.at(-1)).toEqual(["loop 2", true]);
      service.dispose();
    });
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
            falloff: "linear",
            falloffCurveGuid: null,
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

  it("places a Play Sound At Location voice at its fixed position, whatever its emitter does", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const diagnostics: Array<{ code: string }> = [];
    const service = new AudioService({ backend, onDiagnostic: (entry) => diagnostics.push(entry) });
    service.setLibrary(library({
      audio: { jump: { ...createDefaultAudioPayload(), soundAttenuationGuid: "near" } },
      attenuations: { near: { innerRadius: 1, maxRadius: 10, falloff: "linear", falloffCurveGuid: null, spatialisation: "equalPower", cone: null, doppler: null } },
    }));
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.noteActorSlot("speaker", 1);
    service.handleCommand({ type: "playSound", assetGuid: "jump", volume: 1, frameId: 1, voiceId: "here", location: { x: 4, y: 5, z: 6 } });
    service.handleCommand({ type: "playSound", assetGuid: "jump", volume: 1, frameId: 1, voiceId: "there", emitterActorGuid: "speaker", location: { x: -1, y: 0, z: 0 } });
    await service.flush();
    service.syncSnapshot([{ slotId: 1, position: { x: 9, y: 9, z: 9 } }]);
    expect(backend.plays.map((play) => play.spatial?.enabled)).toEqual([true, true]);
    expect(backend.poses.get("here")).toEqual({ x: 4, y: 5, z: 6 });
    expect(backend.poses.get("there")).toEqual({ x: -1, y: 0, z: 0 });
    // A located voice needs no emitter, so nothing is reported missing and no actor is posed for it.
    expect(diagnostics).toEqual([]);
    expect([...service.collectEmitterSlots(new Set())]).toEqual([]);
    service.dispose();
  });

  it("multiplies the authored pitch by the play call's and Set Sound Pitch's multiplier", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(library({ audio: { jump: { ...createDefaultAudioPayload(), pitch: 2 } } }));
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.handleCommand({ type: "playSound", assetGuid: "jump", volume: 1, frameId: 1, voiceId: "v1", pitch: 1.5 });
    await service.flush();
    expect(backend.playbackRates.get("v1")).toBeCloseTo(3, 9);
    service.handleCommand({ type: "setVoicePitch", voiceId: "v1", pitch: 0.5 });
    await service.flush();
    expect(backend.playbackRates.get("v1")).toBeCloseTo(1, 9);
    // The multiplier is held to 0.25..4 like an Audio asset's own pitch.
    service.handleCommand({ type: "setVoicePitch", voiceId: "v1", pitch: 100 });
    await service.flush();
    expect(backend.playbackRates.get("v1")).toBeCloseTo(8, 9);
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
            falloff: "linear",
            falloffCurveGuid: null,
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

  it("applies the Sound Attenuation curve as each spatial voice's distance gain, silent beyond Max Radius", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    const attenuation = (falloff: SoundAttenuationPayload["falloff"], falloffCurveGuid: string | null = null) => ({
      innerRadius: 2, maxRadius: 20, falloff, falloffCurveGuid,
    });
    service.setLibrary(library({
      audio: {
        lin: { ...createDefaultAudioPayload(), volume: 0.5, soundAttenuationGuid: "lin" },
        nat: { ...createDefaultAudioPayload(), soundAttenuationGuid: "nat" },
        cus: { ...createDefaultAudioPayload(), soundAttenuationGuid: "cus" },
        bed: createDefaultAudioPayload(),
      },
      attenuations: { lin: attenuation("linear"), nat: attenuation("natural"), cus: attenuation("custom", "curve-1") },
      // Starts below full volume and ends above silence: steps at both radii.
      curves: { "curve-1": linearCurve([0, 0.8], [1, 0.4]) },
    }));
    for (const guid of ["lin", "nat", "cus", "bed"]) service.setSourceBytes(guid, new Uint8Array([1]));
    await service.unlockAsync();
    service.syncListener({ x: 0, y: 0, z: 0 });
    for (const [guid, slotId] of [["lin", 1], ["nat", 2], ["cus", 3]] as const) {
      service.noteActorSlot(guid, slotId);
      service.handleCommand({ type: "playSound", assetGuid: guid, volume: 1, frameId: 1, voiceId: guid, emitterActorGuid: guid });
    }
    service.handleCommand({ type: "playSound", assetGuid: "bed", volume: 1, frameId: 1, voiceId: "bed" });
    // A located voice starts at the gain of its place: past Max Radius, silent from its first sample.
    service.handleCommand({ type: "playSound", assetGuid: "cus", volume: 1, frameId: 1, voiceId: "far", location: { x: 0, y: 0, z: 25 } });
    await service.flush();
    expect(backend.plays.find((play) => play.voiceId === "far")?.attenuation).toBe(0);
    expect(backend.plays.find((play) => play.voiceId === "bed")?.attenuation).toBeUndefined();

    const heardAt = (distance: number) => {
      service.syncSnapshot([1, 2, 3].map((slotId) => ({ slotId, position: { x: distance, y: 0, z: 0 } })));
      return ["lin", "nat", "cus"].map((voiceId) => backend.attenuations.get(voiceId));
    };
    // Hand-derived: t = (d - 2) / 18; Linear 1 - t; Natural (1 - t)³ (1 + 3t), whose keys follow it within 0.001
    // between them; the custom curve 0.8 - 0.4t.
    const near = (values: number[]) => values.map((value) => expect.closeTo(value, 6));
    expect(heardAt(1)).toEqual([1, 1, 1]);
    expect(heardAt(2)).toEqual([1, 1, 1]);
    expect(heardAt(2.0001)).toEqual(near([0.999994, 1, 0.799998]));
    expect(heardAt(11)).toEqual(near([0.5, 0.3125, 0.6]));
    expect(heardAt(20)).toEqual(near([0, 0, 0.4]));
    expect(heardAt(20.0001)).toEqual([0, 0, 0]);
    expect(heardAt(30)).toEqual([0, 0, 0]);
    // The listener moving between snapshots changes the gain too; the voice's own gain path is left alone.
    service.syncListener({ x: 21, y: 0, z: 0 });
    expect(heardAt(30)).toEqual([expect.closeTo(0.611111, 6), expect.closeTo(0.494486, 2), expect.closeTo(0.644444, 6)]);
    expect(backend.gains.size).toBe(0);
    expect(backend.attenuations.has("bed")).toBe(false);
    service.setShowAudioDebug(true);
    expect(service.stats().debugVoices?.map((voice) => [voice.attenuation, voice.insideRadius])).toEqual([
      [expect.closeTo(0.611111, 6), true], [expect.closeTo(0.494486, 2), true], [expect.closeTo(0.644444, 6), true],
      [null, null], [0, false],
    ]);
    service.dispose();
  });

  it("falls a Custom attenuation without its curve back to Natural and reports it like a missing attenuation", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const diagnostics: Array<{ code: string; assetGuid?: string }> = [];
    const service = new AudioService({ backend, onDiagnostic: (entry) => diagnostics.push(entry) });
    service.setLibrary(library({
      audio: {
        gone: { ...createDefaultAudioPayload(), soundAttenuationGuid: "gone-curve" },
        lost: { ...createDefaultAudioPayload(), soundAttenuationGuid: "missing-attenuation" },
      },
      attenuations: { "gone-curve": { innerRadius: 2, maxRadius: 20, falloff: "custom", falloffCurveGuid: "deleted" } },
    }));
    expect(diagnostics.map((entry) => [entry.code, entry.assetGuid])).toEqual([
      ["audio.missing_attenuation", "missing-attenuation"],
      ["audio.missing_falloff_curve", "gone-curve"],
    ]);
    service.setSourceBytes("gone", new Uint8Array([1]));
    await service.unlockAsync();
    service.syncListener({ x: 0, y: 0, z: 0 });
    service.handleCommand({ type: "playSound", assetGuid: "gone", volume: 1, frameId: 1, voiceId: "v", location: { x: 11, y: 0, z: 0 } });
    await service.flush();
    // Natural at t = 0.5: (1 - 0.5)³ (1 + 1.5).
    expect(backend.attenuations.get("v")).toBeCloseTo(0.3125, 6);
    service.dispose();
  });

  it("re-resolves live voices' attenuation, panner and gain when the library is replaced", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const clock = { now: 0 };
    const service = new AudioService({ backend, now: () => clock.now });
    const audio = {
      shot: { ...createDefaultAudioPayload(), soundAttenuationGuid: "room" },
      music: createDefaultAudioPayload(),
    };
    service.setLibrary(library({
      audio,
      attenuations: { room: { innerRadius: 2, maxRadius: 20, falloff: "linear", doppler: { enabled: true, factor: 1 } } },
    }));
    for (const guid of ["shot", "music"]) service.setSourceBytes(guid, new Uint8Array([1]));
    await service.unlockAsync();
    service.syncListener({ x: 0, y: 0, z: 0 });
    service.noteActorSlot("speaker", 1);
    service.syncSnapshot([{ slotId: 1, position: { x: 12, y: 0, z: 0 } }]);
    service.handleCommand({ type: "playSound", assetGuid: "shot", volume: 1, frameId: 1, voiceId: "v", emitterActorGuid: "speaker" });
    service.handleCommand({ type: "playSound", assetGuid: "music", volume: 1, frameId: 1, voiceId: "m" });
    service.handleCommand({ type: "setVoicePitch", voiceId: "v", pitch: 1.5 });
    await service.flush();
    // Approaching the listener: Doppler raises the rate above the voice's pitch.
    service.syncSnapshot([{ slotId: 1, position: { x: 12, y: 0, z: 0 } }]);
    clock.now = 100;
    service.syncSnapshot([{ slotId: 1, position: { x: 11, y: 0, z: 0 } }]);
    expect(backend.attenuations.get("v")).toBeCloseTo(0.5, 6);
    expect(backend.playbackRates.get("v")).toBeGreaterThan(1.5);

    // The edit: a custom curve, a wider Max Radius, a cone, HRTF and no Doppler; the Audio is quieter.
    service.setLibrary(library({
      audio: { ...audio, shot: { ...audio.shot, volume: 0.5 } },
      attenuations: {
        room: {
          innerRadius: 2, maxRadius: 38, falloff: "custom", falloffCurveGuid: "c", spatialisation: "hrtf",
          cone: { innerAngle: 90, outerAngle: 180, outerGain: 0.25 }, doppler: null,
        },
      },
      curves: { c: linearCurve([0, 0.9], [1, 0.1]) },
    }), true);
    // t = (11 - 2) / 36 = 0.25 on 0.9 - 0.8t.
    expect(backend.attenuations.get("v")).toBeCloseTo(0.7, 6);
    expect(backend.gains.get("v")).toBe(0.5);
    expect(backend.spatialUpdates.get("v")).toMatchObject({
      spatialisation: "hrtf", cone: { innerAngle: 90, outerAngle: 180, outerGain: 0.25 }, maxRadius: 38,
    });
    expect(backend.playbackRates.get("v")).toBeCloseTo(1.5, 9);
    // A non-spatial voice stays non-spatial.
    expect(backend.spatialUpdates.has("m")).toBe(false);
    expect(backend.attenuations.has("m")).toBe(false);
    service.dispose();
  });

  it("keeps spatial voices silent until the first listener pose, then gives them their gain without a full-volume frame", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(library({
      audio: { shot: { ...createDefaultAudioPayload(), soundAttenuationGuid: "room" } },
      attenuations: { room: { innerRadius: 2, maxRadius: 20, falloff: "linear" } },
    }));
    service.setSourceBytes("shot", new Uint8Array([1]));
    await service.unlockAsync();
    expect(service.hasListener()).toBe(false);
    // At the origin the placeholder listener would give full volume.
    service.handleCommand({ type: "playSound", assetGuid: "shot", volume: 1, frameId: 1, voiceId: "v", location: { x: 0, y: 0, z: 0 } });
    await service.flush();
    expect(backend.plays[0]?.attenuation).toBe(0);
    expect(backend.plays[0]?.pose).toEqual({ x: 0, y: 0, z: 0 });
    service.syncListener({ x: 11, y: 0, z: 0 });
    expect(service.hasListener()).toBe(true);
    expect(backend.attenuationHistory.get("v")).toEqual([0, 0.5]);
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
            falloff: "linear",
            falloffCurveGuid: null,
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
            falloff: "linear",
            falloffCurveGuid: null,
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
    // An emitter that leaves the snapshot holds still: pitch returns to authored.
    now = 200;
    service.syncSnapshot([]);
    expect(backend.playbackRates.get("v1")).toBe(1);
    // Its return is not read as motion from the pose before the gap.
    now = 300;
    service.syncSnapshot([{ slotId: 1, position: { x: 40, y: 0, z: 0 } }]);
    expect(backend.playbackRates.get("v1")).toBe(1);
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
            falloff: "linear",
            falloffCurveGuid: null,
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
            falloff: "linear",
            falloffCurveGuid: null,
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
            falloff: "linear",
            falloffCurveGuid: null,
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
    for (let i = 0; i < 50; i++) {
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
      byteCeiling: 40,
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
    expect(backend.disposedBuffers).toEqual([]);
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
            falloff: "linear",
            falloffCurveGuid: null,
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

  it("setVoiceGain updates play-call volume on a live voice", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        audio: { jump: { ...createDefaultAudioPayload(), volume: 1 } },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1, 2, 3, 4]));
    await service.unlockAsync();
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
      voiceId: "audio-1",
    });
    await service.flush();
    service.handleCommand({
      type: "setVoiceGain",
      voiceId: "audio-1",
      volume: 0.25,
    });
    await service.flush();
    expect(backend.gains.get("audio-1")).toBe(0.25);
    service.dispose();
  });

  it("reports a named voice that never starts, or is stolen at the voice cap, as dropped", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const ended: Array<[string, boolean | undefined]> = [];
    const service = new AudioService({ backend, maxVoices: 1, onVoiceEnded: (voiceId, dropped) => ended.push([voiceId, dropped]) });
    service.setLibrary(library({ audio: { bed: { ...createDefaultAudioPayload(), loop: true }, silent: createDefaultAudioPayload() } }));
    service.setSourceBytes("bed", new Uint8Array([1]));
    await service.unlockAsync();
    const play = (assetGuid: string, voiceId: string) => service.handleCommand({ type: "playSound", assetGuid, volume: 1, frameId: 1, voiceId });

    // No source bytes: the voice never plays.
    play("silent", "missing");
    await service.flush();
    expect(ended).toEqual([["missing", true]]);

    // A second voice over the cap of one steals the first.
    play("bed", "first");
    play("bed", "second");
    await service.flush();
    expect(ended).toEqual([["missing", true], ["first", true]]);
  });

  it("does not report a voice as dropped while a later play of it still waits", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const ended: string[] = [];
    const service = new AudioService({ backend, onVoiceEnded: (voiceId) => ended.push(voiceId) });
    service.setLibrary(library({ audio: { bed: { ...createDefaultAudioPayload(), loop: true }, silent: createDefaultAudioPayload() } }));
    service.setSourceBytes("bed", new Uint8Array([1]));
    await service.unlockAsync();

    service.handleCommand({ type: "playSound", assetGuid: "silent", volume: 1, frameId: 1, voiceId: "music" });
    service.handleCommand({ type: "playSound", assetGuid: "bed", volume: 1, frameId: 2, voiceId: "music" });
    await service.flush();

    expect(ended).toEqual([]);
    expect(service.stats().voices).toBe(1);
  });

  it("notifies onVoiceEnded for finished non-looping voices", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const ended: string[] = [];
    const service = new AudioService({
      backend,
      onVoiceEnded: (voiceId) => ended.push(voiceId),
    });
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
      loop: true,
    });
    await service.flush();
    backend.finish("one-shot");
    backend.finish("looping");
    expect(ended).toEqual(["one-shot"]);
    service.dispose();
  });
});

/** Counts the per-voice writes one applied snapshot costs the backend. */
class CountingBackend extends FakeAudioPlaybackBackend {
  poseWrites = 0;
  muffleWrites = 0;

  override setVoicePose(voiceId: string, pose: AudioPose): boolean {
    this.poseWrites += 1;
    return super.setVoicePose(voiceId, { ...pose });
  }

  override setVoiceMuffle(voiceId: string, factor: number): boolean {
    this.muffleWrites += 1;
    return super.setVoiceMuffle(voiceId, factor);
  }
}

describe("AudioService spatial refresh per applied snapshot", () => {
  /**
   * One Doppler emitter behind a wall grid: voxels are 2 units wide along x and
   * the 2nd and 3rd are occupied, so a listener at x=3 hears one wall (0.5),
   * x=5 hears two (1) and x<2 hears none.
   */
  async function dopplerEmitter(backend: FakeAudioPlaybackBackend, clock: { now: number }) {
    const service = new AudioService({ backend, now: () => clock.now });
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
        audio: { jump: { volume: 1, audioChannelGuid: "sfx", soundAttenuationGuid: "near" } },
        attenuations: {
          near: {
            innerRadius: 1,
            maxRadius: 50,
            falloff: "linear",
            falloffCurveGuid: null,
            spatialisation: "equalPower",
            cone: null,
            doppler: { enabled: true, factor: 1 },
          },
        },
      }),
    );
    const bits = new Uint8Array(1);
    bits[0] = 0b0000_0110;
    service.setReverbField(
      encodeAudioReverbChunk({
        dryFallback: false,
        geometryHash: "occ",
        probes: [],
        occupancy: {
          originX: 0, originY: 0, originZ: 0,
          voxelX: 2, voxelY: 2, voxelZ: 2,
          sizeX: 4, sizeY: 1, sizeZ: 1,
          bits,
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    await service.unlockAsync();
    service.noteActorSlot("speaker", 1);
    service.handleCommand({
      type: "playSound", assetGuid: "jump", volume: 1, frameId: 1,
      voiceId: "v1", emitterActorGuid: "speaker",
    });
    await service.flush();
    service.syncListener({ x: 5, y: 1, z: 1 });
    return service;
  }

  // Each frame moves the emitter along x inside the wall-free first voxel and
  // moves the listener across it, so Doppler (previous listener) and muffle
  // (incoming listener) disagree about which side the listener is on.
  const frames: Array<{ at: number; emitterX: number; listener: { x: number; y: number; z: number } | null }> = [
    { at: 0, emitterX: 1.0, listener: { x: 5, y: 1, z: 1 } },
    { at: 100, emitterX: 1.5, listener: { x: 0.25, y: 1, z: 1 } },
    { at: 200, emitterX: 1.9, listener: { x: 5, y: 1, z: 1 } },
    // Game time paused: the snapshot still applies, the listener does not move.
    { at: 300, emitterX: 1.4, listener: null },
  ];

  const observe = (backend: CountingBackend, service: AudioService) => ({
    rate: backend.playbackRates.get("v1"),
    muffle: backend.muffles.get("v1"),
    pose: backend.poses.get("v1")?.x,
    listener: backend.listener.x,
    distance: service.stats().lastDistance,
  });

  it("refreshes each voice once per snapshot and matches the sequential two-pass results", async () => {
    const clock = { now: 0 };
    const combinedBackend = new CountingBackend();
    const baselineBackend = new CountingBackend();
    const combined = await dopplerEmitter(combinedBackend, clock);
    const baseline = await dopplerEmitter(baselineBackend, clock);
    const writesBefore = { pose: combinedBackend.poseWrites, muffle: combinedBackend.muffleWrites };
    const observed: Array<ReturnType<typeof observe>> = [];
    for (const frame of frames) {
      clock.now = frame.at;
      const poses = [{ slotId: 1, position: { x: frame.emitterX, y: 1, z: 1 } }];
      combined.syncSnapshot(poses, frame.listener);
      baseline.syncSnapshot(poses);
      if (frame.listener) baseline.syncListener(frame.listener);
      observed.push(observe(combinedBackend, combined));
      expect(observed.at(-1)).toEqual(observe(baselineBackend, baseline));
    }

    // Hand-derived: Doppler follows the listener the previous frame left, while
    // muffle and distance follow the incoming one.
    const c = AUDIO_SPEED_OF_SOUND;
    expect(observed.map((entry) => entry.rate)).toEqual([
      1,
      expect.closeTo(1 + 5 / c, 5),
      expect.closeTo(1 - 4 / c, 5),
      expect.closeTo(1 - 5 / c, 5),
    ]);
    expect(observed.map((entry) => entry.muffle)).toEqual([1, 0, 1, 1]);
    expect(observed.map((entry) => entry.pose)).toEqual([1.0, 1.5, 1.9, 1.4]);
    expect(observed.map((entry) => entry.listener)).toEqual([5, 0.25, 5, 5]);
    expect(observed.map((entry) => entry.distance)).toEqual([
      expect.closeTo(4, 5), expect.closeTo(1.25, 5), expect.closeTo(3.1, 5), expect.closeTo(3.6, 5),
    ]);
    // The emitter moves every frame; the muffle is written when it changes (0 before the first pose, then 1, 0, 1).
    expect(combinedBackend.poseWrites - writesBefore.pose).toBe(frames.length);
    expect(combinedBackend.muffleWrites - writesBefore.muffle).toBe(3);
    combined.dispose();
    baseline.dispose();
  });

  it("still applies the incoming listener when no spatial voice exists to refresh", () => {
    const backend = new CountingBackend();
    const service = new AudioService({ backend });
    service.syncSnapshot([{ slotId: 1, position: { x: 9, y: 0, z: 0 } }], { x: 2, y: 3, z: 4 });
    expect(backend.listener).toEqual({ x: 2, y: 3, z: 4 });
    expect(backend.poseWrites).toBe(0);
    service.dispose();
  });
});

/**
 * Records every pose, muffle, distance gain, rate, listener and reverb write, counting those whose arguments equal the previous
 * call's for the same target. While `landing` is false it takes nothing, as a backend without the voice or engine.
 */
class RepeatCountingBackend extends FakeAudioPlaybackBackend {
  landing = true;
  writes = 0;
  repeats = 0;
  private readonly last = new Map<string, string>();

  private record(target: string, value: unknown): void {
    const text = JSON.stringify(value);
    this.writes += 1;
    if (this.last.get(target) === text) this.repeats += 1;
    this.last.set(target, text);
  }

  override setVoicePose(voiceId: string, pose: AudioPose): boolean {
    this.record(`pose:${voiceId}`, pose);
    return this.landing && super.setVoicePose(voiceId, { ...pose });
  }

  override setVoiceMuffle(voiceId: string, factor: number): boolean {
    this.record(`muffle:${voiceId}`, factor);
    return this.landing && super.setVoiceMuffle(voiceId, factor);
  }

  override setVoiceAttenuation(voiceId: string, gain: number): boolean {
    this.record(`attenuation:${voiceId}`, gain);
    return this.landing && super.setVoiceAttenuation(voiceId, gain);
  }

  override setVoicePlaybackRate(voiceId: string, rate: number): boolean {
    this.record(`rate:${voiceId}`, rate);
    return this.landing && super.setVoicePlaybackRate(voiceId, rate);
  }

  override setListenerPose(pose: AudioPose): boolean {
    this.record("listener", pose);
    return this.landing && super.setListenerPose({ ...pose });
  }

  override setReverbProfile(profile: { wet: number; decay: number; damping: number }): boolean {
    this.record("reverb", profile);
    return this.landing && super.setReverbProfile(profile);
  }
}

describe("AudioService writes of unchanged values", () => {
  /** What a session is set to; `apply` brings a service to it, whatever the service held before. */
  type Scene = {
    listener: AudioPose;
    emitter: { x: number; y: number; z: number };
    /** Occupied voxels (2 units wide along x from 0) and the wet level of the probe at x = 8 (the other is 0.2 at x = 0). */
    walls: number;
    farWet: number;
    settings: { occlusionEnabled: boolean; reverbWetScale: number };
    bedPlaying: boolean;
  };
  const initial: Scene = {
    listener: { x: 5, y: 1, z: 1 },
    emitter: { x: 1, y: 1, z: 1 },
    walls: 0b0000_0110,
    farWet: 0.8,
    settings: { occlusionEnabled: true, reverbWetScale: 1 },
    bedPlaying: true,
  };

  /** A muffled spatial voice ("v1", on slot 1) and a non-spatial reverb-send voice ("bed"). */
  async function start(backend: FakeAudioPlaybackBackend, clock: { now: number }) {
    const service = new AudioService({ backend, now: () => clock.now });
    service.setLibrary(library({
      channels: {
        walls: { parentChannelGuid: null, effects: [{ kind: "environmentReverb", enabled: false }, { kind: "muffleThroughWalls", enabled: true }] },
        room: { parentChannelGuid: null, effects: [{ kind: "environmentReverb", enabled: true }] },
      },
      audio: {
        jump: { volume: 1, audioChannelGuid: "walls", soundAttenuationGuid: "near" },
        bed: { volume: 1, audioChannelGuid: "room", soundAttenuationGuid: null },
      },
      attenuations: {
        near: {
          innerRadius: 1, maxRadius: 50, falloff: "linear", falloffCurveGuid: null, spatialisation: "equalPower", cone: null,
          doppler: { enabled: true, factor: 1 },
        },
      },
    }));
    service.setSourceBytes("jump", new Uint8Array([1]));
    service.setSourceBytes("bed", new Uint8Array([2]));
    await service.unlockAsync();
    service.noteActorSlot("speaker", 1);
    service.handleCommand({ type: "playSound", assetGuid: "jump", volume: 1, frameId: 1, voiceId: "v1", emitterActorGuid: "speaker" });
    service.handleCommand({ type: "playSound", assetGuid: "bed", volume: 1, frameId: 1, voiceId: "bed" });
    await service.flush();
    return service;
  }

  const field = (scene: Scene) => encodeAudioReverbChunk({
    dryFallback: false,
    geometryHash: `walls-${scene.walls}-${scene.farWet}`,
    probes: [
      { x: 0, y: 0, z: 0, volume: 1, openness: 0, decay: 0.5, damping: 0.5, wet: 0.2 },
      { x: 8, y: 0, z: 0, volume: 1, openness: 0, decay: 0.9, damping: 0.1, wet: scene.farWet },
    ],
    occupancy: {
      originX: 0, originY: 0, originZ: 0, voxelX: 2, voxelY: 2, voxelZ: 2, sizeX: 4, sizeY: 1, sizeZ: 1,
      bits: new Uint8Array([scene.walls]),
    },
  });

  /** The emitter's pose row is one object rewritten for every snapshot, as the host's is. */
  const row = { slotId: 1, position: { x: 0, y: 0, z: 0 } };
  async function apply(service: AudioService, scene: Scene, previous: Scene | null, clock: { now: number }) {
    if (!previous || previous.walls !== scene.walls || previous.farWet !== scene.farWet) service.setReverbField(field(scene));
    if (!previous || previous.settings !== scene.settings) service.setProjectAudioSettings(scene.settings);
    if ((previous?.bedPlaying ?? true) && !scene.bedPlaying) {
      service.handleCommand({ type: "stopSound", voiceId: "bed" });
      await service.flush();
    }
    clock.now += 16;
    Object.assign(row.position, scene.emitter);
    service.syncSnapshot([row], { ...scene.listener });
  }

  const heard = (backend: FakeAudioPlaybackBackend) => ({
    listener: { ...backend.listener },
    pose: { ...backend.poses.get("v1") },
    muffles: [backend.muffles.get("v1"), backend.muffles.get("bed")],
    attenuation: backend.attenuations.get("v1"),
    reverb: [backend.wet, backend.decay, backend.damping],
  });

  it("sends the backend nothing while the listener, emitters, reverb field, settings and voices stay as they are", async () => {
    const clock = { now: 0 };
    const backend = new RepeatCountingBackend();
    const service = await start(backend, clock);
    await apply(service, initial, null, clock);
    // Two walls between the emitter at x = 1 and the listener at x = 5.
    expect(heard(backend).muffles).toEqual([1, 0]);
    const settled = backend.writes;
    for (let snapshot = 0; snapshot < 30; snapshot++) await apply(service, initial, initial, clock);
    // Listener-only refreshes (between snapshots) of the same pose send nothing either.
    for (let refresh = 0; refresh < 5; refresh++) service.syncListener({ ...initial.listener });
    expect(backend.writes - settled).toBe(0);
    expect(backend.repeats).toBe(0);
    service.dispose();
  });

  it("leaves the backend as a new session at the same state would, after each kind of change", async () => {
    const clock = { now: 0 };
    const backend = new RepeatCountingBackend();
    const service = await start(backend, clock);
    let scene = initial;
    await apply(service, scene, null, clock);
    const changes: Array<[string, Partial<Scene>]> = [
      ["listener moves to one wall away", { listener: { x: 3, y: 1, z: 1 } }],
      ["listener turns in place", { listener: { x: 3, y: 1, z: 1, qx: 0, qy: 1, qz: 0, qw: 0 } }],
      ["emitter moves behind both walls", { emitter: { x: 6.5, y: 1, z: 1 } }],
      ["emitter returns", { emitter: { x: 1, y: 1, z: 1 } }],
      ["a wall is removed", { walls: 0b0000_0010 }],
      ["the far probe gets wetter", { farWet: 1 }],
      ["occlusion is switched off", { settings: { occlusionEnabled: false, reverbWetScale: 1 } }],
      ["occlusion returns and reverb is scaled down", { settings: { occlusionEnabled: true, reverbWetScale: 0.5 } }],
      ["the reverb-send voice stops", { bedPlaying: false }],
      ["listener moves away again", { listener: { x: 5, y: 1, z: 1 } }],
    ];
    const muffles: unknown[] = [];
    const wets: number[] = [];
    for (const [label, change] of changes) {
      const next = { ...scene, ...change };
      await apply(service, next, scene, clock);
      // Held for a few more snapshots, so skipped refreshes are part of what is compared.
      for (let held = 0; held < 3; held++) await apply(service, next, next, clock);
      scene = next;
      const freshBackend = new FakeAudioPlaybackBackend();
      const fresh = await start(freshBackend, { now: 0 });
      await apply(fresh, scene, null, { now: 0 });
      expect(heard(backend), label).toEqual(heard(freshBackend));
      muffles.push(backend.muffles.get("v1"));
      wets.push(backend.wet);
      fresh.dispose();
    }
    // Hand-derived for the emitter voice: walls between it and the listener, the listener's own voxel included
    // (x = 3 is inside the first wall); one wall is 0.5, two saturate at 1.
    expect(muffles).toEqual([0.5, 0.5, 1, 0.5, 0.5, 0.5, 0, 0.5, 0.5, 0.5]);
    // No voice sends to the reverb once the bed stops.
    expect(wets.slice(-2)).toEqual([0, 0]);
    expect(wets[5]).toBeGreaterThan(wets[4]!);
    expect(wets[7]).toBeCloseTo(wets[6]! / 2, 10);
    expect(backend.repeats).toBe(0);
    service.dispose();
  });

  it("sends a pitch change and a Doppler shift once each, and nothing for a still Doppler voice", async () => {
    const clock = { now: 0 };
    const backend = new RepeatCountingBackend();
    const service = await start(backend, clock);
    await apply(service, initial, null, clock);
    await apply(service, initial, initial, clock);
    expect(backend.playbackRates.get("v1")).toBe(1);
    service.handleCommand({ type: "setVoicePitch", voiceId: "v1", pitch: 2 });
    await service.flush();
    expect(backend.playbackRates.get("v1")).toBe(2);
    // The emitter approaches the listener at 1 unit per 16 ms, then stops.
    const approaching = { ...initial, emitter: { x: 2, y: 1, z: 1 } };
    await apply(service, approaching, initial, clock);
    expect(backend.playbackRates.get("v1")).toBeCloseTo(2 * (1 + (1 / 0.016) / AUDIO_SPEED_OF_SOUND), 3);
    await apply(service, approaching, approaching, clock);
    expect(backend.playbackRates.get("v1")).toBe(2);
    const settled = backend.writes;
    await apply(service, approaching, approaching, clock);
    expect(backend.writes - settled).toBe(0);
    expect(backend.repeats).toBe(0);
    service.dispose();
  });

  it("sends an unchanged value again until the backend has taken it", async () => {
    const clock = { now: 0 };
    const backend = new RepeatCountingBackend();
    const service = await start(backend, clock);
    // The backend has no engine or sound to write to yet: every refresh offers the same values again.
    backend.landing = false;
    await apply(service, initial, null, clock);
    const offered = backend.writes;
    await apply(service, initial, initial, clock);
    expect(backend.writes - offered).toBeGreaterThanOrEqual(4);
    expect(backend.poses.has("v1")).toBe(false);
    // Once it takes them, they arrive, and are not sent again.
    backend.landing = true;
    await apply(service, initial, initial, clock);
    expect(heard(backend)).toEqual({
      listener: { x: 5, y: 1, z: 1 },
      pose: { x: 1, y: 1, z: 1 },
      muffles: [1, 0],
      // Linear 1..50 at distance 4: 1 - 3/49.
      attenuation: expect.closeTo(46 / 49, 10),
      reverb: [backend.wet, backend.decay, backend.damping],
    });
    expect(backend.wet).toBeGreaterThan(0.2);
    const taken = backend.writes;
    await apply(service, initial, initial, clock);
    expect(backend.writes - taken).toBe(0);
    service.dispose();
  });
});

describe("AudioService emitter poses", () => {
  async function emitters() {
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend });
    service.setLibrary(
      library({
        audio: {
          spatial: { ...createDefaultAudioPayload(), soundAttenuationGuid: "near" },
          bed: createDefaultAudioPayload(),
        },
        attenuations: {
          near: {
            innerRadius: 1, maxRadius: 50, falloff: "linear", falloffCurveGuid: null,
            spatialisation: "equalPower", cone: null, doppler: null,
          },
        },
      }),
    );
    service.setSourceBytes("spatial", new Uint8Array([1]));
    service.setSourceBytes("bed", new Uint8Array([1]));
    await service.unlockAsync();
    service.noteActorSlot("speaker", 1);
    service.noteActorSlot("walker", 2);
    service.noteActorSlot("bystander", 3);
    const play = async (voiceId: string, assetGuid: string, emitterActorGuid: string) => {
      service.handleCommand({ type: "playSound", assetGuid, volume: 1, frameId: 1, voiceId, emitterActorGuid });
      await service.flush();
    };
    return { backend, service, play };
  }

  it("lists only the slots that live spatial voices emit from", async () => {
    const { service, play } = await emitters();
    await play("v1", "spatial", "speaker");
    await play("v2", "spatial", "walker");
    // Not spatial, and an emitter no spawn has announced: neither is read.
    await play("v3", "bed", "bystander");
    await play("v4", "spatial", "ghost");
    const slots = new Set<number>();
    expect(service.collectEmitterSlots(slots)).toBe(slots);
    expect([...slots].sort()).toEqual([1, 2]);

    service.handleCommand({ type: "stopSound", voiceId: "v2" });
    await service.flush();
    expect([...service.collectEmitterSlots(slots)]).toEqual([1]);

    // Despawn drops the mapping; a respawn under the same guid is listed again.
    service.forgetActorSlot("speaker", 1);
    expect(service.collectEmitterSlots(slots).size).toBe(0);
    service.noteActorSlot("speaker", 4);
    expect([...service.collectEmitterSlots(slots)]).toEqual([4]);
    service.dispose();
  });

  it("places a voice that starts on an unposed emitter from the host's current pose, and keeps the debug listing", async () => {
    const { backend, service, play } = await emitters();
    const source = vi.fn((slotId: number) => (slotId === 2 ? { x: 7, y: 0, z: 0 } : undefined));
    service.setEmitterPoseSource(source);
    service.setShowAudioDebug(true);
    service.syncListener({ x: 0, y: 0, z: 0 });
    await play("v1", "spatial", "speaker");
    service.syncSnapshot([{ slotId: 1, position: { x: 3, y: 0, z: 0 } }]);
    source.mockClear();

    await play("v2", "spatial", "walker");
    expect(backend.poses.get("v2")?.x).toBe(7);
    // A new voice on the already posed emitter, and one the host cannot place, ask nothing new.
    await play("v3", "spatial", "speaker");
    await play("v4", "spatial", "bystander");
    expect(source.mock.calls).toEqual([[2], [3]]);
    expect(backend.poses.get("v4")).toBeUndefined();
    expect(service.stats().debugVoices?.map((voice) => voice.distance)).toEqual([3, 7, 3, null]);
    service.dispose();
  });
});

describe("AudioService lifecycle events", () => {
  it("pauses on audio interruption begin and resumes on interruption end", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const target = new EventTarget();
    const service = new AudioService({ backend, lifecycleTarget: target });

    target.dispatchEvent(
      new CustomEvent("haptic:audiointerruption", {
        detail: { type: "began" },
      }),
    );
    expect(backend.paused).toBe(true);

    target.dispatchEvent(
      new CustomEvent("haptic:audiointerruption", {
        detail: { type: "ended", shouldResume: true },
      }),
    );
    expect(backend.paused).toBe(false);

    service.dispose();
  });

  it("keeps audio paused after interruption end when the user already paused", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const target = new EventTarget();
    const service = new AudioService({ backend, lifecycleTarget: target });

    service.setPaused(true);
    target.dispatchEvent(
      new CustomEvent("haptic:audiointerruption", {
        detail: { type: "began" },
      }),
    );
    target.dispatchEvent(
      new CustomEvent("haptic:audiointerruption", {
        detail: { type: "ended", shouldResume: true },
      }),
    );
    expect(backend.paused).toBe(true);

    service.dispose();
  });

  it("does not resume when the interruption end signals should not resume", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const target = new EventTarget();
    const service = new AudioService({ backend, lifecycleTarget: target });

    target.dispatchEvent(
      new CustomEvent("haptic:audiointerruption", {
        detail: { type: "began" },
      }),
    );
    target.dispatchEvent(
      new CustomEvent("haptic:audiointerruption", {
        detail: { type: "ended", shouldResume: false },
      }),
    );
    expect(backend.paused).toBe(true);

    const resumeContext = vi.spyOn(backend, "resumeContext");
    target.dispatchEvent(new Event("haptic:audioroutechange"));
    service.setPaused(false);
    expect(backend.paused).toBe(true);
    expect(resumeContext).not.toHaveBeenCalled();
    await service.unlockAsync();
    expect(backend.paused).toBe(false);

    service.dispose();
  });

  it("keeps audio paused while the native app is inactive after an interruption ends", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const target = new EventTarget();
    const service = new AudioService({ backend, lifecycleTarget: target });
    target.dispatchEvent(new CustomEvent("haptic:appstate", { detail: { isActive: false } }));
    target.dispatchEvent(new CustomEvent("haptic:audiointerruption", { detail: { type: "ended", shouldResume: true } }));
    expect(backend.paused).toBe(true);
    target.dispatchEvent(new CustomEvent("haptic:appstate", { detail: { isActive: true } }));
    expect(backend.paused).toBe(false);
    service.dispose();
  });

  it("recovers the audio context on route change when not paused", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const resumeContext = vi.spyOn(backend, "resumeContext");
    const target = new EventTarget();
    const service = new AudioService({ backend, lifecycleTarget: target });

    target.dispatchEvent(new Event("haptic:audioroutechange"));
    expect(resumeContext).toHaveBeenCalled();

    service.dispose();
  });

  it("does not recover the audio context on route change when paused by the user", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const resumeContext = vi.spyOn(backend, "resumeContext");
    const target = new EventTarget();
    const service = new AudioService({ backend, lifecycleTarget: target });

    service.setPaused(true);
    target.dispatchEvent(new Event("haptic:audioroutechange"));
    expect(resumeContext).not.toHaveBeenCalled();

    service.dispose();
  });
});

describe("AudioService with runtime Audio component commands", () => {
  it("stops the voice an Audio component's script Play started when its Stop runs", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const diagnostics: Array<{ code: string }> = [];
    const service = new AudioService({ backend, onDiagnostic: (entry) => diagnostics.push(entry) });
    service.setLibrary(library({ audio: { jump: createDefaultAudioPayload() } }));
    service.setSourceBytes("jump", new Uint8Array([1, 2, 3]));
    const runtime = createInProcessRuntime({
      seed: 1,
      preferSoftwarePhysics: true,
      playScene: {
        name: "Audio",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [createActor("speaker", "Speaker", {
          classId: "Speaker",
          components: [{ id: "audio-1", classId: "AudioComponent", properties: { audioAssetGuid: "jump", playOnStart: false, loop: true } }],
        })],
      },
      onCommand: (command) => service.handleCommand(command),
    });
    try {
      await service.unlockAsync();
      await runtime.loadScripts([{
        assetGuid: "speaker-script", classId: "Speaker", parentClassId: "Actor", anchors: [],
        entryPoints: ["Play", "Stop"].map((name) => ({ name, event: name, isAsync: false })),
        source: `
          export function Play(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "audio-1"), "playAudio", {}); }
          export function Stop(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "audio-1"), "stopAudio", {}); }`,
      }]);
      runtime.realizePlayWorld();
      runtime.start();
      const speaker = runtime.getWorld().findActor("speaker")!;
      runtime.invokeScriptEvent("Speaker", "Play", speaker);
      runtime.tick();
      await service.flush();
      expect(service.stats().voices).toBe(1);
      runtime.invokeScriptEvent("Speaker", "Stop", speaker);
      runtime.tick();
      await service.flush();
      expect(backend.stopped).toEqual(["audio-1"]);
      expect(service.stats().voices).toBe(0);
      expect(diagnostics).toEqual([]);
    } finally {
      runtime.stop();
      service.dispose();
    }
  });

  it("streams without PCM decoding, ref-counts Blob URLs across voices, and bypasses AudioBufferCache during play and preload", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const cache = new AudioBufferCache();
    const created: string[] = [];
    const revoked: string[] = [];
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:stream-${created.length + 1}`;
      created.push(url);
      return url;
    });
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(url);
    });
    const musicBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x01, 0x02, 0x03, 0x04]);
    const service = new AudioService({
      backend,
      cache,
      loadSourceBytes: async () => musicBytes,
    });
    try {
      service.setLibrary(
        library({
          audio: {
            bgm: { ...createDefaultAudioPayload(), playbackMode: "streamed", loop: true },
          },
        }),
      );
      await service.unlockAsync();
      // Preload verifies availability without decoding PCM or pinning the PCM LRU.
      const releasePreload = await service.preload(["bgm"]);
      expect(backend.decodeCount).toBe(0);
      expect(cache.accountedBytes()).toBe(0);
      releasePreload();

      service.handleCommand({ type: "playSound", assetGuid: "bgm", voiceId: "bgm-1", volume: 0.7, frameId: 1 });
      service.handleCommand({ type: "playSound", assetGuid: "bgm", voiceId: "bgm-2", volume: 0.5, frameId: 2 });
      await service.flush();

      expect(backend.decodeCount).toBe(0);
      expect(cache.accountedBytes()).toBe(0);
      expect(created).toEqual(["blob:stream-1"]);
      expect(revoked).toEqual([]);
      expect(backend.plays[0]).toMatchObject({
        voiceId: "bgm-1",
        playbackMode: "streamed",
        sourceUrl: "blob:stream-1",
        mimeType: "audio/mpeg",
      });
      expect(backend.plays[1]?.sourceUrl).toBe("blob:stream-1");
      expect(service.stats().streamedVoices).toBe(2);
      expect(service.stats().streamedBytes).toBeGreaterThan(musicBytes.byteLength);

      service.handleCommand({ type: "stopSound", voiceId: "bgm-1" });
      await service.flush();
      expect(revoked).toEqual([]);
      expect(service.stats().streamedVoices).toBe(1);

      service.handleCommand({ type: "stopSound", voiceId: "bgm-2" });
      await service.flush();
      expect(revoked).toEqual(["blob:stream-1"]);
      expect(service.stats().streamedVoices).toBe(0);
      expect(service.stats().streamedBytes).toBe(0);
    } finally {
      service.dispose();
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });

  it("streams directly from resolveStreamUrl without calling loadSourceBytes or creating a Blob URL", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const loadSourceBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const service = new AudioService({
      backend,
      loadSourceBytes,
      resolveStreamUrl: ({ assetGuid, chunkId }) =>
        assetGuid === "bgm" && chunkId === "source" ? "https://game.example/assets/stream-0.mp3" : null,
    });
    try {
      service.setLibrary(
        library({
          audio: {
            bgm: { ...createDefaultAudioPayload(), playbackMode: "streamed" },
          },
        }),
      );
      await service.unlockAsync();
      await service.preload(["bgm"]);
      service.handleCommand({ type: "playSound", assetGuid: "bgm", voiceId: "bgm-direct", volume: 1, frameId: 1 });
      await service.flush();

      expect(loadSourceBytes).not.toHaveBeenCalled();
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(backend.decodeCount).toBe(0);
      expect(backend.plays[0]).toMatchObject({
        voiceId: "bgm-direct",
        playbackMode: "streamed",
        sourceUrl: "https://game.example/assets/stream-0.mp3",
      });
    } finally {
      service.dispose();
      createObjectURL.mockRestore();
    }
  });

  it("releases lazily loaded streamed bytes after preload/Blob creation and preserves pre-seeded streamed bytes across replay", async () => {
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x05, 0x06]);
    const created: string[] = [];
    const revoked: string[] = [];
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:reuse-${created.length + 1}`;
      created.push(url);
      return url;
    });
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(url);
    });

    // 1. Lazy loader path: preload does not pin bytes in sourceBytes, and an active Blob URL is reused without re-reading.
    const lazyBackend = new FakeAudioPlaybackBackend();
    const loadSourceBytes = vi.fn(async () => mp3);
    const lazyService = new AudioService({ backend: lazyBackend, loadSourceBytes });
    try {
      lazyService.setLibrary(
        library({ audio: { bgm: { ...createDefaultAudioPayload(), playbackMode: "streamed" } } }),
      );
      await lazyService.unlockAsync();
      const release = await lazyService.preload(["bgm"]);
      release();
      expect(loadSourceBytes).toHaveBeenCalledTimes(1);

      // First play loads once (because preload did not retain sourceBytes in JS heap).
      lazyService.handleCommand({ type: "playSound", assetGuid: "bgm", voiceId: "v1", volume: 1, frameId: 1 });
      await lazyService.flush();
      expect(loadSourceBytes).toHaveBeenCalledTimes(2);
      expect(created).toEqual(["blob:reuse-1"]);

      // Second overlapping voice reuses the active Blob URL without calling loadSourceBytes again.
      lazyService.handleCommand({ type: "playSound", assetGuid: "bgm", voiceId: "v2", volume: 1, frameId: 2 });
      await lazyService.flush();
      expect(loadSourceBytes).toHaveBeenCalledTimes(2);
      expect(lazyBackend.plays[1]?.sourceUrl).toBe("blob:reuse-1");

      lazyService.handleCommand({ type: "stopSound", voiceId: "v1" });
      lazyService.handleCommand({ type: "stopSound", voiceId: "v2" });
      await lazyService.flush();
      expect(revoked).toEqual(["blob:reuse-1"]);
    } finally {
      lazyService.dispose();
    }

    // 2. Pre-seeded audioBytes path (no lazy loader): stopping and replaying must still find its source bytes.
    const seededBackend = new FakeAudioPlaybackBackend();
    const seededService = new AudioService({ backend: seededBackend });
    try {
      seededService.setLibrary(
        library({ audio: { bgm: { ...createDefaultAudioPayload(), playbackMode: "streamed" } } }),
      );
      seededService.setSourceBytes("bgm", mp3);
      await seededService.unlockAsync();
      seededService.handleCommand({ type: "playSound", assetGuid: "bgm", voiceId: "s1", volume: 1, frameId: 1 });
      await seededService.flush();
      seededService.handleCommand({ type: "stopSound", voiceId: "s1" });
      await seededService.flush();
      seededService.handleCommand({ type: "playSound", assetGuid: "bgm", voiceId: "s2", volume: 1, frameId: 2 });
      await seededService.flush();
      expect(seededBackend.plays).toHaveLength(2);
      expect(seededBackend.plays[1]?.voiceId).toBe("s2");
    } finally {
      seededService.dispose();
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });
});

