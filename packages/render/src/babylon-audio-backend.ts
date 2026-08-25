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
import { AUDIO_MUFFLE_LOWPASS_HZ, AUDIO_SHARED_REVERB_BUSES } from "@babylonslate/assets";
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
  private creating: Promise<AudioEngineV2> | null = null;
  private reverbBus: AudioBus | null = null;
  private reverbGraph: ParametricReverbGraph | null = null;
  private audioContext: AudioContext | null = null;
  private readonly buffers = new Map<string, StaticSoundBuffer>();
  private readonly voices = new Map<string, StaticSound>();
  private readonly muffleSends = new Map<string, GainNode>();
  private muffleFilter: BiquadFilterNode | null = null;
  private unlocked = false;
  private paused = false;
  onVoiceEnded: ((voiceId: string) => void) | null = null;

  isUnlocked(): boolean {
    return this.unlocked;
  }

  async warmAsync(): Promise<void> {
    await this.ensureEngine();
  }

  async unlockAsync(): Promise<void> {
    this.resumeAudioContext();
    const engine = this.engine ?? (await this.ensureEngine());
    this.resumeAudioContext();
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
    let buffer = this.buffers.get(
      request.clipChunkId
        ? `${request.assetGuid}:${request.clipChunkId}`
        : request.assetGuid,
    );
    if (!buffer) {
      buffer = this.buffers.get(request.assetGuid);
    }
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
    sound.onEndedObservable.addOnce(() => {
      this.onVoiceEnded?.(request.voiceId);
    });
    sound.play();
    if (this.paused) this.pauseSound(sound);
  }

  stop(voiceId: string): void {
    this.disposeMuffleSend(voiceId);
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
    this.setReverbProfile({ wet, decay: 0.4, damping: 0.5 });
  }

  setReverbProfile(profile: {
    wet: number;
    decay: number;
    damping: number;
  }): void {
    if (this.reverbGraph) {
      this.reverbGraph.setProfile(profile);
      return;
    }
    if (this.reverbBus) this.reverbBus.volume = profile.wet;
  }

  setVoiceMuffle(voiceId: string, factor: number): void {
    const amount = Math.min(1, Math.max(0, factor));
    const sound = this.voices.get(voiceId);
    const out = webAudioPort(sound, "_outNode");
    const filter = this.ensureMuffleFilter();
    const context = this.audioContext;
    if (!sound || !out || !filter || !context) return;
    let send = this.muffleSends.get(voiceId);
    if (!send) {
      send = context.createGain();
      send.gain.value = 0;
      out.connect(send);
      send.connect(filter);
      this.muffleSends.set(voiceId, send);
    }
    send.gain.value = amount;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    let usedSoundPause = false;
    for (const sound of this.voices.values()) {
      if (paused) usedSoundPause = this.pauseSound(sound) || usedSoundPause;
      else usedSoundPause = this.resumeSound(sound) || usedSoundPause;
    }
    if (usedSoundPause) return;
    const ctx = this.audioContext;
    if (!ctx) return;
    if (paused) void ctx.suspend();
    else this.resumeAudioContext();
  }

  disposeBuffer(cacheKey: string): void {
    const buffer = this.buffers.get(cacheKey);
    if (!buffer) return;
    this.buffers.delete(cacheKey);
    const disposable = buffer as { dispose?: () => void };
    try {
      disposable.dispose?.();
    } catch {
      /* LRU must still drop the map entry */
    }
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
    for (const voiceId of [...this.muffleSends.keys()]) {
      this.disposeMuffleSend(voiceId);
    }
    try {
      this.muffleFilter?.disconnect();
    } catch {
      /* keep tearing down */
    }
    this.muffleFilter = null;
    try {
      this.engine?.dispose();
    } catch {
      /* keep tearing down */
    }
    this.engine = null;
    this.creating = null;
    this.audioContext = null;
    this.unlocked = false;
    this.paused = false;
  }

  private resumeAudioContext(): void {
    const ctx = this.audioContext;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
  }

  private pauseSound(sound: StaticSound): boolean {
    if (typeof sound.pause !== "function") return false;
    try {
      sound.pause();
      return true;
    } catch {
      return false;
    }
  }

  private resumeSound(sound: StaticSound): boolean {
    if (typeof sound.resume !== "function") return false;
    try {
      sound.resume();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureEngine(): Promise<AudioEngineV2> {
    if (this.engine) return this.engine;
    if (this.creating) return this.creating;
    this.creating = this.createEngine();
    try {
      this.engine = await this.creating;
      return this.engine;
    } finally {
      this.creating = null;
    }
  }

  private async createEngine(): Promise<AudioEngineV2> {
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

  private ensureMuffleFilter(): BiquadFilterNode | null {
    if (this.muffleFilter) return this.muffleFilter;
    const context = this.audioContext;
    const engine = this.engine;
    const mainIn =
      webAudioPort(engine?.mainOut, "_inNode") ??
      webAudioPort(engine?.defaultMainBus, "_inNode");
    if (!context || !mainIn) return null;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = AUDIO_MUFFLE_LOWPASS_HZ;
    filter.connect(mainIn);
    this.muffleFilter = filter;
    return filter;
  }

  private disposeMuffleSend(voiceId: string): void {
    const send = this.muffleSends.get(voiceId);
    if (!send) return;
    try {
      send.disconnect();
    } catch {
      /* voice already gone */
    }
    this.muffleSends.delete(voiceId);
  }
}
