import type { AudioPlaybackMode } from "@haptic/assets";
import type { Curve } from "@haptic/core";

export type AudioPose = {
  x: number;
  y: number;
  z: number;
  qx?: number;
  qy?: number;
  qz?: number;
  qw?: number;
};

export type AudioSpatialPlayOptions = {
  enabled: boolean;
  innerRadius: number;
  maxRadius: number;
  /** The falloff curve between the radii (`computeAttenuationGain`); the service applies it, never the panner. */
  curve: Curve<number>;
  spatialisation: "equalPower" | "hrtf";
  cone?: { innerAngle: number; outerAngle: number; outerGain: number } | null;
  doppler?: { enabled: boolean; factor: number } | null;
};

export type AudioPlayRequest = {
  voiceId: string;
  assetGuid: string;
  source: Uint8Array;
  playbackMode?: AudioPlaybackMode;
  /** Direct stream URL (exported sidecar) or ref-counted Blob URL when streaming. */
  sourceUrl?: string;
  /** Sniffed MIME type when creating a Blob URL from encoded bytes. */
  mimeType?: string;
  gain: number;
  /**
   * A spatial voice's starting distance gain (`computeAttenuationGain` at its pose and the listener's), applied with
   * `gain` from its first sample; 1 when absent. `setVoiceAttenuation` changes it afterwards.
   */
  attenuation?: number;
  loop: boolean;
  /** Pans the voice; its distance falloff is `attenuation`, never the browser panner's distance model. */
  spatial?: AudioSpatialPlayOptions | null;
  /** A spatial voice's pose when it starts, so its first sample is panned from there rather than from the origin. */
  pose?: AudioPose;
  reverbSend: boolean;
  clipChunkId?: string;
  /** Exact decoded source generation; asset identity stays available for diagnostics. */
  cacheKey?: string;
};

export interface AudioPlaybackBackend {
  /** Create the AudioV2 engine (suspended) before the first gesture. */
  warmAsync(): Promise<void>;
  unlockAsync(): Promise<void>;
  decode(assetGuid: string, bytes: Uint8Array): Promise<{ pcmBytes: number }>;
  estimateDecodedBytes?(bytes: Uint8Array): number;
  play(request: AudioPlayRequest): Promise<void>;
  stop(voiceId: string): void;
  setVoiceGain(voiceId: string, gain: number): void;
  /**
   * The pose, playback-rate, listener, reverb and muffle setters return whether the backend now holds the value:
   * false when it had nothing to write to yet (no engine, no such voice, no muffle route). The service resends a
   * value only when it differs from the last one that landed, so a false result must leave the write retryable.
   */
  setVoicePose(voiceId: string, pose: AudioPose): boolean;
  setVoicePlaybackRate(voiceId: string, rate: number): boolean;
  setListenerPose(pose: AudioPose): boolean;
  setReverbWet(wet: number): void;
  setReverbProfile(profile: {
    wet: number;
    decay: number;
    damping: number;
  }): boolean;
  setVoiceMuffle(voiceId: string, factor: number): boolean;
  /** A spatial voice's distance gain (0..1), multiplied with its gain; false when there is no such voice yet. */
  setVoiceAttenuation(voiceId: string, gain: number): boolean;
  /**
   * A live spatial voice's panner settings changed (a Sound Attenuation edit reached the library): apply its
   * spatialisation and cone. False when there is no such spatial voice.
   */
  setVoiceSpatial(voiceId: string, spatial: AudioSpatialPlayOptions): boolean;
  /** Pause or resume live voices without stopping them. */
  setPaused(paused: boolean): void;
  /**
   * Hold or release one voice (game pause). A held voice, or one that starts while held, stays
   * paused when `setPaused(false)` resumes the rest.
   */
  setVoicePaused(voiceId: string, paused: boolean): void;
  /** Resume the audio context even when not explicitly paused (e.g. after an audio route change). */
  resumeContext(): void;
  /** Drop a decoded clip when the PCM LRU evicts it. */
  disposeBuffer(cacheKey: string): void;
  dispose(): void;
  onVoiceEnded: ((voiceId: string) => void) | null;
}

/** In-memory backend for NullEngine unit tests (no Web Audio / AudioV2). */
export class FakeAudioPlaybackBackend implements AudioPlaybackBackend {
  unlocked = false;
  paused = false;
  engineCreateCount = 0;
  decodeCount = 0;
  plays: AudioPlayRequest[] = [];
  stopped: string[] = [];
  poses = new Map<string, AudioPose>();
  gains = new Map<string, number>();
  playbackRates = new Map<string, number>();
  muffles = new Map<string, number>();
  /** Each voice's distance gain: its play request's, then each `setVoiceAttenuation`. */
  attenuations = new Map<string, number>();
  /** Every distance gain each voice took, in order: its play request's, then each `setVoiceAttenuation`. */
  attenuationHistory = new Map<string, number[]>();
  /** Each voice's last `setVoiceSpatial`. */
  spatialUpdates = new Map<string, AudioSpatialPlayOptions>();
  listener: AudioPose = { x: 0, y: 0, z: 0 };
  wet = 0;
  decay = 0.4;
  damping = 0.5;
  disposed = false;
  disposedBuffers: string[] = [];
  onVoiceEnded: ((voiceId: string) => void) | null = null;

  async warmAsync(): Promise<void> {
    if (this.engineCreateCount === 0) this.engineCreateCount = 1;
  }

  async unlockAsync(): Promise<void> {
    this.unlocked = true;
  }

  async decode(_assetGuid: string, bytes: Uint8Array): Promise<{ pcmBytes: number }> {
    this.decodeCount += 1;
    return { pcmBytes: bytes.byteLength };
  }

  estimateDecodedBytes(bytes: Uint8Array): number { return bytes.byteLength; }

  async play(request: AudioPlayRequest): Promise<void> {
    this.plays.push(request);
    if (request.attenuation !== undefined) this.recordAttenuation(request.voiceId, request.attenuation);
  }

  stop(voiceId: string): void {
    this.stopped.push(voiceId);
  }

  setVoiceGain(voiceId: string, gain: number): void {
    this.gains.set(voiceId, gain);
  }

  setVoicePose(voiceId: string, pose: AudioPose): boolean {
    this.poses.set(voiceId, pose);
    return true;
  }

  setVoicePlaybackRate(voiceId: string, rate: number): boolean {
    this.playbackRates.set(voiceId, rate);
    return true;
  }

  setListenerPose(pose: AudioPose): boolean {
    this.listener = pose;
    return true;
  }

  setReverbWet(wet: number): void {
    this.wet = wet;
  }

  setReverbProfile(profile: {
    wet: number;
    decay: number;
    damping: number;
  }): boolean {
    this.wet = profile.wet;
    this.decay = profile.decay;
    this.damping = profile.damping;
    return true;
  }

  setVoiceMuffle(voiceId: string, factor: number): boolean {
    this.muffles.set(voiceId, factor);
    return true;
  }

  setVoiceAttenuation(voiceId: string, gain: number): boolean {
    this.recordAttenuation(voiceId, gain);
    return true;
  }

  private recordAttenuation(voiceId: string, gain: number): void {
    this.attenuations.set(voiceId, gain);
    const history = this.attenuationHistory.get(voiceId) ?? [];
    history.push(gain);
    this.attenuationHistory.set(voiceId, history);
  }

  setVoiceSpatial(voiceId: string, spatial: AudioSpatialPlayOptions): boolean {
    this.spatialUpdates.set(voiceId, spatial);
    return true;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  readonly pausedVoices = new Set<string>();

  setVoicePaused(voiceId: string, paused: boolean): void {
    if (paused) this.pausedVoices.add(voiceId);
    else this.pausedVoices.delete(voiceId);
  }

  resumeContext(): void {
    // No Web Audio context in the fake backend.
  }

  disposeBuffer(cacheKey: string): void {
    this.disposedBuffers.push(cacheKey);
  }

  dispose(): void {
    this.disposed = true;
    this.plays = [];
  }

  finish(voiceId: string): void {
    this.onVoiceEnded?.(voiceId);
  }
}
