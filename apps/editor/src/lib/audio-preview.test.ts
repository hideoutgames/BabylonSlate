import { describe, expect, it } from "vitest";
import { createDefaultAudioPayload } from "@babylonslate/assets";
import { FakeAudioPlaybackBackend } from "@babylonslate/render";
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
        await new Promise((resolve) => setTimeout(resolve, 20));
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
    expect(backend.playbackRates.get("preview")).toBe(2);
    expect(result).toMatchObject({ ok: true, clipChunkId: "source", pitch: 2 });
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
    session.play(createDefaultAudioPayload());
    expect(ended).toBe(0);
    backend.finish("preview");
    expect(ended).toBe(1);
    backend.finish("preview");
    expect(ended).toBe(1);
    session.dispose();
  });
});
