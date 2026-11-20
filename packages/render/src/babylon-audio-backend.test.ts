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
    createStreamingSound: vi.fn(async (_name: string, _source: unknown) => sound()),
  };
});
vi.mock("@babylonjs/core/AudioV2", () => ({
  CreateAudioEngineAsync: audio.createEngine,
  CreateAudioBusAsync: audio.createBus,
  CreateSoundBufferAsync: audio.createBuffer,
  CreateSoundAsync: audio.createSound,
  CreateStreamingSoundAsync: audio.createStreamingSound,
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

  it("holds a game-paused voice through a whole-backend resume, and pauses a held voice that starts", async () => {
    const backend = new BabylonAudioPlaybackBackend();
    await backend.play({ ...request, voiceId: "music" });
    await backend.play({ ...request, voiceId: "menu" });
    const [music, menu] = await Promise.all(audio.createSound.mock.results.map((result) => result.value)) as ReturnType<typeof audio.sound>[];
    backend.setVoicePaused("music", true);
    expect(music!.pause).toHaveBeenCalledTimes(1);
    expect(menu!.pause).not.toHaveBeenCalled();
    backend.setPaused(true);
    backend.setPaused(false);
    expect(music!.resume).not.toHaveBeenCalled();
    expect(menu!.resume).toHaveBeenCalledTimes(1);
    backend.setVoicePaused("music", false);
    expect(music!.resume).toHaveBeenCalledTimes(1);
    backend.setVoicePaused("late", true);
    await backend.play({ ...request, voiceId: "late" });
    const late = await audio.createSound.mock.results[2]!.value as ReturnType<typeof audio.sound>;
    expect(late.pause).toHaveBeenCalledTimes(1);
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

  it("reports whether a pose, rate, muffle, listener or reverb write had something to land on", async () => {
    const backend = new BabylonAudioPlaybackBackend();
    // No engine and no voice yet: nothing is held, so the service must offer the value again.
    expect(backend.setReverbProfile({ wet: 0.5, decay: 0.4, damping: 0.5 })).toBe(false);
    expect(backend.setListenerPose({ x: 1, y: 2, z: 3 })).toBe(false);
    expect(backend.setVoiceMuffle(request.voiceId, 0.5)).toBe(false);
    expect(backend.setVoicePlaybackRate(request.voiceId, 2)).toBe(false);
    expect(backend.setVoicePose(request.voiceId, { x: 1, y: 2, z: 3 })).toBe(false);
    await backend.play(request);
    const sound = await (audio.createSound.mock.results[0]!.value as Promise<ReturnType<typeof audio.sound> & { playbackRate?: number }>);
    expect(backend.setVoicePlaybackRate(request.voiceId, 2)).toBe(true);
    expect(sound.playbackRate).toBe(2);
    expect(backend.setVoiceMuffle(request.voiceId, 0.5)).toBe(true);
    expect(sound.volume).toBeCloseTo(0.5);
    expect(backend.setReverbProfile({ wet: 0.5, decay: 0.4, damping: 0.5 })).toBe(true);
    expect(backend.setVoiceMuffle("other", 0.5)).toBe(false);
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

  it("streams without decoding PCM, sets playbackRate on the media element, and releases WebKit decoder state on stop", async () => {
    const createdElements: Array<{
      crossOrigin: string;
      loop: boolean;
      preload: string;
      src: string;
      playbackRate: number;
      preservesPitch: boolean;
      pause: ReturnType<typeof vi.fn>;
      removeAttribute: ReturnType<typeof vi.fn>;
      load: ReturnType<typeof vi.fn>;
    }> = [];
    class FakeAudioElement {
      crossOrigin = "";
      loop = false;
      preload = "";
      src = "";
      playbackRate = 1;
      preservesPitch = true;
      pause = vi.fn();
      removeAttribute = vi.fn((name: string) => { if (name === "src") this.src = ""; });
      load = vi.fn();
      constructor() { createdElements.push(this); }
    }
    vi.stubGlobal("Audio", FakeAudioElement);

    const backend = new BabylonAudioPlaybackBackend();
    await backend.play({
      ...request,
      voiceId: "bgm",
      playbackMode: "streamed",
      sourceUrl: "https://game.example/assets/stream-0.mp3",
      loop: true,
    });
    expect(audio.createBuffer).not.toHaveBeenCalled();
    expect(audio.createSound).not.toHaveBeenCalled();
    expect(audio.createStreamingSound).toHaveBeenCalledOnce();
    const element = createdElements[0]!;
    expect(element.src).toBe("https://game.example/assets/stream-0.mp3");
    expect(element.crossOrigin).toBe("anonymous");
    expect(element.loop).toBe(true);
    expect(audio.createStreamingSound.mock.calls[0]![1]).toBe(element);

    expect(backend.setVoicePlaybackRate("bgm", 1.25)).toBe(true);
    expect(element.preservesPitch).toBe(false);
    expect(element.playbackRate).toBe(1.25);

    const sound = await (audio.createStreamingSound.mock.results[0]!.value as Promise<ReturnType<typeof audio.sound>>);
    expect(backend.setVoiceMuffle("bgm", 0.5)).toBe(true);
    expect(sound.volume).toBeCloseTo(0.5);

    backend.stop("bgm");
    expect(sound.stop).toHaveBeenCalledOnce();
    expect(sound.dispose).toHaveBeenCalledOnce();
    expect(element.pause).toHaveBeenCalledOnce();
    expect(element.removeAttribute).toHaveBeenCalledWith("src");
    expect(element.load).toHaveBeenCalledOnce();
    backend.dispose();
  });

  it("releases a streamed media element and owned Blob URL when Stop arrives during creation", async () => {
    const createdElements: Array<{ pause: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; src: string }> = [];
    class FakeAudioElement {
      crossOrigin = "";
      loop = false;
      preload = "";
      src = "";
      pause = vi.fn();
      removeAttribute = vi.fn((name: string) => { if (name === "src") this.src = ""; });
      load = vi.fn();
      constructor() { createdElements.push(this); }
    }
    vi.stubGlobal("Audio", FakeAudioElement);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:owned-stream");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let finish!: (sound: ReturnType<typeof audio.sound>) => void;
    audio.createStreamingSound.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

    const backend = new BabylonAudioPlaybackBackend();
    const playing = backend.play({
      ...request,
      voiceId: "bgm",
      playbackMode: "streamed",
      source: new Uint8Array([0x49, 0x44, 0x33, 0x04]),
    });
    await vi.waitFor(() => expect(audio.createStreamingSound).toHaveBeenCalled());
    backend.stop("bgm");
    const sound = audio.sound();
    finish(sound);
    await playing;
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(sound.play).not.toHaveBeenCalled();
    expect(sound.dispose).toHaveBeenCalledOnce();
    expect(createdElements[0]!.removeAttribute).toHaveBeenCalledWith("src");
    expect(createdElements[0]!.load).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:owned-stream");
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
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
