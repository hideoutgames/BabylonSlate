import { describe, expect, it } from "vitest";
import {
  AUDIO_MAX_CONCURRENT_VOICES,
  AUDIO_PRE_UNLOCK_QUEUE_CAP,
  AUDIO_REVERB_VERSION,
  createDefaultAudioPayload,
  encodeAudioReverbChunk,
  type AudioChannelPayload,
  type AudioMixerPayload,
  type AudioPayload,
  type SoundAttenuationPayload,
} from "@babylonslate/assets";
import { AudioBufferCache } from "./audio-buffer-cache";
import { FakeAudioPlaybackBackend } from "./audio-playback-backend";
import { AudioService } from "./audio-service";

function library(options?: {
  mixer?: AudioMixerPayload | null;
  mixerGuid?: string | null;
  channels?: Record<string, AudioChannelPayload>;
  audio?: Record<string, AudioPayload>;
  attenuations?: Record<string, SoundAttenuationPayload>;
}) {
  return {
    mixerGuid: options?.mixerGuid ?? (options?.mixer ? "mixer-1" : null),
    mixers: new Map(
      options?.mixer ? [["mixer-1", options.mixer] as const] : [],
    ),
    channels: new Map(Object.entries(options?.channels ?? {})),
    audio: new Map(Object.entries(options?.audio ?? {})),
    attenuations: new Map(Object.entries(options?.attenuations ?? {})),
  };
}

describe("AudioService", () => {
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
});
