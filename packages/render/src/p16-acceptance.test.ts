import { describe, expect, it } from "vitest";
import {
  AUDIO_REVERB_VERSION,
  computeAudioOutputGain,
  createDefaultAudioPayload,
  dryAudioReverbFallbackBytes,
  encodeAudioReverbChunk,
  resolveAudioPlayback,
  type AudioChannelPayload,
  type AudioMixerPayload,
} from "@babylonslate/assets";
import { AudioBufferCache } from "./audio-buffer-cache";
import { FakeAudioPlaybackBackend } from "./audio-playback-backend";
import { AudioService } from "./audio-service";

function library(options?: {
  mixer?: AudioMixerPayload | null;
  mixerGuid?: string | null;
  channels?: Record<string, AudioChannelPayload>;
  audio?: Record<string, ReturnType<typeof createDefaultAudioPayload>>;
  attenuations?: Record<
    string,
    {
      innerRadius: number;
      maxRadius: number;
      distanceModel: "linear";
      rolloff: number;
      spatialisation: "equalPower";
      cone: null;
      doppler: null;
    }
  >;
}) {
  return {
    mixerGuid: options?.mixerGuid ?? (options?.mixer ? "mixer-1" : null),
    mixers: new Map(options?.mixer ? [["mixer-1", options.mixer] as const] : []),
    channels: new Map(Object.entries(options?.channels ?? {})),
    audio: new Map(Object.entries(options?.audio ?? {})),
    attenuations: new Map(Object.entries(options?.attenuations ?? {})),
  };
}

describe("P16 audio acceptance", () => {
  it("multiplies asset 0.5 × playCall 0.5 to 0.25", () => {
    expect(
      computeAudioOutputGain({ assetVolume: 0.5, playCallVolume: 0.5 }),
    ).toBe(0.25);
  });

  it("multiplies mixer channel defaults through parents and global", () => {
    const channels = new Map<string, AudioChannelPayload>([
      [
        "sfx",
        {
          parentChannelGuid: "master",
          effects: [{ kind: "environmentReverb", enabled: false }],
        },
      ],
      [
        "master",
        {
          parentChannelGuid: null,
          effects: [{ kind: "environmentReverb", enabled: false }],
        },
      ],
    ]);
    const mixer: AudioMixerPayload = {
      globalVolume: 0.5,
      channels: [
        { channelGuid: "sfx", volume: 0.5 },
        { channelGuid: "master", volume: 0.5 },
      ],
    };
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
      }).gain,
    ).toBe(0.125);
  });

  it("lets Set Channel / Set Global replace session values without editing assets", async () => {
    const mixer: AudioMixerPayload = {
      globalVolume: 1,
      channels: [{ channelGuid: "sfx", volume: 1 }],
    };
    const backend = new FakeAudioPlaybackBackend();
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
    service.handleCommand({
      type: "setChannelVolume",
      channelGuid: "sfx",
      volume: 0.5,
    });
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
    service.dispose();
  });

  it("bypasses channel gain when Channel is None and still applies mixer global", () => {
    const mixer: AudioMixerPayload = {
      globalVolume: 0.5,
      channels: [{ channelGuid: "sfx", volume: 0.25 }],
    };
    const channels = new Map<string, AudioChannelPayload>([
      [
        "sfx",
        {
          parentChannelGuid: null,
          effects: [{ kind: "environmentReverb", enabled: true }],
        },
      ],
    ]);
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
      }),
    ).toMatchObject({ gain: 0.5, environmentReverb: false });
  });

  it("plays with no mixer and no channel without invented gain", () => {
    expect(
      resolveAudioPlayback({
        audio: createDefaultAudioPayload(),
        playCallVolume: 1,
        mixer: null,
        channels: new Map(),
      }),
    ).toMatchObject({ gain: 1, environmentReverb: false });
  });

  it("follows an Actor emitter and reports lastDistance", async () => {
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
    service.syncSnapshot([{ slotId: 1, position: { x: 4, y: 0, z: 0 } }]);
    expect(service.stats().lastDistance).toBe(4);
    service.dispose();
  });

  it("queues pre-gesture playback and returns voices to baseline on dispose", async () => {
    const cache = new AudioBufferCache();
    const backend = new FakeAudioPlaybackBackend();
    const service = new AudioService({ backend, cache });
    service.setLibrary(
      library({ audio: { jump: createDefaultAudioPayload() } }),
    );
    service.setSourceBytes("jump", new Uint8Array([1, 2, 3, 4]));
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 1,
    });
    expect(service.stats().unlocked).toBe(false);
    expect(service.stats().queued).toBe(1);
    expect(backend.plays).toHaveLength(0);
    await service.unlockAsync();
    expect(service.stats().unlocked).toBe(true);
    expect(service.stats().voices).toBe(1);
    service.dispose();
    expect(service.stats().voices).toBe(0);
    expect(service.stats().accountedBytes).toBe(0);
  });

  it("keeps reverb opt-in and dry fallback safe", async () => {
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
          dry: createDefaultAudioPayload(),
        },
      }),
    );
    service.setSourceBytes("jump", new Uint8Array([1]));
    service.setSourceBytes("dry", new Uint8Array([1]));
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
      voiceId: "wet",
    });
    await service.flush();
    service.syncListener({ x: 0, y: 0, z: 0 });
    expect(backend.plays[0]?.reverbSend).toBe(true);
    expect(service.stats().wet).toBe(0.4);
    service.handleCommand({ type: "stopSound", voiceId: "wet" });
    service.handleCommand({
      type: "playSound",
      assetGuid: "dry",
      volume: 1,
      frameId: 2,
      voiceId: "dry",
    });
    await service.flush();
    expect(service.stats().wet).toBe(0);
    service.setReverbField(dryAudioReverbFallbackBytes("h"));
    service.handleCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 1,
      frameId: 3,
      voiceId: "fallback",
    });
    await service.flush();
    expect(service.stats().wet).toBe(0);
    service.dispose();
  });
});
