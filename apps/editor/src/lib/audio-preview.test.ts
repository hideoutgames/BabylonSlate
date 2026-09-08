import { describe, expect, it } from "vitest";
import { createDefaultAudioPayload } from "@babylonslate/assets";
import { FakeAudioPlaybackBackend } from "@babylonslate/render/audio-playback-backend";
import {
  createAudioPreviewSession,
  stopAudioPreviewElement,
} from "./audio-preview";

describe("stopAudioPreviewElement", () => {
  it("pauses and resets the element so Stop is not a silent toggle", () => {
    const element = {
      pause: () => {
        element.paused = true;
      },
      paused: false,
      currentTime: 1.25,
    };
    stopAudioPreviewElement(element);
    expect(element.paused).toBe(true);
    expect(element.currentTime).toBe(0);
  });
});

describe("createAudioPreviewSession", () => {
  it("plays cached clip bytes on the same turn as Play without reading storage", async () => {
    const backend = new FakeAudioPlaybackBackend();
    let reads = 0;
    const session = createAudioPreviewSession({
      backend,
      readChunk: async () => {
        reads += 1;
        return new Uint8Array([1, 2, 3]);
      },
      random: () => 0,
    });
    await session.prefetch(createDefaultAudioPayload());
    expect(reads).toBe(1);
    const result = session.play({
      ...createDefaultAudioPayload(),
      volume: 0.5,
      pitch: 2,
    });
    expect(reads).toBe(1);
    expect(backend.plays).toHaveLength(1);
    expect(backend.plays[0]?.source).toEqual(new Uint8Array([1, 2, 3]));
    expect(backend.plays[0]?.clipChunkId).toBe("source");
    expect(backend.plays[0]?.gain).toBe(0.5);
    expect(backend.plays[0]?.loop).toBe(false);
    await Promise.resolve();
    expect(backend.playbackRates.get(result.voiceId!)).toBe(2);
    expect(result).toMatchObject({ ok: true, clipChunkId: "source", pitch: 2 });
    session.dispose();
  });

  it("diagnoses a cache miss instead of awaiting storage on Play", () => {
    const backend = new FakeAudioPlaybackBackend();
    const session = createAudioPreviewSession({
      backend,
      readChunk: async () => new Uint8Array([1]),
    });
    const result = session.play(createDefaultAudioPayload());
    expect(result.ok).toBe(false);
    expect(result.code).toBe("audio.preview_missing_source");
    expect(backend.plays).toHaveLength(0);
    session.dispose();
  });

  it("warms the audio engine before the first preview gesture", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const session = createAudioPreviewSession({ backend, readChunk: async () => new Uint8Array([1]) });
    await session.prefetch(createDefaultAudioPayload());
    expect(backend.engineCreateCount).toBe(1);
    session.dispose();
  });

  it("pauses preview through native interruptions and app backgrounding", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const session = createAudioPreviewSession({ backend, readChunk: async () => new Uint8Array([1]) });
    window.dispatchEvent(new CustomEvent("babylonslate:audiointerruption", { detail: { type: "began" } }));
    expect(backend.paused).toBe(true);
    window.dispatchEvent(new CustomEvent("babylonslate:appstate", { detail: { isActive: false } }));
    window.dispatchEvent(new CustomEvent("babylonslate:audiointerruption", { detail: { type: "ended", shouldResume: true } }));
    expect(backend.paused).toBe(true);
    window.dispatchEvent(new CustomEvent("babylonslate:appstate", { detail: { isActive: true } }));
    expect(backend.paused).toBe(false);
    session.dispose();
    window.dispatchEvent(new CustomEvent("babylonslate:audiointerruption", { detail: { type: "began" } }));
    expect(backend.paused).toBe(false);
  });

  it("stops a voice that finishes preparing after Stop", async () => {
    const backend = new FakeAudioPlaybackBackend();
    let finish!: () => void;
    backend.play = (request) => new Promise<void>((resolve) => {
      finish = () => { backend.plays.push(request); resolve(); };
    });
    const session = createAudioPreviewSession({ backend, readChunk: async () => new Uint8Array([1]) });
    await session.prefetch(createDefaultAudioPayload());
    const result = session.play(createDefaultAudioPayload());
    session.stop();
    backend.stopped = [];
    finish();
    await Promise.resolve();
    expect(backend.stopped).toContain(result.voiceId);
    session.dispose();
  });

  it("sets pitch after asynchronous voice creation", async () => {
    const backend = new FakeAudioPlaybackBackend();
    let finish!: () => void;
    backend.play = () => new Promise<void>((resolve) => { finish = resolve; });
    const session = createAudioPreviewSession({ backend, readChunk: async () => new Uint8Array([1]) });
    await session.prefetch(createDefaultAudioPayload());
    const result = session.play({ ...createDefaultAudioPayload(), pitch: 2 });
    backend.playbackRates.clear();
    finish();
    await Promise.resolve();
    expect(backend.playbackRates.get(result.voiceId!)).toBe(2);
    session.dispose();
  });

  it("passes asset loop into backend.play", async () => {
    const backend = new FakeAudioPlaybackBackend();
    const session = createAudioPreviewSession({
      backend,
      readChunk: async () => new Uint8Array([1, 2, 3]),
    });
    await session.prefetch(createDefaultAudioPayload());
    session.play({ ...createDefaultAudioPayload(), loop: true });
    expect(backend.plays[0]?.loop).toBe(true);
    session.dispose();
  });

  it("notifies onEnded when the Fake backend finishes a non-looping voice", async () => {
    const backend = new FakeAudioPlaybackBackend();
    let ended = 0;
    const session = createAudioPreviewSession({
      backend,
      readChunk: async () => new Uint8Array([1, 2, 3]),
      onEnded: () => {
        ended += 1;
      },
    });
    await session.prefetch(createDefaultAudioPayload());
    const playing = session.play(createDefaultAudioPayload());
    expect(ended).toBe(0);
    backend.finish(playing.voiceId!);
    expect(ended).toBe(1);
    backend.finish(playing.voiceId!);
    expect(ended).toBe(1);
    session.dispose();
  });
});
