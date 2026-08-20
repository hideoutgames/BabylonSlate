import {
  AUDIO_MAX_CONCURRENT_VOICES,
  AUDIO_PRE_UNLOCK_QUEUE_CAP,
  AUDIO_DEFAULT_SOURCE_CHUNK,
  clampAudioGain,
  computeDopplerPlaybackRate,
  createDefaultAudioPayload,
  decodeAudioReverbChunk,
  interpolateAudioReverb,
  isDryAudioReverbFallback,
  normalizeAudioPayload,
  occlusionFactor,
  pickWeightedAudioClip,
  resolveAudioPitch,
  audioClipCacheKey,
  resolveAudioPlayback,
  sanitizeAudioLibrary,
  type AudioChannelPayload,
  type AudioMixerPayload,
  type AudioPayload,
  type AudioReverbField,
  type SoundAttenuationPayload,
} from "@babylonslate/assets";
import type { CommandMessage } from "@babylonslate/bridge";
import type { AudioDebugVoiceSnapshot } from "./audio-debug";
import { AudioBufferCache } from "./audio-buffer-cache";
import type {
  AudioPlaybackBackend,
  AudioPlayRequest,
  AudioPose,
  AudioSpatialPlayOptions,
} from "./audio-playback-backend";

export type AudioDiagnostic = {
  code: string;
  message: string;
  assetGuid?: string;
};

export type AudioSourceBytesLoader = (request: {
  assetGuid: string;
  chunkId: string;
}) => Promise<Uint8Array | null | undefined>;

export type AudioLibrary = {
  mixerGuid: string | null;
  mixers: ReadonlyMap<string, AudioMixerPayload>;
  channels: ReadonlyMap<string, AudioChannelPayload>;
  audio: ReadonlyMap<string, AudioPayload>;
  attenuations: ReadonlyMap<string, SoundAttenuationPayload>;
};

export type AudioStats = {
  unlocked: boolean;
  queued: number;
  voices: number;
  lastGain: number | null;
  lastDistance: number | null;
  wet: number;
  accountedBytes: number;
  debugVoices?: AudioDebugVoiceSnapshot[];
};

export const audioStats: AudioStats = {
  unlocked: false,
  queued: 0,
  voices: 0,
  lastGain: null,
  lastDistance: null,
  wet: 0,
  accountedBytes: 0,
};

type QueuedCommand = Extract<
  CommandMessage,
  | { type: "playSound" }
  | { type: "stopSound" }
  | { type: "setChannelVolume" }
  | { type: "setGlobalVolume" }
>;

type LiveVoice = {
  voiceId: string;
  assetGuid: string;
  cacheKey: string;
  playCallVolume: number;
  emitterActorGuid: string | null;
  spatial: AudioSpatialPlayOptions | null;
  gain: number;
  pitch: number;
  reverbSend: boolean;
  muffleThroughWalls: boolean;
  previousPose: AudioPose | null;
  clipName: string | null;
  loop: boolean;
};

function emptyLibrary(): AudioLibrary {
  return {
    mixerGuid: null,
    mixers: new Map(),
    channels: new Map(),
    audio: new Map(),
    attenuations: new Map(),
  };
}

function isAudioCommand(command: CommandMessage): command is QueuedCommand {
  return (
    command.type === "playSound" ||
    command.type === "stopSound" ||
    command.type === "setChannelVolume" ||
    command.type === "setGlobalVolume"
  );
}

function clampAudioScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 2) return 2;
  return value;
}

function scaleReverbAmount(value: number, scale: number): number {
  const scaled = value * scale;
  if (scaled < 0) return 0;
  if (scaled > 1) return 1;
  return scaled;
}

/**
 * Main-thread AudioV2 owner shared by overlay Play and the exported player.
 * Unit tests inject {@link FakeAudioPlaybackBackend}; browsers use the real
 * Babylon backend.
 */
export class AudioService {
  private readonly backend: AudioPlaybackBackend;
  private readonly cache: AudioBufferCache;
  private readonly ownedCache: boolean;
  private readonly onDiagnostic?: (diagnostic: AudioDiagnostic) => void;
  private readonly loadSourceBytes?: AudioSourceBytesLoader;
  private library: AudioLibrary = emptyLibrary();
  private readonly sourceBytes = new Map<string, Uint8Array>();
  private readonly sourceLoads = new Map<string, Promise<Uint8Array | null>>();
  private readonly sessionChannelVolumes = new Map<string, number>();
  private readonly actorSlots = new Map<string, number>();
  private readonly slotPoses = new Map<number, AudioPose>();
  private readonly voices = new Map<string, LiveVoice>();
  private queue: QueuedCommand[] = [];
  private unlocked = false;
  private unlocking: Promise<void> | null = null;
  private work: Promise<void> = Promise.resolve();
  private sessionGlobalVolume: number | null = null;
  private lastGain: number | null = null;
  private lastDistance: number | null = null;
  private wet = 0;
  private voiceSeq = 0;
  private listener: AudioPose = { x: 0, y: 0, z: 0 };
  private reverbField: AudioReverbField | null = null;
  private readonly now: () => number;
  private lastSnapshotAt: number | null = null;
  private readonly random: () => number;
  private showAudioDebug = false;
  private projectAudio = {
    occlusionEnabled: true,
    reverbWetScale: 1,
    reverbDecayScale: 1,
    reverbDampingScale: 1,
  };

  constructor(options: {
    backend: AudioPlaybackBackend;
    cache?: AudioBufferCache;
    onDiagnostic?: (diagnostic: AudioDiagnostic) => void;
    loadSourceBytes?: AudioSourceBytesLoader;
    now?: () => number;
    random?: () => number;
  }) {
    this.backend = options.backend;
    this.ownedCache = !options.cache;
    this.cache = options.cache ?? new AudioBufferCache();
    this.onDiagnostic = options.onDiagnostic;
    this.loadSourceBytes = options.loadSourceBytes;
    this.now = options.now ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.backend.onVoiceEnded = (voiceId) => {
      const voice = this.voices.get(voiceId);
      if (!voice || voice.loop) return;
      this.stopVoice(voiceId);
    };
    this.publishStats();
    void this.backend.warmAsync().catch(() => undefined);
  }

  setLibrary(library: AudioLibrary): void {
    const sanitized = sanitizeAudioLibrary({
      audio: library.audio,
      channels: library.channels,
      attenuations: library.attenuations,
    });
    for (const diagnostic of sanitized.diagnostics) {
      this.onDiagnostic?.({
        code: diagnostic.code,
        message: diagnostic.message,
        assetGuid: diagnostic.guid,
      });
    }
    this.library = {
      ...library,
      audio: sanitized.audio,
      channels: sanitized.channels,
    };
    this.sessionChannelVolumes.clear();
    this.sessionGlobalVolume = null;
  }

  setSourceBytes(assetGuid: string, bytes: Uint8Array): void {
    this.sourceBytes.set(assetGuid, bytes);
  }

  setReverbField(bytes: Uint8Array | null | undefined): void {
    this.reverbField = bytes ? decodeAudioReverbChunk(bytes) : null;
    this.refreshReverbWet();
    this.refreshSpatialVoices(false);
  }

  setProjectAudioSettings(settings: {
    occlusionEnabled?: boolean;
    reverbWetScale?: number;
    reverbDecayScale?: number;
    reverbDampingScale?: number;
  }): void {
    if (settings.occlusionEnabled !== undefined) {
      this.projectAudio.occlusionEnabled = settings.occlusionEnabled === true;
    }
    if (settings.reverbWetScale !== undefined) {
      this.projectAudio.reverbWetScale = clampAudioScale(settings.reverbWetScale);
    }
    if (settings.reverbDecayScale !== undefined) {
      this.projectAudio.reverbDecayScale = clampAudioScale(
        settings.reverbDecayScale,
      );
    }
    if (settings.reverbDampingScale !== undefined) {
      this.projectAudio.reverbDampingScale = clampAudioScale(
        settings.reverbDampingScale,
      );
    }
    this.refreshSpatialVoices(false);
    this.refreshReverbWet();
  }

  noteActorSlot(actorGuid: string, slotId: number): void {
    this.actorSlots.set(actorGuid, slotId);
  }

  handleCommand(command: CommandMessage): void {
    if (command.type === "setShowAudioDebug") {
      this.setShowAudioDebug(command.enabled);
      return;
    }
    if (!isAudioCommand(command)) return;
    if (!this.unlocked) {
      if (this.queue.length >= AUDIO_PRE_UNLOCK_QUEUE_CAP) this.queue.shift();
      this.queue.push(command);
      this.publishStats();
      return;
    }
    this.work = this.work.catch(() => undefined).then(() => this.dispatch(command));
  }

  setShowAudioDebug(enabled: boolean): void {
    this.showAudioDebug = enabled === true;
    this.publishStats();
  }

  setPaused(paused: boolean): void {
    this.backend.setPaused(paused);
  }

  /** Wait until in-flight play/stop work has settled (tests). */
  async flush(): Promise<void> {
    await this.work;
  }

  async unlockAsync(): Promise<void> {
    if (this.unlocked) return;
    if (this.unlocking) return this.unlocking;
    this.unlocking = this.backend.unlockAsync().then(async () => {
      this.unlocked = true;
      const pending = this.queue;
      this.queue = [];
      this.publishStats();
      for (const command of pending) {
        await this.dispatch(command);
      }
    });
    try {
      await this.unlocking;
    } finally {
      this.unlocking = null;
    }
  }

  syncListener(pose: AudioPose): void {
    this.listener = pose;
    this.backend.setListenerPose(pose);
    if (this.hasSpatialVoices()) this.refreshSpatialVoices(false);
    this.refreshReverbWet();
  }

  syncSnapshot(
    actors: ReadonlyArray<{ slotId: number; position: AudioPose }>,
  ): void {
    this.slotPoses.clear();
    for (const actor of actors) {
      this.slotPoses.set(actor.slotId, actor.position);
    }
    if (this.hasSpatialVoices()) this.refreshSpatialVoices(true);
  }

  hasSpatialVoices(): boolean {
    for (const voice of this.voices.values()) {
      if (voice.spatial) return true;
    }
    return false;
  }

  stats(): AudioStats {
    return { ...audioStats };
  }

  resetSession(): void {
    for (const voiceId of [...this.voices.keys()]) {
      this.stopVoice(voiceId);
    }
    this.sessionChannelVolumes.clear();
    this.sessionGlobalVolume = null;
    this.queue = [];
    this.lastSnapshotAt = null;
    this.lastGain = null;
    this.lastDistance = null;
    this.wet = 0;
    this.backend.setReverbWet(0);
    this.publishStats();
  }

  dispose(): void {
    for (const voiceId of [...this.voices.keys()]) {
      this.stopVoice(voiceId);
    }
    this.queue = [];
    this.sourceBytes.clear();
    this.sourceLoads.clear();
    this.sessionChannelVolumes.clear();
    this.actorSlots.clear();
    this.slotPoses.clear();
    this.backend.dispose();
    this.cache.flushUnreferenced();
    if (this.ownedCache) this.cache.dispose();
    this.unlocked = false;
    this.lastGain = null;
    this.lastDistance = null;
    this.wet = 0;
    this.reverbField = null;
    this.lastSnapshotAt = null;
    this.showAudioDebug = false;
    this.publishStats();
  }

  private async dispatch(command: QueuedCommand): Promise<void> {
    if (command.type === "setChannelVolume") {
      const mixer = this.activeMixer();
      if (!mixer) {
        this.onDiagnostic?.({
          code: "audio.no_mixer",
          message: "Set Channel Volume has no selected mixer.",
        });
        return;
      }
      const known = mixer.channels.some(
        (entry) => entry.channelGuid === command.channelGuid,
      );
      if (!known) {
        this.onDiagnostic?.({
          code: "audio.unknown_channel",
          message: "Set Channel Volume skipped an unknown channel.",
          assetGuid: command.channelGuid,
        });
        return;
      }
      this.sessionChannelVolumes.set(
        command.channelGuid,
        clampAudioGain(command.volume),
      );
      this.refreshVoiceGains();
      return;
    }
    if (command.type === "setGlobalVolume") {
      if (!this.activeMixer()) {
        this.onDiagnostic?.({
          code: "audio.no_mixer",
          message: "Set Global Volume has no selected mixer.",
        });
        return;
      }
      this.sessionGlobalVolume = clampAudioGain(command.volume);
      this.refreshVoiceGains();
      return;
    }
    if (command.type === "stopSound") {
      this.stopVoice(command.voiceId);
      return;
    }
    await this.play(command);
  }

  private async resolveSourceBytes(
    assetGuid: string,
    chunkId: string,
    cacheKey: string,
  ): Promise<Uint8Array | null> {
    const cached =
      this.sourceBytes.get(cacheKey) ??
      this.sourceBytes.get(assetGuid) ??
      this.cache.get(cacheKey) ??
      this.cache.get(assetGuid);
    if (cached && cached.byteLength > 0) return cached;
    if (!this.loadSourceBytes) return cached ?? null;
    const inflight = this.sourceLoads.get(cacheKey);
    if (inflight) return inflight;
    const load = this.loadSourceBytes({ assetGuid, chunkId })
      .then((bytes) => {
        if (!bytes || bytes.byteLength === 0) return null;
        this.setSourceBytes(cacheKey, bytes);
        if (chunkId === AUDIO_DEFAULT_SOURCE_CHUNK) {
          this.setSourceBytes(assetGuid, bytes);
        }
        return bytes;
      })
      .finally(() => {
        this.sourceLoads.delete(cacheKey);
      });
    this.sourceLoads.set(cacheKey, load);
    return load;
  }

  private async play(
    command: Extract<CommandMessage, { type: "playSound" }>,
  ): Promise<void> {
    const assetGuid = command.assetGuid;
    const audio =
      this.library.audio.get(assetGuid) ?? createDefaultAudioPayload();
    const payload = normalizeAudioPayload(audio);
    const mixer = this.library.mixerGuid
      ? (this.library.mixers.get(this.library.mixerGuid) ?? null)
      : null;
    const resolved = resolveAudioPlayback({
      audio: payload,
      playCallVolume: command.volume,
      mixer,
      channels: this.library.channels,
      sessionChannelVolumes: this.sessionChannelVolumes,
      sessionGlobalVolume: this.sessionGlobalVolume,
    });
    const clip = pickWeightedAudioClip(payload.clips, this.random);
    const pitch = resolveAudioPitch(payload, this.random);
    const cacheKey = audioClipCacheKey(assetGuid, clip.chunkId);
    const source = await this.resolveSourceBytes(assetGuid, clip.chunkId, cacheKey);
    if (!source || source.byteLength === 0) {
      this.onDiagnostic?.({
        code: "audio.missing_source",
        message: "Audio source bytes are missing; playback skipped.",
        assetGuid,
      });
      return;
    }
    let decoded = this.cache.get(cacheKey);
    if (!decoded) {
      try {
        const result = await this.backend.decode(cacheKey, source);
        this.cache.put(cacheKey, source, result.pcmBytes);
        decoded = source;
      } catch {
        this.onDiagnostic?.({
          code: "audio.decode_failed",
          message: "Audio failed to decode; playback skipped.",
          assetGuid,
        });
        return;
      }
    }
    const voiceId = command.voiceId?.trim() || `voice-${++this.voiceSeq}`;
    this.stopVoice(voiceId);
    if (this.voices.size >= AUDIO_MAX_CONCURRENT_VOICES) {
      const oldest = this.voices.keys().next().value;
      if (oldest) this.stopVoice(oldest);
    }
    const attenuation = payload.soundAttenuationGuid
      ? (this.library.attenuations.get(payload.soundAttenuationGuid) ?? null)
      : null;
    const emitter = command.emitterActorGuid?.trim() || null;
    let spatial: AudioSpatialPlayOptions | null = attenuation
      ? {
          enabled: true,
          innerRadius: attenuation.innerRadius,
          maxRadius: attenuation.maxRadius,
          distanceModel: attenuation.distanceModel,
          rolloff: attenuation.rolloff,
          spatialisation: attenuation.spatialisation,
          cone: attenuation.cone,
          doppler: attenuation.doppler,
        }
      : null;
    if (attenuation && !emitter) {
      spatial = null;
      this.onDiagnostic?.({
        code: "audio.missing_emitter",
        message: "Spatial Audio has no Actor emitter; playing non-spatial.",
        assetGuid,
      });
    }
    const request: AudioPlayRequest = {
      voiceId,
      assetGuid,
      source: decoded,
      gain: resolved.gain,
      loop: command.loop === true || payload.loop === true,
      spatial,
      reverbSend: resolved.environmentReverb,
      clipChunkId: clip.chunkId,
    };
    this.cache.pin(cacheKey);
    this.voices.set(voiceId, {
      voiceId,
      assetGuid,
      cacheKey,
      playCallVolume: command.volume,
      emitterActorGuid: emitter,
      spatial,
      gain: resolved.gain,
      pitch,
      reverbSend: resolved.environmentReverb,
      muffleThroughWalls: resolved.muffleThroughWalls,
      previousPose: null,
      clipName: clip.name.trim() === "" ? null : clip.name,
      loop: request.loop,
    });
    this.lastGain = resolved.gain;
    try {
      await this.backend.play(request);
      this.backend.setVoicePlaybackRate(voiceId, pitch);
    } catch {
      this.stopVoice(voiceId);
      this.onDiagnostic?.({
        code: "audio.play_failed",
        message: "Audio playback failed; game continues.",
        assetGuid,
      });
      return;
    }
    this.refreshSpatialVoices(false);
    this.refreshReverbWet();
    this.publishStats();
  }

  private stopVoice(voiceId: string): void {
    const voice = this.voices.get(voiceId);
    if (!voice) return;
    this.voices.delete(voiceId);
    this.cache.unpin(voice.cacheKey);
    this.backend.stop(voiceId);
    this.refreshReverbWet();
    this.publishStats();
  }

  private activeMixer(): AudioMixerPayload | null {
    if (!this.library.mixerGuid) return null;
    return this.library.mixers.get(this.library.mixerGuid) ?? null;
  }

  private refreshVoiceGains(): void {
    for (const voice of this.voices.values()) {
      const audio =
        this.library.audio.get(voice.assetGuid) ?? createDefaultAudioPayload();
      const resolved = resolveAudioPlayback({
        audio: normalizeAudioPayload(audio),
        playCallVolume: voice.playCallVolume,
        mixer: this.activeMixer(),
        channels: this.library.channels,
        sessionChannelVolumes: this.sessionChannelVolumes,
        sessionGlobalVolume: this.sessionGlobalVolume,
      });
      voice.gain = resolved.gain;
      voice.reverbSend = resolved.environmentReverb;
      voice.muffleThroughWalls = resolved.muffleThroughWalls;
      this.backend.setVoiceGain(voice.voiceId, resolved.gain);
      this.lastGain = resolved.gain;
    }
    this.refreshReverbWet();
    this.publishStats();
  }

  private refreshSpatialVoices(fromSnapshot: boolean): void {
    const now = this.now();
    const dt =
      fromSnapshot && this.lastSnapshotAt !== null
        ? Math.max(0, (now - this.lastSnapshotAt) / 1000)
        : 0;
    if (fromSnapshot) this.lastSnapshotAt = now;
    for (const voice of this.voices.values()) {
      if (!voice.spatial) {
        this.backend.setVoiceMuffle(voice.voiceId, 0);
        continue;
      }
      const slotId =
        voice.emitterActorGuid !== null
          ? this.actorSlots.get(voice.emitterActorGuid)
          : undefined;
      const pose =
        slotId !== undefined ? this.slotPoses.get(slotId) : undefined;
      if (!pose) {
        this.lastDistance = null;
        this.backend.setVoiceMuffle(voice.voiceId, 0);
        continue;
      }
      this.backend.setVoicePose(voice.voiceId, pose);
      this.refreshVoiceMuffle(voice, pose);
      const dx = pose.x - this.listener.x;
      const dy = pose.y - this.listener.y;
      const dz = pose.z - this.listener.z;
      this.lastDistance = Math.hypot(dx, dy, dz);
      const doppler = voice.spatial.doppler;
      // Doppler uses snapshot dt only. The production render loop calls
      // syncListener after syncSnapshot; a listener refresh must not write
      // playbackRate 1 (dt === 0) over the snapshot result.
      if (doppler?.enabled && fromSnapshot) {
        const rate = computeDopplerPlaybackRate({
          previousEmitter: voice.previousPose,
          emitter: pose,
          listener: this.listener,
          dt,
          factor: doppler.factor,
        });
        this.backend.setVoicePlaybackRate(
          voice.voiceId,
          voice.pitch * rate,
        );
      }
      if (fromSnapshot) {
        voice.previousPose = { x: pose.x, y: pose.y, z: pose.z };
      }
    }
    this.publishStats();
  }

  private refreshVoiceMuffle(voice: LiveVoice, pose: AudioPose): void {
    if (
      !this.projectAudio.occlusionEnabled ||
      !voice.muffleThroughWalls ||
      !voice.spatial
    ) {
      this.backend.setVoiceMuffle(voice.voiceId, 0);
      return;
    }
    this.backend.setVoiceMuffle(
      voice.voiceId,
      occlusionFactor(pose, this.listener, this.reverbField?.occupancy),
    );
  }

  private refreshReverbWet(): void {
    let anySend = false;
    for (const voice of this.voices.values()) {
      if (voice.reverbSend) {
        anySend = true;
        break;
      }
    }
    const profile =
      !anySend || isDryAudioReverbFallback(this.reverbField)
        ? { wet: 0, decay: 0.4, damping: 0.5 }
        : interpolateAudioReverb(this.listener, this.reverbField?.probes ?? []);
    const scaled = {
      wet: scaleReverbAmount(profile.wet, this.projectAudio.reverbWetScale),
      decay: scaleReverbAmount(profile.decay, this.projectAudio.reverbDecayScale),
      damping: scaleReverbAmount(
        profile.damping,
        this.projectAudio.reverbDampingScale,
      ),
    };
    this.wet = scaled.wet;
    this.backend.setReverbProfile(scaled);
    this.publishStats();
  }

  private voiceEmitterPose(voice: LiveVoice): AudioPose | undefined {
    if (voice.emitterActorGuid === null) return undefined;
    const slotId = this.actorSlots.get(voice.emitterActorGuid);
    if (slotId === undefined) return undefined;
    return this.slotPoses.get(slotId);
  }

  private collectDebugVoices(): AudioDebugVoiceSnapshot[] {
    const snapshots: AudioDebugVoiceSnapshot[] = [];
    for (const voice of this.voices.values()) {
      const spatial = voice.spatial !== null;
      const pose = spatial ? this.voiceEmitterPose(voice) : undefined;
      let distance: number | null = null;
      let innerRadius: number | null = null;
      let maxRadius: number | null = null;
      let insideRadius: boolean | null = null;
      if (voice.spatial) {
        innerRadius = voice.spatial.innerRadius;
        maxRadius = voice.spatial.maxRadius;
        if (pose) {
          distance = Math.hypot(
            pose.x - this.listener.x,
            pose.y - this.listener.y,
            pose.z - this.listener.z,
          );
          insideRadius = distance <= maxRadius;
        }
      }
      snapshots.push({
        assetGuid: voice.assetGuid,
        clipName: voice.clipName,
        gain: voice.gain,
        pitch: voice.pitch,
        loop: voice.loop,
        spatial,
        distance,
        innerRadius,
        maxRadius,
        insideRadius,
      });
    }
    return snapshots;
  }

  private publishStats(): void {
    audioStats.unlocked = this.unlocked;
    audioStats.queued = this.queue.length;
    audioStats.voices = this.voices.size;
    audioStats.lastGain = this.lastGain;
    audioStats.lastDistance = this.lastDistance;
    audioStats.wet = this.wet;
    audioStats.accountedBytes = this.cache.accountedBytes();
    audioStats.debugVoices = this.showAudioDebug
      ? this.collectDebugVoices()
      : undefined;
  }
}
