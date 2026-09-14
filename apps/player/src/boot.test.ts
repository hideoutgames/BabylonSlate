import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene } from "@babylonslate/core";
import { exportGame } from "@babylonslate/exporter";
import * as rendering from "@babylonslate/render";
import * as runtimes from "@babylonslate/runtime";
import type { BridgeHostMessage, BridgeWorkerMessage } from "@babylonslate/bridge";
import { loadGameFromFiles } from "./artifact";
import { startPlayer, type PlayerBootHandle } from "./boot";
import * as inputs from "./input";

class TestWorker {
  static instances: TestWorker[] = [];
  static failPost = false;
  readonly messages: BridgeHostMessage[] = [];
  onmessage: ((event: MessageEvent<BridgeWorkerMessage>) => void) | null = null;
  terminated = false;
  terminate = vi.fn(() => { this.terminated = true; });
  constructor() { TestWorker.instances.push(this); }
  postMessage(message: BridgeHostMessage) {
    if (TestWorker.failPost) throw new Error("Worker transport unavailable");
    this.messages.push(message);
  }
  command(payload: BridgeWorkerMessage & { channel: "command" }) {
    this.onmessage?.({ data: payload } as MessageEvent<BridgeWorkerMessage>);
  }
}

const sessions: PlayerBootHandle[] = [];
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

beforeEach(() => {
  TestWorker.instances = [];
  TestWorker.failPost = false;
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});

afterEach(() => {
  sessions.splice(0).forEach((session) => session.stop());
  document.body.replaceChildren();
  frames.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const scene = { ...createDefaultScene(), actors: [] };
  const packed = await exportGame({ bundleDebugger: false, startupSceneGuid: "world", scripts: [],
    assets: [{ guid: "world", type: "Scene", sceneGuid: "world", bytes: new TextEncoder().encode(JSON.stringify(scene)) }] });
  if (!packed.ok) throw new Error("Fixture export failed");
  const game = await loadGameFromFiles(packed.value.files);
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const handle = {
    applySceneEnvironment: vi.fn(), resize: vi.fn(), setSize: vi.fn(), dispose: vi.fn(),
    applyCommand: vi.fn(), pushSnapshot: vi.fn(), setPaused: vi.fn(),
    playVisualStates: () => [], playMeshMaterialNames: () => [], isFreeCamEnabled: () => false,
    unlockAudio: async () => {},
    scheduler: { invalidate: vi.fn(), acquireObstruction: () => () => {}, stats: () => ({ renderedFps: 0 }) },
  };
  vi.spyOn(rendering, "createEngine").mockReturnValue(handle as unknown as rendering.EngineHandle);
  const attach = inputs.attachInputCapture;
  let input: inputs.InputCaptureHandle | undefined;
  vi.spyOn(inputs, "attachInputCapture").mockImplementation((...args) => (input = attach(...args)));
  return { game, canvas, handle, input: () => input! };
}

describe("player startup and Stop ownership", () => {
  it("stops before the worker's first loading token and detaches late commands and input", async () => {
    const { game, canvas, handle, input } = await fixture();
    const session = startPlayer({ game, canvas });
    sessions.push(session);
    const worker = TestWorker.instances[0]!;
    const staleMessage = worker.onmessage!;
    input().ring.drain();
    session.stop();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(document.querySelector("dialog")).toBeNull();
    expect(frames.size).toBe(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    expect(input().ring.drain()).toEqual([]);
    handle.applyCommand.mockClear();
    staleMessage({ data: { channel: "command", payload: { type: "sceneLoading", sceneAssetGuid: "world", sceneLoadId: 1 } } } as MessageEvent<BridgeWorkerMessage>);
    expect(handle.applyCommand).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("releases every later owner and reports a cleanup failure without repeating already released resources", async () => {
    const { game, canvas, handle, input } = await fixture();
    const session = startPlayer({ game, canvas });
    sessions.push(session);
    const releaseInput = input().dispose;
    const failedDispose = vi.spyOn(input(), "dispose").mockImplementation(() => { releaseInput(); throw new Error("Input disposal failed"); });
    const result = session.stop();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "player.cleanup.failed", message: expect.stringContaining("Input disposal failed") }));
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(document.querySelector("dialog")).toBeNull();
    expect(frames.size).toBe(0);
    session.stop();
    expect(failedDispose).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });

  it("terminates a partially initialized worker before starting the real in-process fallback", async () => {
    const { game, canvas, handle } = await fixture();
    TestWorker.failPost = true;
    let fallback: runtimes.RuntimeDriver | undefined;
    vi.spyOn(runtimes, "createRuntimeFromLoad").mockImplementation((load, onCommand) => {
      expect(TestWorker.instances[0]!.terminated).toBe(true);
      fallback = runtimes.createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
        playScene: load.scene, playSceneGuid: load.sceneAssetGuid, deferSceneModelsReady: true,
        deferSceneLoadingPaint: true, cooperativeSceneLoading: true, onCommand });
      return fallback;
    });
    const session = startPlayer({ game, canvas });
    sessions.push(session);
    const stopped = vi.spyOn(fallback!, "stop");
    session.stop();
    await Promise.resolve();
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("rolls back the acquired scene when later startup setup throws", async () => {
    const { game, canvas, handle } = await fixture();
    vi.spyOn(inputs, "attachInputCapture").mockImplementation(() => { throw new Error("Input setup failed"); });
    expect(() => startPlayer({ game, canvas })).toThrow("Input setup failed");
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(document.querySelector("dialog")).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("detaches lifecycle listeners when the initial pause control fails after registration", async () => {
    const { game, canvas, handle } = await fixture();
    const postMessage = TestWorker.prototype.postMessage;
    const post = vi.spyOn(TestWorker.prototype, "postMessage").mockImplementation(function(this: TestWorker, message) {
      if (message.channel === "control" && message.payload.type === "setPaused") throw new Error("Initial pause transport failed");
      postMessage.call(this, message);
    });
    expect(() => startPlayer({ game, canvas })).toThrow("Initial pause transport failed");
    const commandsAtFailure = post.mock.calls.length;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new CustomEvent("babylonslate:appstate", { detail: { isActive: false } }));
    expect(post).toHaveBeenCalledTimes(commandsAtFailure);
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(document.querySelector("dialog")).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("unwinds a loading failure even when the worker transport can no longer accept Stop", async () => {
    const { game, canvas, handle } = await fixture();
    const session = startPlayer({ game, canvas });
    sessions.push(session);
    const worker = TestWorker.instances[0]!;
    worker.command({ channel: "command", payload: { type: "sceneLoading", sceneAssetGuid: "world", sceneLoadId: 1 } });
    expect(document.querySelector("dialog")?.open).toBe(true);
    TestWorker.failPost = true;
    worker.command({ channel: "command", payload: { type: "sceneLoadFailed", sceneAssetGuid: "world", sceneLoadId: 1, message: "Owned scene realization failed" } });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(document.querySelector("dialog")).toBeNull();
    expect(session.stop().diagnostics).toContainEqual(expect.objectContaining({ code: "scene.load.failed" }));
  });
});
