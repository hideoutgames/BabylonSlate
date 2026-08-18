import {
  CreateAudioBusAsync,
  CreateAudioEngineAsync,
  CreateSoundAsync,
  CreateSoundBufferAsync,
  type AudioBus,
  type AudioEngineV2,
  type StaticSound,
  type StaticSoundBuffer,
} from "@babylonjs/core/AudioV2";
import { AUDIO_SHARED_REVERB_BUSES } from "@babylonslate/assets";
import type {
  AudioPlaybackBackend,
  AudioPlayRequest,
  AudioPose,
} from "./audio-playback-backend";
import {
  connectParametricReverb,
  type ParametricReverbGraph,
} from "./parametric-reverb";

function sourceBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function webAudioPort(
  node: object | null | undefined,
  key: "_inNode" | "_outNode",
): AudioNode | null {
  if (!node || typeof node !== "object") return null;
  const value = (node as Record<string, unknown>)[key];
  return value && typeof (value as AudioNode).connect === "function"
    ? (value as AudioNode)
    : null;
}

function engineAudioContext(engine: AudioEngineV2): AudioContext | null {
  const value = (engine as { _audioContext?: unknown })._audioContext;
  return value instanceof AudioContext ? value : null;
}

/**
 * Babylon 9 AudioV2 playback. Coverage-excluded like create-engine; unit tests
 * inject {@link FakeAudioPlaybackBackend}.
 */
export class BabylonAudioPlaybackBackend implements AudioPlaybackBackend {
  private engine: AudioEngineV2 | null = null;
  private reverbBus: AudioBus | null = null;
  private reverbGraph: ParametricReverbGraph | null = null;
  private audioContext: AudioContext | null = null;
  private readonly buffers = new Map<string, StaticSoundBuffer>();
  private readonly voices = new Map<string, StaticSound>();
  private unlocked = false;

  isUnlocked(): boolean {
    return this.unlocked;
  }

  async unlockAsync(): Promise<void> {
    const engine = await this.ensureEngine();
    await engine.unlockAsync();
    this.unlocked = true;
  }

  async decode(
    assetGuid: string,
    bytes: Uint8Array,
  ): Promise<{ pcmBytes: number }> {
    const engine = await this.ensureEngine();
    const buffer = await CreateSoundBufferAsync(sourceBuffer(bytes), {}, engine);
    this.buffers.set(assetGuid, buffer);
    return {
      pcmBytes: Math.max(1, buffer.length * buffer.channelCount * 4),
    };
  }

  async play(request: AudioPlayRequest): Promise<void> {
    const engine = await this.ensureEngine();
    this.stop(request.voiceId);
    let buffer = this.buffers.get(request.assetGuid);
    if (!buffer) {
      buffer = await CreateSoundBufferAsync(
        sourceBuffer(request.source),
        {},
        engine,
      );
      this.buffers.set(request.assetGuid, buffer);
    }
    const spatial = request.spatial;
    const sound = await CreateSoundAsync(
      request.voiceId,
      buffer,
      {
        volume: request.gain,
        loop: request.loop,
        maxInstances: 1,
        spatialEnabled: spatial?.enabled === true,
        spatialMinDistance: spatial?.innerRadius,
        spatialMaxDistance: spatial?.maxRadius,
        spatialDistanceModel: spatial?.distanceModel,
        spatialRolloffFactor: spatial?.rolloff,
        spatialPanningModel:
          spatial?.spatialisation === "hrtf" ? "HRTF" : "equalpower",
        spatialConeInnerAngle: spatial?.cone
          ? degreesToRadians(spatial.cone.innerAngle)
          : undefined,
        spatialConeOuterAngle: spatial?.cone
          ? degreesToRadians(spatial.cone.outerAngle)
          : undefined,
        spatialConeOuterVolume: spatial?.cone?.outerGain,
        outBus: request.reverbSend ? this.reverbBus : null,
      },
      engine,
    );
    this.voices.set(request.voiceId, sound);
    sound.play();
  }

  stop(voiceId: string): void {
    const sound = this.voices.get(voiceId);
    if (!sound) return;
    sound.stop();
    sound.dispose();
    this.voices.delete(voiceId);
  }

  setVoiceGain(voiceId: string, gain: number): void {
    const sound = this.voices.get(voiceId);
    if (sound) sound.volume = gain;
  }

  setVoicePose(voiceId: string, pose: AudioPose): void {
    const sound = this.voices.get(voiceId);
    if (!sound) return;
    sound.spatial.position.set(pose.x, pose.y, pose.z);
    if (
      pose.qx !== undefined &&
      pose.qy !== undefined &&
      pose.qz !== undefined &&
      pose.qw !== undefined
    ) {
      sound.spatial.rotationQuaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
    }
  }

  setVoicePlaybackRate(voiceId: string, rate: number): void {
    const sound = this.voices.get(voiceId);
    if (sound) sound.playbackRate = rate;
  }

  setListenerPose(pose: AudioPose): void {
    const listener = this.engine?.listener;
    if (!listener) return;
    listener.position.set(pose.x, pose.y, pose.z);
    if (
      pose.qx !== undefined &&
      pose.qy !== undefined &&
      pose.qz !== undefined &&
      pose.qw !== undefined
    ) {
      listener.rotationQuaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
    }
  }

  setReverbWet(wet: number): void {
    if (this.reverbGraph) {
      this.reverbGraph.setWet(wet);
      return;
    }
    if (this.reverbBus) this.reverbBus.volume = wet;
  }

  dispose(): void {
    for (const voiceId of [...this.voices.keys()]) {
      try {
        this.stop(voiceId);
      } catch {
        this.voices.delete(voiceId);
      }
    }
    this.buffers.clear();
    try {
      this.reverbGraph?.dispose();
    } catch {
      /* Play stop must still finish. */
    }
    this.reverbGraph = null;
    try {
      this.reverbBus?.dispose();
    } catch {
      /* keep tearing down */
    }
    this.reverbBus = null;
    try {
      this.engine?.dispose();
    } catch {
      /* keep tearing down */
    }
    this.engine = null;
    this.audioContext = null;
    this.unlocked = false;
  }

  private async ensureEngine(): Promise<AudioEngineV2> {
    if (this.engine) return this.engine;
    const engine = await CreateAudioEngineAsync({
      disableDefaultUI: true,
      resumeOnInteraction: false,
      listenerEnabled: true,
    });
    this.audioContext = engineAudioContext(engine);
    for (let i = 0; i < AUDIO_SHARED_REVERB_BUSES; i += 1) {
      this.reverbBus = await CreateAudioBusAsync(
        i === 0 ? "environmentReverb" : `environmentReverb-${i}`,
        {
          volume: 1,
          ...(engine.defaultMainBus ? { outBus: engine.defaultMainBus } : {}),
        },
        engine,
      );
    }
    this.attachParametricReverb(engine);
    this.engine = engine;
    return engine;
  }

  private attachParametricReverb(engine: AudioEngineV2): void {
    const context = this.audioContext;
    const busOut = webAudioPort(this.reverbBus, "_outNode");
    const mainIn =
      webAudioPort(engine.mainOut, "_inNode") ??
      webAudioPort(engine.defaultMainBus, "_inNode");
    if (!context || !busOut || !mainIn) return;
    // Add a wet send only. Disconnecting AudioV2's private ports hung Play Stop.
    try {
      this.reverbGraph = connectParametricReverb(context, busOut, mainIn, {
        dryPassThrough: false,
      });
    } catch {
      this.reverbGraph = null;
    }
  }
}
