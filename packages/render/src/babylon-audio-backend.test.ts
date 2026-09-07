import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const audio = vi.hoisted(() => {
  class Context {
    state = "suspended";
    resume = vi.fn(async () => { this.state = "running"; });
    suspend = vi.fn(async () => { this.state = "suspended"; });
  }
  const context = new Context();
  const engine = { _audioContext: context, unlockAsync: vi.fn(async () => {}), dispose: vi.fn() };
  const sound = () => ({
    play: vi.fn(), stop: vi.fn(), dispose: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    onEndedObservable: { addOnce: vi.fn() },
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
