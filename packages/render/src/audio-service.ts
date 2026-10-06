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
import type { NativePreparationPriority, NativePreparationScheduler } from "./native-preparation";
import { attachAudioLifecycle } from "./audio-lifecycle";
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
  revision?: string;
}) => Promise<Uint8Array | null | undefined>;
export type AudioAssetPreparer = (guid: string, request: { consumer: string; signal: AbortSignal }) => Promise<() => void>;

export type AudioLibrary = {
  mixerGuid: string | null;
  mixers: ReadonlyMap<string, AudioMixerPayload>;
  channels: ReadonlyMap<string, AudioChannelPayload>;
  audio: ReadonlyMap<string, AudioPayload>;
  attenuations: ReadonlyMap<string, SoundAttenuationPayload>;
  /** Registry/container revision, including the clip hashes. Live voices keep their generation. */
  sourceRevisions?: ReadonlyMap<string, string>;
};

export type AudioStats = {
  unlocked: boolean;
  queued: number;
  voices: number;
  lastGain: number | null;
  lastDistance: number | null;
  wet: number;
  accountedBytes: number;
  inFlightBytes?: number;
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
  | { type: "setVoiceGain" }
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
  releaseSource?: () => void;
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
    command.type === "setVoiceGain" ||
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
  private readonly onVoiceEnded?: (voiceId: string) => void;
  private readonly onAssetReady?: (guid: string) => void;
  private readonly loadSourceBytes?: AudioSourceBytesLoader;
  private readonly prepareAsset?: AudioAssetPreparer;
  private readonly preparation?: NativePreparationScheduler;
  private readonly decodeController = new AbortController();
  private readonly preparingVoices = new Map<string, AbortController>();
  private maxVoices: number;
  private library: AudioLibrary = emptyLibrary();
  private readonly sourceBytes = new Map<string, Uint8Array>();
  private readonly decodedLoads = new Map<string, Promise<Uint8Array>>();
  private readonly retiredClipKeys = new Set<string>();
  private readonly sourceLoads = new Map<string, Promise<Uint8Array | null>>();
  private readonly sessionChannelVolumes = new Map<string, number>();
  private readonly actorSlots = new Map<string, number>();
  private readonly slotPoses = new Map<number, AudioPose>();
  private readonly voices = new Map<string, LiveVoice>();
  private queue: QueuedCommand[] = [];
  private unlocked = false;
  private unlocking: Promise<void> | null = null;
  private work: Promise<void> = Promise.resolve();
  private generation = 0;
  private disposed = false;
  private sessionGlobalVolume: number | null = null;
  private readonly lifecycle: ReturnType<typeof attachAudioLifecycle>;
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
    onVoiceEnded?: (voiceId: string) => void;
    onAssetReady?: (guid: string) => void;
    loadSourceBytes?: AudioSourceBytesLoader;
    prepareAsset?: AudioAssetPreparer;
    preparation?: NativePreparationScheduler;
    now?: () => number;
    random?: () => number;
    maxVoices?: number;
    lifecycleTarget?: EventTarget;
  }) {
    this.backend = options.backend;
    this.ownedCache = !options.cache;
    this.cache = options.cache ?? new AudioBufferCache();
    this.maxVoices = Math.max(1, options.maxVoices ?? AUDIO_MAX_CONCURRENT_VOICES);
    this.cache.addEvictListener((guid) => this.releaseEvictedClip(guid));
    this.onDiagnostic = options.onDiagnostic;
    this.onVoiceEnded = options.onVoiceEnded;
    this.onAssetReady = options.onAssetReady;
    this.loadSourceBytes = options.loadSourceBytes;
    this.prepareAsset = options.prepareAsset;
    this.preparation = options.preparation;
    this.now = options.now ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.lifecycle = attachAudioLifecycle(this.backend, options.lifecycleTarget);
    this.backend.onVoiceEnded = (voiceId) => {
      const voice = this.voices.get(voiceId);
      if (!voice || voice.loop) return;
      this.stopVoice(voiceId);
      this.onVoiceEnded?.(voiceId);
    };
    this.publishStats();
    void this.backend.warmAsync().catch(() => undefined);
  }

  setLibrary(library: AudioLibrary, preserveSession = false): void {
    for (const [guid, payload] of this.library.audio) if (!library.audio.has(guid) ||
      this.library.sourceRevisions?.get(guid) !== library.sourceRevisions?.get(guid)) {
      this.sourceBytes.delete(guid);
      for (const clip of normalizeAudioPayload(payload).clips) {
        const key = this.clipKey(guid, clip.chunkId);
        this.sourceBytes.delete(key);
        const removed = this.cache.removeUnreferenced(key);
        if (!removed || this.decodedLoads.has(key)) this.retiredClipKeys.add(key);
      }
    }
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
    for (const [guid, audio] of this.library.audio) for (const clip of normalizeAudioPayload(audio).clips)
      this.retiredClipKeys.delete(this.clipKey(guid, clip.chunkId));
    if (!preserveSession) {
      this.sessionChannelVolumes.clear();
      this.sessionGlobalVolume = null;
    }
  }

  private clipKey(guid: string, chunkId: string): string {
    const key = audioClipCacheKey(guid, chunkId);
    const revision = this.library.sourceRevisions?.get(guid);
    return revision ? JSON.stringify([key, revision]) : key;
  }

  /** Decode all authored clip choices without starting voices; the preload pins their buffers. */
  async preload(assetGuids: readonly string[], priority: NativePreparationPriority = "preload"): Promise<() => void> {
    const keys: string[] = [];
    const release = () => { for (const key of keys.splice(0)) this.unpinClip(key); };
    try {
      for (const guid of assetGuids) {
        const audio = this.library.audio.get(guid);
        if (!audio) throw new Error(`Audio ${guid} is unavailable.`);
        for (const clip of normalizeAudioPayload(audio).clips) {
          const key = this.clipKey(guid, clip.chunkId);
          const source = await this.resolveSourceBytes(guid, clip.chunkId, key);
          if (!source?.byteLength) throw new Error(`Audio ${guid}, chunk ${clip.chunkId}: source bytes are missing.`);
          await this.ensureDecoded(key, source, priority);
          if (key !== this.clipKey(guid, clip.chunkId) || !this.library.audio.has(guid))
            throw new Error(`Audio ${guid} changed during preload; retry the request.`);
          if (this.disposed) throw new Error("Audio preparation was disposed.");
          this.cache.pin(key);
          keys.push(key);
        }
      }
      return release;
    } catch (error) { release(); throw error; }
  }

  private ensureDecoded(cacheKey: string, source: Uint8Array, priority: NativePreparationPriority = "gameplay"): Promise<Uint8Array> {
    const cached = this.cache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    const pending = this.decodedLoads.get(cacheKey);
    if (pending) return pending;
    const estimate = this.backend.estimateDecodedBytes?.(source) ?? Math.max(1024 * 1024, source.byteLength * 64);
    let reservation: ReturnType<AudioBufferCache["reserveDecode"]> | undefined;
    const decode = async () => {
      if (this.disposed) throw new Error("Audio preparation was disposed.");
      reservation = this.cache.reserveDecode(estimate);
      this.publishStats();
      return this.backend.decode(cacheKey, source);
    };
    const loading = Promise.resolve().then(() => this.preparation
      ? this.preparation.schedule({ label: `Audio ${cacheKey}`, temporaryBytes: estimate + source.byteLength,
        signal: this.decodeController.signal, priority }, decode) : decode()).then((result) => {
      if (this.disposed) { this.backend.disposeBuffer(cacheKey); throw new Error("Audio preparation was disposed."); }
      if (this.retiredClipKeys.has(cacheKey)) {
        this.backend.disposeBuffer(cacheKey);
        this.retiredClipKeys.delete(cacheKey);
        throw new Error("Audio source changed during decoding; retry the request.");
      }
      try { reservation!.resize(result.pcmBytes); }
      catch (error) { this.backend.disposeBuffer(cacheKey); throw error; }
      reservation!.release();
      this.cache.put(cacheKey, source, result.pcmBytes);
      return source;
    }).finally(() => {
      reservation?.release();
      if (this.decodedLoads.get(cacheKey) === loading) this.decodedLoads.delete(cacheKey);
      this.publishStats();
    });
    this.decodedLoads.set(cacheKey, loading);
    return loading;
  }

  private unpinClip(key: string): void {
    this.cache.unpin(key);
    if (this.retiredClipKeys.has(key)) this.cache.removeUnreferenced(key);
  }

  setSourceBytes(assetGuid: string, bytes: Uint8Array): void {
    this.sourceBytes.set(this.library.sourceRevisions?.has(assetGuid)
      ? this.clipKey(assetGuid, AUDIO_DEFAULT_SOURCE_CHUNK) : assetGuid, bytes);
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
    if (command.type === "stopSound") this.preparingVoices.get(command.voiceId)?.abort(new Error("Audio voice stopped during loading."));
    if (this.disposed) return;
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
    const generation = this.generation;
    this.work = this.work.catch(() => undefined).then(() => this.dispatch(command, generation));
  }

  setShowAudioDebug(enabled: boolean): void {
    this.showAudioDebug = enabled === true;
    this.publishStats();
  }

  setPaused(paused: boolean): void {
    this.lifecycle.setPaused(paused);
  }

  setAudioBudget(bytes: number, enabled: boolean): void {
    this.cache.setByteCeiling(bytes);
    this.cache.setBudgetEnabled(enabled);
  }

  setMaxVoices(maxVoices: number): void {
    if (!Number.isFinite(maxVoices)) return;
    this.maxVoices = Math.max(1, Math.round(maxVoices));
    this.stealToCap();
  }

  private releaseEvictedClip(cacheKey: string): void {
    this.backend.disposeBuffer(cacheKey);
    this.sourceBytes.delete(cacheKey);
    this.retiredClipKeys.delete(cacheKey);
  }

  private stealToCap(): void {
    while (this.voices.size > this.maxVoices) {
      const oldest = this.voices.keys().next().value;
      if (!oldest) break;
      this.stopVoice(oldest);
    }
  }

  /** Wait until in-flight play/stop work has settled (tests). */
  async flush(): Promise<void> {
    await this.work;
  }

  async unlockAsync(): Promise<void> {
    if (this.disposed) return;
    this.lifecycle.resumeFromGesture();
    if (this.unlocked) return;
    if (this.unlocking) return this.unlocking;
    this.unlocking = this.backend.unlockAsync().then(async () => {
      if (this.disposed) return;
      this.unlocked = true;
      const generation = this.generation;
      const pending = this.queue;
      this.queue = [];
      this.publishStats();
      for (const command of pending) {
        this.work = this.work.catch(() => undefined).then(() => this.dispatch(command, generation));
      }
      await this.work;
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
    this.generation++;
    for (const controller of this.preparingVoices.values()) controller.abort(new Error("Audio session changed during loading."));
    this.preparingVoices.clear();
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
    if (this.disposed) return;
    this.disposed = true;
    this.decodeController.abort(new Error("Audio session was disposed."));
    for (const controller of this.preparingVoices.values()) controller.abort(new Error("Audio session was disposed."));
    this.preparingVoices.clear();
    this.generation++;
    this.lifecycle.dispose();
    for (const voiceId of [...this.voices.keys()]) {
      this.stopVoice(voiceId);
    }
    this.queue = [];
    this.sourceBytes.clear();
    this.sourceLoads.clear();
    this.decodedLoads.clear();
    this.retiredClipKeys.clear();
    this.library = emptyLibrary();
    this.reverbField = null;
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

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private async dispatch(command: QueuedCommand, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
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
    if (command.type === "setVoiceGain") {
      const voice = this.voices.get(command.voiceId);
      if (!voice) return;
      voice.playCallVolume = clampAudioGain(command.volume);
      this.refreshVoiceGains();
      return;
    }
    await this.play(command, generation);
  }

  private async resolveSourceBytes(
    assetGuid: string,
    chunkId: string,
    cacheKey: string,
  ): Promise<Uint8Array | null> {
    const revision = this.library.sourceRevisions?.get(assetGuid);
    const cached =
      this.sourceBytes.get(cacheKey) ??
      (chunkId === AUDIO_DEFAULT_SOURCE_CHUNK && !revision ? this.sourceBytes.get(assetGuid) : undefined) ??
      this.cache.get(cacheKey) ??
      (chunkId === AUDIO_DEFAULT_SOURCE_CHUNK && !revision ? this.cache.get(assetGuid) : undefined);
    if (cached && cached.byteLength > 0) return cached;
    if (!this.loadSourceBytes) return cached ?? null;
    const inflight = this.sourceLoads.get(cacheKey);
    if (inflight) return inflight;
    const load = this.loadSourceBytes({ assetGuid, chunkId, ...(revision ? { revision } : {}) })
      .then((bytes) => {
        if (this.disposed) return null;
        if (this.clipKey(assetGuid, chunkId) !== cacheKey || this.retiredClipKeys.has(cacheKey))
          throw new Error(`Audio ${assetGuid} changed during its source read; retry the request.`);
        if (!bytes || bytes.byteLength === 0) return null;
        this.setSourceBytes(cacheKey, bytes);
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
    generation: number,
  ): Promise<void> {
    if (!this.prepareAsset) return this.playPrepared(command, generation);
    const voiceId = command.voiceId?.trim() || `voice-${++this.voiceSeq}`;
    const controller = new AbortController();
    this.preparingVoices.get(voiceId)?.abort(new Error("Audio voice replaced during loading."));
    this.preparingVoices.set(voiceId, controller);
    const owned = { transferred: false, release: undefined as (() => void) | undefined, signal: controller.signal };
    let abort!: () => void;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
      });
      const acquire = this.prepareAsset(command.assetGuid, { consumer: command.emitterActorGuid ?? `Audio voice ${voiceId}`, signal: controller.signal }).then((release) => {
        if (controller.signal.aborted || !this.isCurrent(generation)) { release(); throw new Error("Audio source preparation was cancelled."); }
        owned.release = release;
      });
      await Promise.race([acquire, cancelled]);
      controller.signal.throwIfAborted();
      await this.playPrepared({ ...command, voiceId }, generation, owned);
    } catch (error) {
      if (!controller.signal.aborted && this.isCurrent(generation)) this.onDiagnostic?.({
        code: "audio.load_failed", assetGuid: command.assetGuid,
        message: `Audio ${command.assetGuid}: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      controller.signal.removeEventListener("abort", abort);
      if (this.preparingVoices.get(voiceId) === controller) this.preparingVoices.delete(voiceId);
      if (!owned.transferred) owned.release?.();
    }
  }

  private async playPrepared(
    command: Extract<CommandMessage, { type: "playSound" }>, generation: number,
    sourceOwner?: { transferred: boolean; release?: () => void; signal?: AbortSignal },
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
    const cacheKey = this.clipKey(assetGuid, clip.chunkId);
    const source = await this.resolveSourceBytes(assetGuid, clip.chunkId, cacheKey);
    if (!this.isCurrent(generation) || sourceOwner?.signal?.aborted || cacheKey !== this.clipKey(assetGuid, clip.chunkId) || this.retiredClipKeys.has(cacheKey)) return;
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
        decoded = await this.ensureDecoded(cacheKey, source);
        if (this.disposed) return;
        if (!this.isCurrent(generation)) {
          return;
        }
      } catch (error) {
        if (!this.isCurrent(generation)) return;
        this.onDiagnostic?.({
          code: /budget/i.test(String(error)) ? "audio.budget_exceeded" : "audio.decode_failed",
          message: `Audio ${assetGuid} failed to prepare: ${error instanceof Error ? error.message : String(error)}`,
          assetGuid,
        });
        return;
      }
    }
    if (!this.isCurrent(generation) || sourceOwner?.signal?.aborted || cacheKey !== this.clipKey(assetGuid, clip.chunkId) || this.retiredClipKeys.has(cacheKey)) return;
    // Transfer the pin before stopping a replaced voice; unpin may evict now.
    this.cache.pin(cacheKey);
    const voiceId = command.voiceId?.trim() || `voice-${++this.voiceSeq}`;
    this.stopVoice(voiceId);
    if (this.voices.size >= this.maxVoices) {
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
      cacheKey,
      gain: resolved.gain,
      loop: command.loop === true || payload.loop === true,
      spatial,
      reverbSend: resolved.environmentReverb,
      clipChunkId: clip.chunkId,
    };
    this.voices.set(voiceId, {
      voiceId,
      assetGuid,
      cacheKey,
      releaseSource: sourceOwner?.release,
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
    if (sourceOwner) sourceOwner.transferred = true;
    this.lastGain = resolved.gain;
    try {
      await this.backend.play(request);
      if (!this.isCurrent(generation)) return;
      this.onAssetReady?.(assetGuid);
      this.backend.setVoicePlaybackRate(voiceId, pitch);
    } catch {
      if (!this.isCurrent(generation)) return;
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
    try { this.backend.stop(voiceId); }
    finally {
      this.unpinClip(voice.cacheKey);
      voice.releaseSource?.();
    }
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
    audioStats.inFlightBytes = this.cache.reservedBytes();
    audioStats.debugVoices = this.showAudioDebug
      ? this.collectDebugVoices()
      : undefined;
  }
}
