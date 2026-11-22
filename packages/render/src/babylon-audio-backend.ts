import {
  CreateAudioBusAsync,
  CreateAudioEngineAsync,
  CreateSoundAsync,
  CreateSoundBufferAsync,
  CreateStreamingSoundAsync,
  type AudioBus,
  type AudioEngineV2,
  type StaticSound,
  type StaticSoundBuffer,
  type StreamingSound,
} from "@babylonjs/core/AudioV2";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  AUDIO_MUFFLE_LOWPASS_HZ,
  AUDIO_SHARED_REVERB_BUSES,
  mimeForAudioBytes,
} from "@haptic/assets";
import type {
  AudioPlaybackBackend,
  AudioPlayRequest,
  AudioPose,
  AudioSpatialPlayOptions,
} from "./audio-playback-backend";
import {
  connectParametricReverb,
  type ParametricReverbGraph,
} from "./parametric-reverb";

type LiveAudioSound = StaticSound | StreamingSound;

function sourceBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function releaseMediaElement(element: HTMLAudioElement): void {
  try {
    element.pause();
  } catch {
    /* tearing down */
  }
  try {
    element.removeAttribute?.("src");
  } catch {
    /* tearing down */
  }
  try {
    element.load?.();
  } catch {
    /* tearing down */
  }
}

function revokeObjectUrlSafely(url: string): void {
  try {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(url);
    }
  } catch {
    /* tearing down */
  }
}

/**
 * Largest share of a voice's high band a wall can remove (-20 dB). The lowpass
 * send restores the low band by `muffle / (1 - muffle)`, which must stay finite.
 */
const MAX_VOICE_MUFFLE = 0.9;

function hasRotation(pose: AudioPose): pose is AudioPose & { qx: number; qy: number; qz: number; qw: number } {
  return pose.qx !== undefined && pose.qy !== undefined && pose.qz !== undefined && pose.qw !== undefined;
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
  private readonly voices = new Map<string, LiveAudioSound>();
  /** Managed media elements for streamed voices so playbackRate works and stop() releases WebKit decoders. */
  private readonly streamedElements = new Map<string, HTMLAudioElement>();
  /** Blob URLs created directly by this backend (when callers omit sourceUrl); revoked on stop/dispose. */
  private readonly ownedStreamUrls = new Map<string, string>();
  private readonly muffleSends = new Map<string, GainNode>();
  /** Requested gain, distance gain and applied muffle per live voice; all three set its volume. */
  private readonly voiceLevels = new Map<string, { gain: number; attenuation: number; muffle: number }>();
  private muffleFilter: BiquadFilterNode | null = null;
  private paused = false;
  /** Voices a game pause holds; they stay paused when the whole backend resumes. */
  private readonly pausedVoices = new Set<string>();
  private disposed = false;
  private readonly pendingVoices = new Map<string, symbol>();
  /** Live voices created with a panner; only these take poses. */
  private readonly spatialVoices = new Set<string>();
  onVoiceEnded: ((voiceId: string) => void) | null = null;

  async warmAsync(): Promise<void> {
    await this.ensureEngine();
  }

  async unlockAsync(): Promise<void> {
    this.resumeAudioContext();
    const engine = this.engine ?? (await this.ensureEngine());
    this.resumeAudioContext();
    await engine.unlockAsync();
  }

  async decode(
    assetGuid: string,
    bytes: Uint8Array,
  ): Promise<{ pcmBytes: number }> {
    const engine = await this.ensureEngine();
    const buffer = await CreateSoundBufferAsync(sourceBuffer(bytes), {}, engine);
    if (this.disposed) {
      (buffer as { dispose?: () => void }).dispose?.();
      throw new Error("Audio backend disposed");
    }
    this.buffers.set(assetGuid, buffer);
    return {
      pcmBytes: Math.max(1, buffer.length * buffer.channelCount * 4),
    };
  }

  async play(request: AudioPlayRequest): Promise<void> {
    // A voice paused before it starts (`setVoicePaused`) keeps its hold: it starts paused.
    this.releaseVoice(request.voiceId);
    const pending = Symbol();
    this.pendingVoices.set(request.voiceId, pending);
    try {
      await this.startVoice(request, () => !this.disposed && this.pendingVoices.get(request.voiceId) === pending);
    } finally {
      // Started, superseded or failed (a rejected decode or sound creation): the request is no longer pending.
      if (this.pendingVoices.get(request.voiceId) === pending) this.pendingVoices.delete(request.voiceId);
    }
  }

  private async startVoice(request: AudioPlayRequest, isCurrent: () => boolean): Promise<void> {
    const engine = await this.ensureEngine();
    if (!isCurrent()) return;
    const spatial = request.spatial?.enabled ? request.spatial : null;
    const attenuation = request.attenuation ?? 1;
    // AudioV2 gives a sound a panner when any spatial option is defined, so a non-spatial voice (music, UI) gets none.
    const spatialOptions = spatial
      ? {
          spatialEnabled: true,
          // No per-voice requestAnimationFrame loop: `setVoicePose` writes the pose and pushes it with `spatial.update()`.
          spatialAutoUpdate: false,
          // The panner only pans: with rolloff 0 every distance model is 1, and the service applies
          // `computeAttenuationGain` (silent at Max Radius) through `setVoiceAttenuation`.
          spatialDistanceModel: "linear" as DistanceModelType,
          spatialRolloffFactor: 0,
          spatialPanningModel: (spatial.spatialisation === "hrtf" ? "HRTF" : "equalpower") as PanningModelType,
          // Placed before it plays, so its first sample is not panned from the origin.
          ...(request.pose
            ? {
                spatialPosition: new Vector3(request.pose.x, request.pose.y, request.pose.z),
                ...(hasRotation(request.pose)
                  ? { spatialRotationQuaternion: new Quaternion(request.pose.qx, request.pose.qy, request.pose.qz, request.pose.qw) }
                  : {}),
              }
            : {}),
          ...(spatial.cone
            ? {
                spatialConeInnerAngle: degreesToRadians(spatial.cone.innerAngle),
                spatialConeOuterAngle: degreesToRadians(spatial.cone.outerAngle),
                spatialConeOuterVolume: spatial.cone.outerGain,
              }
            : {}),
        }
      : {};
    const commonOptions = {
      volume: request.gain * attenuation,
      loop: request.loop,
      maxInstances: 1,
      ...spatialOptions,
      outBus: request.reverbSend ? this.reverbBus : null,
    };

    if (request.playbackMode === "streamed") {
      let url = request.sourceUrl?.trim() ?? "";
      let ownedUrl: string | null = null;
      if (!url) {
        if (request.source.byteLength === 0) {
          throw new Error("Streamed audio request has neither sourceUrl nor bytes.");
        }
        const mime = request.mimeType ?? mimeForAudioBytes(request.source);
        ownedUrl = URL.createObjectURL(new Blob([sourceBuffer(request.source)], { type: mime }));
        url = ownedUrl;
      }
      const element = new Audio();
      element.crossOrigin = "anonymous";
      element.loop = request.loop;
      element.preload = "auto";
      element.src = url;
      let sound: StreamingSound;
      try {
        sound = await CreateStreamingSoundAsync(
          request.voiceId,
          element,
          { ...commonOptions, preloadCount: 1 },
          engine,
        );
      } catch (error) {
        releaseMediaElement(element);
        if (ownedUrl) revokeObjectUrlSafely(ownedUrl);
        throw error;
      }
      if (!isCurrent()) {
        sound.dispose();
        releaseMediaElement(element);
        if (ownedUrl) revokeObjectUrlSafely(ownedUrl);
        return;
      }
      this.pendingVoices.delete(request.voiceId);
      this.voices.set(request.voiceId, sound);
      if (spatial) this.spatialVoices.add(request.voiceId);
      this.streamedElements.set(request.voiceId, element);
      if (ownedUrl) this.ownedStreamUrls.set(request.voiceId, ownedUrl);
      this.voiceLevels.set(request.voiceId, { gain: request.gain, attenuation, muffle: 0 });
      sound.onEndedObservable.addOnce(() => {
        this.onVoiceEnded?.(request.voiceId);
      });
      sound.play();
      if (this.paused || this.pausedVoices.has(request.voiceId)) this.pauseSound(sound);
      return;
    }

    const cacheKey = request.cacheKey ?? (request.clipChunkId ? `${request.assetGuid}:${request.clipChunkId}` : request.assetGuid);
    let buffer = this.buffers.get(cacheKey);
    if (!buffer) {
      buffer = await CreateSoundBufferAsync(
        sourceBuffer(request.source),
        {},
        engine,
      );
      if (this.disposed) {
        (buffer as { dispose?: () => void }).dispose?.();
        return;
      }
      this.buffers.set(cacheKey, buffer);
    }
    if (!isCurrent()) return;
    const sound = await CreateSoundAsync(
      request.voiceId,
      buffer,
      commonOptions,
      engine,
    );
    if (!isCurrent()) {
      sound.dispose();
      return;
    }
    this.pendingVoices.delete(request.voiceId);
    this.voices.set(request.voiceId, sound);
    if (spatial) this.spatialVoices.add(request.voiceId);
    this.voiceLevels.set(request.voiceId, { gain: request.gain, attenuation, muffle: 0 });
    sound.onEndedObservable.addOnce(() => {
      this.onVoiceEnded?.(request.voiceId);
    });
    sound.play();
    if (this.paused || this.pausedVoices.has(request.voiceId)) this.pauseSound(sound);
  }

  stop(voiceId: string): void {
    // A stopped voice played again starts unpaused.
    this.pausedVoices.delete(voiceId);
    this.releaseVoice(voiceId);
  }

  /** Stops and releases a voice, keeping whether the game holds it paused. */
  private releaseVoice(voiceId: string): void {
    this.pendingVoices.delete(voiceId);
    this.disposeMuffleSend(voiceId);
    this.voiceLevels.delete(voiceId);
    this.spatialVoices.delete(voiceId);
    const element = this.streamedElements.get(voiceId);
    if (element) this.streamedElements.delete(voiceId);
    const ownedUrl = this.ownedStreamUrls.get(voiceId);
    if (ownedUrl) this.ownedStreamUrls.delete(voiceId);
    const sound = this.voices.get(voiceId);
    if (sound) {
      this.voices.delete(voiceId);
      try {
        sound.stop();
        sound.dispose();
      } finally {
        if (element) releaseMediaElement(element);
        if (ownedUrl) revokeObjectUrlSafely(ownedUrl);
      }
      return;
    }
    if (element) releaseMediaElement(element);
    if (ownedUrl) revokeObjectUrlSafely(ownedUrl);
  }

  setVoiceGain(voiceId: string, gain: number): void {
    const level = this.voiceLevels.get(voiceId);
    if (!level) return;
    level.gain = gain;
    this.applyVoiceLevel(voiceId);
  }

  setVoiceAttenuation(voiceId: string, gain: number): boolean {
    const level = this.voiceLevels.get(voiceId);
    if (!level) return false;
    // A gain that is not a number is silence, never full volume.
    level.attenuation = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 0;
    this.applyVoiceLevel(voiceId);
    return true;
  }

  setVoiceSpatial(voiceId: string, options: AudioSpatialPlayOptions): boolean {
    const sound = this.voices.get(voiceId);
    if (!sound || !this.spatialVoices.has(voiceId)) return false;
    const spatial = sound.spatial;
    spatial.panningModel = options.spatialisation === "hrtf" ? "HRTF" : "equalpower";
    // No cone is a full circle at both angles, which never lowers the volume.
    spatial.coneInnerAngle = options.cone ? degreesToRadians(options.cone.innerAngle) : 2 * Math.PI;
    spatial.coneOuterAngle = options.cone ? degreesToRadians(options.cone.outerAngle) : 2 * Math.PI;
    spatial.coneOuterVolume = options.cone ? options.cone.outerGain : 0;
    spatial.update();
    return true;
  }

  setVoicePose(voiceId: string, pose: AudioPose): boolean {
    const sound = this.voices.get(voiceId);
    // Reading `spatial` on a non-spatial sound would give it a panner.
    if (!sound || !this.spatialVoices.has(voiceId)) return false;
    const spatial = sound.spatial;
    spatial.position.set(pose.x, pose.y, pose.z);
    if (hasRotation(pose)) spatial.rotationQuaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
    // In-place writes reach the panner only through `update()` (auto-update is off).
    spatial.update();
    return true;
  }

  setVoicePlaybackRate(voiceId: string, rate: number): boolean {
    const element = this.streamedElements.get(voiceId);
    if (element) {
      (element as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = false;
      element.playbackRate = rate;
      return true;
    }
    const sound = this.voices.get(voiceId);
    if (!sound) return false;
    (sound as StaticSound).playbackRate = rate;
    return true;
  }

  setListenerPose(pose: AudioPose): boolean {
    const listener = this.engine?.listener;
    if (!listener) return false;
    listener.position.set(pose.x, pose.y, pose.z);
    if (
      pose.qx !== undefined &&
      pose.qy !== undefined &&
      pose.qz !== undefined &&
      pose.qw !== undefined
    ) {
      listener.rotationQuaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
    }
    // In-place writes reach the AudioContext listener only through `update()` (auto-update is off).
    listener.update();
    return true;
  }

  setReverbWet(wet: number): void {
    this.setReverbProfile({ wet, decay: 0.4, damping: 0.5 });
  }

  setReverbProfile(profile: {
    wet: number;
    decay: number;
    damping: number;
  }): boolean {
    if (this.reverbGraph) {
      this.reverbGraph.setProfile(profile);
      return true;
    }
    if (!this.reverbBus) return false;
    this.reverbBus.volume = profile.wet;
    return true;
  }

  setVoiceMuffle(voiceId: string, factor: number): boolean {
    const sound = this.voices.get(voiceId);
    const level = this.voiceLevels.get(voiceId);
    if (!sound || !level) return false;
    const amount = Number.isFinite(factor) ? Math.min(MAX_VOICE_MUFFLE, Math.max(0, factor)) : 0;
    if (amount > 0 && !this.muffleSends.has(voiceId)) {
      const out = webAudioPort(sound, "_outNode");
      const filter = this.ensureMuffleFilter();
      const context = this.audioContext;
      // Without the lowpass send, lowering the dry level would only make it quieter.
      if (!out || !filter || !context) return false;
      const send = context.createGain();
      send.gain.value = 0;
      out.connect(send);
      send.connect(filter);
      this.muffleSends.set(voiceId, send);
    }
    level.muffle = this.muffleSends.has(voiceId) ? amount : 0;
    this.applyVoiceLevel(voiceId);
    return true;
  }

  /**
   * The send taps the voice after its volume and AudioV2's dry route stays
   * connected, so muffling lowers the dry level (the high band) by the factor
   * while the lowpass send brings the low band back to the requested gain.
   * The distance gain scales the voice before every route (dry, muffle send and
   * reverb bus), as the panner's distance model did. AudioV2 ramps each volume
   * write over its parameter ramp (10 ms), so per-snapshot changes do not click.
   */
  private applyVoiceLevel(voiceId: string): void {
    const sound = this.voices.get(voiceId);
    const level = this.voiceLevels.get(voiceId);
    if (!sound || !level) return;
    sound.volume = level.gain * level.attenuation * (1 - level.muffle);
    const send = this.muffleSends.get(voiceId);
    if (send) send.gain.value = level.muffle / (1 - level.muffle);
  }

  setPaused(paused: boolean): void {
    if (!paused) this.resumeAudioContext();
    if (this.paused === paused) return;
    this.paused = paused;
    let usedSoundPause = false;
    for (const [voiceId, sound] of this.voices) {
      if (paused) usedSoundPause = this.pauseSound(sound) || usedSoundPause;
      else if (!this.pausedVoices.has(voiceId)) usedSoundPause = this.resumeSound(sound) || usedSoundPause;
    }
    if (usedSoundPause) return;
    const ctx = this.audioContext;
    if (!ctx) return;
    if (paused) void ctx.suspend().catch(() => { /* The next lifecycle event can retry. */ });
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
    if (this.disposed) return;
    this.disposed = true;
    this.pendingVoices.clear();
    this.pausedVoices.clear();
    for (const voiceId of [...this.voices.keys()]) {
      try {
        this.stop(voiceId);
      } catch {
        this.voices.delete(voiceId);
      }
    }
    for (const element of this.streamedElements.values()) {
      releaseMediaElement(element);
    }
    this.streamedElements.clear();
    for (const url of this.ownedStreamUrls.values()) {
      revokeObjectUrlSafely(url);
    }
    this.ownedStreamUrls.clear();
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
    this.paused = false;
  }

  resumeContext(): void {
    const ctx = this.audioContext;
    if (!ctx || this.disposed) return;
    // WebKit also exposes "interrupted", outside older DOM typings.
    if (ctx.state !== "running" && ctx.state !== "closed") {
      void ctx.resume().catch(() => { /* A later user gesture may be required. */ });
    }
  }

  private resumeAudioContext(): void {
    this.resumeContext();
  }

  setVoicePaused(voiceId: string, paused: boolean): void {
    if (paused) this.pausedVoices.add(voiceId);
    else this.pausedVoices.delete(voiceId);
    // A whole-backend pause holds every voice; its resume applies the held set.
    if (this.paused) return;
    const sound = this.voices.get(voiceId);
    if (!sound) return;
    if (paused) this.pauseSound(sound);
    else this.resumeSound(sound);
  }

  private pauseSound(sound: LiveAudioSound): boolean {
    if (typeof sound.pause !== "function") return false;
    try {
      sound.pause();
      return true;
    } catch {
      return false;
    }
  }

  private resumeSound(sound: LiveAudioSound): boolean {
    if (typeof sound.resume !== "function") return false;
    try {
      sound.resume();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureEngine(): Promise<AudioEngineV2> {
    if (this.disposed) throw new Error("Audio backend disposed");
    if (this.engine) return this.engine;
    if (this.creating) return this.creating;
    this.creating = this.createEngine();
    try {
      const engine = await this.creating;
      if (this.disposed) {
        engine.dispose();
        throw new Error("Audio backend disposed");
      }
      this.engine = engine;
      return this.engine;
    } finally {
      this.creating = null;
    }
  }

  private async createEngine(): Promise<AudioEngineV2> {
    const engine = await CreateAudioEngineAsync({
      disableDefaultUI: true,
      resumeOnInteraction: false,
      resumeOnPause: false,
      listenerEnabled: true,
      // `setListenerPose` pushes each pose, so the listener runs no requestAnimationFrame loop either.
      listenerAutoUpdate: false,
    });
    if (this.disposed) {
      engine.dispose();
      throw new Error("Audio backend disposed");
    }
    this.audioContext = engineAudioContext(engine);
    for (let i = 0; i < AUDIO_SHARED_REVERB_BUSES; i += 1) {
      const bus = await CreateAudioBusAsync(
        i === 0 ? "environmentReverb" : `environmentReverb-${i}`,
        {
          volume: 1,
          ...(engine.defaultMainBus ? { outBus: engine.defaultMainBus } : {}),
        },
        engine,
      );
      if (this.disposed) {
        bus.dispose();
        engine.dispose();
        throw new Error("Audio backend disposed");
      }
      this.reverbBus = bus;
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
      this.reverbGraph = connectParametricReverb(context, busOut, mainIn);
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
