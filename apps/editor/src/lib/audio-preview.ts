import {
  normalizeAudioPayload,
  pickWeightedAudioClip,
  resolveAudioPitch,
  type AudioPayload,
} from "@babylonslate/assets";
import type { AudioPlaybackBackend } from "@babylonslate/render";

export function stopAudioPreviewElement(element: {
  pause(): void;
  currentTime: number;
}): void {
  element.pause();
  element.currentTime = 0;
}

export type AudioPreviewPlayResult = {
  ok: boolean;
  voiceId?: string;
  clipChunkId?: string;
  pitch?: number;
  code?: string;
  message?: string;
};

export type AudioPreviewSession = {
  prefetch(payload: AudioPayload | Record<string, unknown>): Promise<void>;
  play(payload: AudioPayload | Record<string, unknown>): AudioPreviewPlayResult;
  clipBytes(chunkId: string): Uint8Array | undefined;
  stop(): void;
  dispose(): void;
};

const PREVIEW_VOICE_ID = "preview";

export function createAudioPreviewSession(options: {
  backend: AudioPlaybackBackend;
  readChunk: (chunkId: string) => Promise<Uint8Array | null | undefined>;
  random?: () => number;
  onError?: (error: { code: string; message: string }) => void;
  onEnded?: () => void;
}): AudioPreviewSession {
  const cache = new Map<string, Uint8Array>();
  const random = options.random ?? Math.random;
  let voiceId: string | null = null;

  const stop = () => {
    if (!voiceId) return;
    const id = voiceId;
    voiceId = null;
    options.backend.stop(id);
  };

  options.backend.onVoiceEnded = (id) => {
    if (voiceId !== id) return;
    voiceId = null;
    options.backend.stop(id);
    options.onEnded?.();
  };

  return {
    async prefetch(payload: AudioPayload | Record<string, unknown>) {
      const audio = normalizeAudioPayload(payload);
      for (const clip of audio.clips) {
        const bytes = await options.readChunk(clip.chunkId);
        if (bytes && bytes.byteLength > 0) cache.set(clip.chunkId, bytes);
      }
    },
    clipBytes(chunkId: string) {
      return cache.get(chunkId);
    },
    play(payload: AudioPayload | Record<string, unknown>): AudioPreviewPlayResult {
      void options.backend.unlockAsync();
      const audio = normalizeAudioPayload(payload);
      const clip = pickWeightedAudioClip(audio.clips, random);
      const bytes = cache.get(clip.chunkId);
      if (!bytes) {
        return {
          ok: false,
          code: "audio.preview_missing_source",
          message: "Audio preview has no cached clip bytes.",
        };
      }
      const pitch = resolveAudioPitch(audio, random);
      stop();
      voiceId = PREVIEW_VOICE_ID;
      const playWork = options.backend.play({
        voiceId: PREVIEW_VOICE_ID,
        assetGuid: "preview",
        source: bytes,
        gain: audio.volume,
        loop: audio.loop,
        spatial: null,
        reverbSend: false,
        clipChunkId: clip.chunkId,
      });
      options.backend.setVoicePlaybackRate(PREVIEW_VOICE_ID, pitch);
      void playWork.catch(() => {
        stop();
        options.onError?.({
          code: "audio.play_failed",
          message: "Audio playback failed; preview stopped.",
        });
      });
      return {
        ok: true,
        voiceId: PREVIEW_VOICE_ID,
        clipChunkId: clip.chunkId,
        pitch,
      };
    },
    stop,
    dispose() {
      stop();
      cache.clear();
      options.backend.dispose();
    },
  };
}
