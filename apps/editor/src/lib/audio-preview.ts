import {
  normalizeAudioPayload,
  pickWeightedAudioClip,
  resolveAudioPitch,
  type AudioPayload,
} from "@babylonslate/assets";
import { attachAudioLifecycle, type AudioPlaybackBackend } from "@babylonslate/render";

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
  let sequence = 0;
  let disposed = false;
  const lifecycle = attachAudioLifecycle(options.backend);
  const warm = options.backend.warmAsync();
  void warm.catch(() => {
    if (!disposed) options.onError?.({ code: "audio.engine_unavailable", message: "Audio preview is unavailable." });
  });

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
      await warm;
      const audio = normalizeAudioPayload(payload);
      for (const clip of audio.clips) {
        const bytes = await options.readChunk(clip.chunkId);
        if (disposed) return;
        if (bytes && bytes.byteLength > 0) cache.set(clip.chunkId, bytes);
      }
    },
    clipBytes(chunkId: string) {
      return cache.get(chunkId);
    },
    play(payload: AudioPayload | Record<string, unknown>): AudioPreviewPlayResult {
      if (disposed) return { ok: false, code: "audio.preview_disposed", message: "Audio preview is closed." };
      lifecycle.resumeFromGesture();
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
      const id = `preview-${++sequence}`;
      voiceId = id;
      const failed = () => {
        if (voiceId !== id || disposed) return;
        stop();
        options.onError?.({ code: "audio.play_failed", message: "Audio playback failed; preview stopped." });
      };
      void options.backend.unlockAsync().catch(failed);
      const playWork = options.backend.play({
        voiceId: id,
        assetGuid: "preview",
        source: bytes,
        gain: audio.volume,
        loop: audio.loop,
        spatial: null,
        reverbSend: false,
        clipChunkId: clip.chunkId,
      });
      void playWork.then(() => {
        if (voiceId !== id || disposed) {
          options.backend.stop(id);
          return;
        }
        options.backend.setVoicePlaybackRate(id, pitch);
      }).catch(failed);
      return {
        ok: true,
        voiceId: id,
        clipChunkId: clip.chunkId,
        pitch,
      };
    },
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      lifecycle.dispose();
      options.backend.onVoiceEnded = null;
      cache.clear();
      options.backend.dispose();
    },
  };
}
