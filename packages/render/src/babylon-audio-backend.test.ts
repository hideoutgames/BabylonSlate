import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const audio = vi.hoisted(() => {
  class Context {
    state = "suspended";
    resume = vi.fn(async () => { this.state = "running"; });
    suspend = vi.fn(async () => { this.state = "suspended"; });
    createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
    createBiquadFilter = vi.fn(() => ({ type: "", frequency: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }));
  }
  const context = new Context();
  const engine = { _audioContext: context, mainOut: { _inNode: { connect: vi.fn() } },
    unlockAsync: vi.fn(async () => {}), dispose: vi.fn() };
  const sound = () => ({
    play: vi.fn(), stop: vi.fn(), dispose: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    volume: 1, _outNode: { connect: vi.fn() }, onEndedObservable: { addOnce: vi.fn() },
  });
  return { Context, context, engine, sound,
    createEngine: vi.fn(async () => engine),
    createBus: vi.fn(async () => ({ dispose: vi.fn() })),
    createBuffer: vi.fn(async (source: ArrayBuffer) => ({ length: source.byteLength, channelCount: 1 })),
    createSound: vi.fn(async () => sound()),
  };
});
vi.mock("@babylonjs/core/AudioV2", () => ({
  CreateAudioEngineAsync: audio.createEngine,
  CreateAudioBusAsync: audio.createBus,
  CreateSoundBufferAsync: audio.createBuffer,
  CreateSoundAsync: audio.createSound,
}));
import { createDefaultAudioPayload } from "@haptic/assets";
import { AudioService } from "./audio-service";
import { BabylonAudioPlaybackBackend } from "./babylon-audio-backend";

const request = { voiceId: "voice", assetGuid: "audio", source: new Uint8Array([1]), gain: 1, loop: false, reverbSend: false };

describe("Babylon audio backend lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("AudioContext", audio.Context);
    audio.context.state = "suspended";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("resumes WebKit's interrupted audio context", async () => {
    const backend = new BabylonAudioPlaybackBackend();
    await backend.warmAsync();
    expect(audio.createEngine).toHaveBeenCalledWith(expect.objectContaining({ resumeOnPause: false }));
    audio.context.state = "interrupted";
    backend.resumeContext();
    expect(audio.context.state).toBe("running");
    backend.dispose();
  });

  it("recovers the context even when live voices support pause and resume", async () => {
    const backend = new BabylonAudioPlaybackBackend();
    await backend.play(request);
    backend.setPaused(true);
    audio.context.state = "interrupted";
    backend.setPaused(false);
    expect(audio.context.state).toBe("running");
    backend.dispose();
  });

  it("uses each selected clip's bytes rather than reusing the first preview buffer", async () => {
    const backend = new BabylonAudioPlaybackBackend();
    await backend.play({ ...request, clipChunkId: "first" });
    await backend.play({ ...request, clipChunkId: "second", source: new Uint8Array([2]) });
    expect(audio.createBuffer).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(audio.createBuffer.mock.calls[1]![0] as ArrayBuffer)).toEqual(new Uint8Array([2]));
    backend.dispose();
  });

  it("resumes voices at their clip offset, wrapping loops and ending finished one-shots", async () => {
    audio.createBuffer.mockImplementationOnce(async (source: ArrayBuffer) => ({ length: source.byteLength, channelCount: 1, duration: 2 }));
    const backend = new BabylonAudioPlaybackBackend();
    const ended: string[] = [];
    backend.onVoiceEnded = (voiceId) => ended.push(voiceId);
    await backend.play({ ...request, voiceId: "loop", loop: true, startOffsetSeconds: 5 });
    await backend.play({ ...request, voiceId: "once", startOffsetSeconds: 0.5 });
    await backend.play({ ...request, voiceId: "done", startOffsetSeconds: 3 });
    const sounds = await Promise.all(audio.createSound.mock.results.map((result) => result.value as ReturnType<typeof audio.sound>));
    expect(audio.createSound.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["loop", "once"]);
    expect(sounds.map((sound) => sound.play.mock.calls[0])).toEqual([[{ startOffset: 1 }], [{ startOffset: 0.5 }]]);
    expect(ended).toEqual(["done"]);
    backend.dispose();
  });

  it("muffles a voice by lowering its dry level while the lowpass send keeps the low band", async () => {
    const backend = new BabylonAudioPlaybackBackend();
    await backend.play({ ...request, gain: 0.8 });
    const sound = await (audio.createSound.mock.results[0]!.value as Promise<ReturnType<typeof audio.sound>>);
    backend.setVoiceMuffle(request.voiceId, 0.5);
    const send = audio.context.createGain.mock.results[0]!.value as { gain: { value: number } };
    // Dry 0.4 plus the lowpassed 0.4 keeps the low band at the requested 0.8.
    expect(sound.volume).toBeCloseTo(0.4);
    expect(send.gain.value).toBeCloseTo(1);
    backend.setVoiceGain(request.voiceId, 0.6);
    expect(sound.volume).toBeCloseTo(0.3);
    backend.setVoiceMuffle(request.voiceId, 0);
    expect(sound.volume).toBeCloseTo(0.6);
    expect(send.gain.value).toBe(0);
    backend.dispose();
  });

  it("catches restored voices up by the audio clock time they waited for the unlock: a passed one-shot ends, a loop wraps", async () => {
    audio.createBuffer.mockImplementationOnce(async (source: ArrayBuffer) => ({ length: source.byteLength, channelCount: 1, duration: 2 }));
    const ended: string[] = [];
    const service = new AudioService({ backend: new BabylonAudioPlaybackBackend(), onVoiceEnded: (voiceId) => ended.push(voiceId) });
    service.setLibrary({ mixerGuid: null, mixers: new Map(), channels: new Map(), attenuations: new Map(),
      audio: new Map([["clip", createDefaultAudioPayload()]]) });
    service.setSourceBytes("clip", new Uint8Array([1]));
    const restored = { type: "playSound", assetGuid: "clip", volume: 1, frameId: 1, startOffsetSeconds: 0.5, restoredAtSeconds: 10 } as const;
    service.handleCommand({ ...restored, voiceId: "once" });
    service.handleCommand({ ...restored, voiceId: "loop", loop: true });
    service.handleCommand({ type: "audioSimTime", seconds: 11.75 });
    await service.unlockAsync();
    // 0.5 s + 1.75 s waited in the 2 s clip.
    expect(audio.createSound.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["loop"]);
    const sound = await (audio.createSound.mock.results[0]!.value as Promise<ReturnType<typeof audio.sound>>);
    expect(sound.play.mock.calls).toEqual([[{ startOffset: 0.25 }]]);
    expect(ended).toEqual(["once"]);
    service.dispose();
  });

  it("does not start a sound when Stop arrives during native sound creation", async () => {
    let finish!: (sound: ReturnType<typeof audio.sound>) => void;
    audio.createSound.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const backend = new BabylonAudioPlaybackBackend();
    const playing = backend.play(request);
    await vi.waitFor(() => expect(audio.createSound).toHaveBeenCalled());
    backend.stop(request.voiceId);
    const sound = audio.sound();
    finish(sound);
    await playing;
    expect(sound.play).not.toHaveBeenCalled();
    expect(sound.dispose).toHaveBeenCalledOnce();
    backend.dispose();
  });

  it("disposes an engine that finishes creating after the preview closes", async () => {
    let finish!: (engine: typeof audio.engine) => void;
    audio.createEngine.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const backend = new BabylonAudioPlaybackBackend();
    const warming = backend.warmAsync();
    const rejected = expect(warming).rejects.toThrow(/disposed/i);
    backend.dispose();
    finish(audio.engine);
    await rejected;
    expect(audio.engine.dispose).toHaveBeenCalledOnce();
  });
});
