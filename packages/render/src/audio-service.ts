import {
  AUDIO_MAX_CONCURRENT_VOICES,
  AUDIO_PRE_UNLOCK_QUEUE_CAP,
  clampAudioGain,
  computeAttenuationGain,
  createDefaultAudioPayload,
  decodeAudioReverbChunk,
  interpolateAudioReverb,
  isDryAudioReverbFallback,
  normalizeAudioPayload,
  resolveAudioPlayback,
  type AudioChannelPayload,
  type AudioMixerPayload,
  type AudioPayload,
  type AudioReverbField,
  type SoundAttenuationPayload,
} from "@babylonslate/assets";
import type { CommandMessage } from "@babylonslate/bridge";
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
  emitterActorGuid: string | null;
  spatial: AudioSpatialPlayOptions | null;
  gain: number;
  reverbSend: boolean;
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
  private library: AudioLibrary = emptyLibrary();
  private readonly sourceBytes = new Map<string, Uint8Array>();
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

  constructor(options: {
    backend: AudioPlaybackBackend;
    cache?: AudioBufferCache;
    onDiagnostic?: (diagnostic: AudioDiagnostic) => void;
  }) {
    this.backend = options.backend;
    this.ownedCache = !options.cache;
    this.cache = options.cache ?? new AudioBufferCache();
    this.onDiagnostic = options.onDiagnostic;
    this.publishStats();
  }

  setLibrary(library: AudioLibrary): void {
    this.library = library;
    this.sessionChannelVolumes.clear();
    this.sessionGlobalVolume = null;
  }

  setSourceBytes(assetGuid: string, bytes: Uint8Array): void {
    this.sourceBytes.set(assetGuid, bytes);
  }

  setReverbField(bytes: Uint8Array | null | undefined): void {
    this.reverbField = bytes ? decodeAudioReverbChunk(bytes) : null;
    this.refreshReverbWet();
  }

  noteActorSlot(actorGuid: string, slotId: number): void {
    this.actorSlots.set(actorGuid, slotId);
  }

  handleCommand(command: CommandMessage): void {
    if (!isAudioCommand(command)) return;
    if (!this.unlocked) {
      if (this.queue.length >= AUDIO_PRE_UNLOCK_QUEUE_CAP) this.queue.shift();
      this.queue.push(command);
      this.publishStats();
      return;
    }
    this.work = this.work.catch(() => undefined).then(() => this.dispatch(command));
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
    this.refreshSpatialVoices();
    this.refreshReverbWet();
  }

  syncSnapshot(
    actors: ReadonlyArray<{ slotId: number; position: AudioPose }>,
  ): void {
    this.slotPoses.clear();
    for (const actor of actors) {
      this.slotPoses.set(actor.slotId, actor.position);
    }
    this.refreshSpatialVoices();
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
    this.publishStats();
  }

  private async dispatch(command: QueuedCommand): Promise<void> {
    if (command.type === "setChannelVolume") {
      this.sessionChannelVolumes.set(
        command.channelGuid,
        clampAudioGain(command.volume),
      );
      return;
    }
    if (command.type === "setGlobalVolume") {
      this.sessionGlobalVolume = clampAudioGain(command.volume);
      return;
    }
    if (command.type === "stopSound") {
      this.stopVoice(command.voiceId);
      return;
    }
    await this.play(command);
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
    const source = this.sourceBytes.get(assetGuid) ?? this.cache.get(assetGuid);
    if (!source || source.byteLength === 0) {
      this.onDiagnostic?.({
        code: "audio.missing_source",
        message: "Audio source bytes are missing; playback skipped.",
        assetGuid,
      });
      return;
    }
    let decoded = this.cache.get(assetGuid);
    if (!decoded) {
      try {
        const result = await this.backend.decode(assetGuid, source);
        this.cache.put(assetGuid, source, result.pcmBytes);
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
      loop: command.loop === true,
      spatial,
      reverbSend: resolved.environmentReverb,
    };
    this.cache.pin(assetGuid);
    this.voices.set(voiceId, {
      voiceId,
      assetGuid,
      emitterActorGuid: emitter,
      spatial,
      gain: resolved.gain,
      reverbSend: resolved.environmentReverb,
    });
    this.lastGain = resolved.gain;
    try {
      await this.backend.play(request);
    } catch {
      this.stopVoice(voiceId);
      this.onDiagnostic?.({
        code: "audio.play_failed",
        message: "Audio playback failed; game continues.",
        assetGuid,
      });
      return;
    }
    this.refreshSpatialVoices();
    this.refreshReverbWet();
    this.publishStats();
  }

  private stopVoice(voiceId: string): void {
    const voice = this.voices.get(voiceId);
    if (!voice) return;
    this.backend.stop(voiceId);
    this.voices.delete(voiceId);
    this.cache.unpin(voice.assetGuid);
    this.refreshReverbWet();
    this.publishStats();
  }

  private refreshSpatialVoices(): void {
    for (const voice of this.voices.values()) {
      if (!voice.spatial) continue;
      const slotId =
        voice.emitterActorGuid !== null
          ? this.actorSlots.get(voice.emitterActorGuid)
          : undefined;
      const pose =
        slotId !== undefined ? this.slotPoses.get(slotId) : undefined;
      if (!pose) {
        this.lastDistance = null;
        continue;
      }
      this.backend.setVoicePose(voice.voiceId, pose);
      const dx = pose.x - this.listener.x;
      const dy = pose.y - this.listener.y;
      const dz = pose.z - this.listener.z;
      this.lastDistance = Math.hypot(dx, dy, dz);
      const attenuation = this.library.audio.get(voice.assetGuid);
      const attenGuid = attenuation?.soundAttenuationGuid;
      const settings = attenGuid
        ? this.library.attenuations.get(attenGuid)
        : undefined;
      if (settings) {
        const spatialGain = computeAttenuationGain(this.lastDistance, settings);
        this.backend.setVoiceGain(voice.voiceId, voice.gain * spatialGain);
      }
    }
    this.publishStats();
  }

  private refreshReverbWet(): void {
    const anySend = [...this.voices.values()].some((voice) => voice.reverbSend);
    if (!anySend || isDryAudioReverbFallback(this.reverbField)) {
      this.wet = 0;
    } else {
      this.wet = interpolateAudioReverb(
        this.listener,
        this.reverbField?.probes ?? [],
      );
    }
    this.backend.setReverbWet(this.wet);
    this.publishStats();
  }

  private publishStats(): void {
    audioStats.unlocked = this.unlocked;
    audioStats.queued = this.queue.length;
    audioStats.voices = this.voices.size;
    audioStats.lastGain = this.lastGain;
    audioStats.lastDistance = this.lastDistance;
    audioStats.wet = this.wet;
    audioStats.accountedBytes = this.cache.accountedBytes();
  }
}
