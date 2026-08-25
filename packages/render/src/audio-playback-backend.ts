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
  distanceModel: "linear" | "inverse" | "exponential";
  rolloff: number;
  spatialisation: "equalPower" | "hrtf";
  cone?: { innerAngle: number; outerAngle: number; outerGain: number } | null;
  doppler?: { enabled: boolean; factor: number } | null;
};

export type AudioPlayRequest = {
  voiceId: string;
  assetGuid: string;
  source: Uint8Array;
  gain: number;
  loop: boolean;
  spatial?: AudioSpatialPlayOptions | null;
  reverbSend: boolean;
  clipChunkId?: string;
};

export interface AudioPlaybackBackend {
  /** Create the AudioV2 engine (suspended) before the first gesture. */
  warmAsync(): Promise<void>;
  unlockAsync(): Promise<void>;
  isUnlocked(): boolean;
  decode(assetGuid: string, bytes: Uint8Array): Promise<{ pcmBytes: number }>;
  play(request: AudioPlayRequest): Promise<void>;
  stop(voiceId: string): void;
  setVoiceGain(voiceId: string, gain: number): void;
  setVoicePose(voiceId: string, pose: AudioPose): void;
  setVoicePlaybackRate(voiceId: string, rate: number): void;
  setListenerPose(pose: AudioPose): void;
  setReverbWet(wet: number): void;
  setReverbProfile(profile: {
    wet: number;
    decay: number;
    damping: number;
  }): void;
  setVoiceMuffle(voiceId: string, factor: number): void;
  /** Pause or resume live voices without stopping them. */
  setPaused(paused: boolean): void;
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
  plays: AudioPlayRequest[] = [];
  stopped: string[] = [];
  poses = new Map<string, AudioPose>();
  gains = new Map<string, number>();
  playbackRates = new Map<string, number>();
  muffles = new Map<string, number>();
  listener: AudioPose = { x: 0, y: 0, z: 0 };
  wet = 0;
  decay = 0.4;
  damping = 0.5;
  disposed = false;
  disposedBuffers: string[] = [];
  onVoiceEnded: ((voiceId: string) => void) | null = null;

  isUnlocked(): boolean {
    return this.unlocked;
  }

  async warmAsync(): Promise<void> {
    if (this.engineCreateCount === 0) this.engineCreateCount = 1;
  }

  async unlockAsync(): Promise<void> {
    this.unlocked = true;
  }

  async decode(_assetGuid: string, bytes: Uint8Array): Promise<{ pcmBytes: number }> {
    return { pcmBytes: bytes.byteLength };
  }

  async play(request: AudioPlayRequest): Promise<void> {
    this.plays.push(request);
  }

  stop(voiceId: string): void {
    this.stopped.push(voiceId);
  }

  setVoiceGain(voiceId: string, gain: number): void {
    this.gains.set(voiceId, gain);
  }

  setVoicePose(voiceId: string, pose: AudioPose): void {
    this.poses.set(voiceId, pose);
  }

  setVoicePlaybackRate(voiceId: string, rate: number): void {
    this.playbackRates.set(voiceId, rate);
  }

  setListenerPose(pose: AudioPose): void {
    this.listener = pose;
  }

  setReverbWet(wet: number): void {
    this.wet = wet;
  }

  setReverbProfile(profile: {
    wet: number;
    decay: number;
    damping: number;
  }): void {
    this.wet = profile.wet;
    this.decay = profile.decay;
    this.damping = profile.damping;
  }

  setVoiceMuffle(voiceId: string, factor: number): void {
    this.muffles.set(voiceId, factor);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
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
