import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene, DEFAULT_RENDER_PROJECT_SETTINGS, resolveRenderingPipeline } from "@babylonslate/core";
import { exportGame } from "@babylonslate/exporter";
import * as rendering from "@babylonslate/render";
import * as runtimes from "@babylonslate/runtime";
import type { BridgeHostMessage, BridgeWorkerMessage } from "@babylonslate/bridge";
import type { AbstractEngine } from "@babylonjs/core";
import { loadGameFromFiles } from "./artifact";
import { startPlayer, type PlayerBootHandle } from "./boot";
import { startPlayerWithBackend } from "./player-backend";
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

function flushFrames(count: number) {
  for (let i = 0; i < count; i++) {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  }
}

async function fixture() {
  const scene = { ...createDefaultScene(), actors: [] };
  const packed = await exportGame({ bundleDebugger: false, startupSceneGuid: "world", scripts: [], renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
    assets: [{ guid: "world", type: "Scene", sceneGuid: "world", bytes: new TextEncoder().encode(JSON.stringify(scene)) }] });
  if (!packed.ok) throw new Error("Fixture export failed");
  const game = await loadGameFromFiles(packed.value.files);
  const root = document.createElement("div");
  root.id = "player-root";
  const canvas = document.createElement("canvas");
  root.append(canvas);
  document.body.append(root);
  const endFrame = new Set<() => void>();
  const handle = {
    engine: { onEndFrameObservable: { add: (callback: () => void) => (endFrame.add(callback), callback), remove: (callback: () => void) => { endFrame.delete(callback); } } },
    loadScene: vi.fn(),
    applySceneEnvironment: vi.fn(), applyBakedSession: vi.fn(),
    resize: vi.fn(), setSize: vi.fn(), dispose: vi.fn(),
    applyCommand: vi.fn(), pushSnapshot: vi.fn(), setPaused: vi.fn(),
    playVisualStates: () => [], playMeshMaterialNames: () => [], isFreeCamEnabled: () => false,
    renderPathStatus: () => resolveRenderingPipeline(game.manifest.render),
    whenEditorModelsReady: async () => {}, whenMaterialTexturesReady: async () => {},
    prewarmSceneMaterials: async () => {}, presentFirstFrame: vi.fn(async () => {}),
    unlockAudio: async () => {},
    scheduler: { invalidate: vi.fn(), acquireObstruction: vi.fn(() => () => {}), stats: () => ({ renderedFps: 0 }) },
  };
  vi.spyOn(rendering, "createEngine").mockReturnValue(handle as unknown as rendering.EngineHandle);
  const attach = inputs.attachInputCapture;
  let input: inputs.InputCaptureHandle | undefined;
  vi.spyOn(inputs, "attachInputCapture").mockImplementation((...args) => (input = attach(...args)));
  const fireEndFrame = () => { for (const callback of [...endFrame]) callback(); };
  return { game, canvas, root, handle, input: () => input!, fireEndFrame };
}

async function backendFixture() {
  const value = await fixture();
  const owner: rendering.BackendEngineSession = {
    engine: {} as AbstractEngine,
    requestedBackend: "webgl2",
    effectiveBackend: "webgl2",
    dispose: vi.fn(() => { expect(value.handle.dispose).toHaveBeenCalledOnce(); }),
  };
  vi.spyOn(rendering, "createBackendEngineSession").mockResolvedValue(owner);
  return { ...value, owner };
}

describe("player startup and Stop ownership", () => {
  it("stops before the worker's first loading token and detaches late commands and input", async () => {
    const { game, canvas, handle, input, owner } = await backendFixture();
    const onStopped = vi.fn();
    const session = await startPlayerWithBackend({ game, canvas, onStopped });
    sessions.push(session);
    expect(rendering.createEngine).toHaveBeenCalledWith(
      canvas,
      expect.objectContaining({ renderSettings: game.manifest.render }),
    );
    const worker = TestWorker.instances[0]!;
    const staleMessage = worker.onmessage!;
    input().ring.drain();
    session.stop();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(owner.dispose).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledOnce();
    expect(document.querySelector("dialog")).toBeNull();
    session.stop();
    expect(owner.dispose).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    expect(input().ring.drain()).toEqual([]);
    handle.applyCommand.mockClear();
    staleMessage({ data: { channel: "command", payload: { type: "sceneLoading", sceneAssetGuid: "world", sceneLoadId: 1 } } } as MessageEvent<BridgeWorkerMessage>);
    expect(handle.applyCommand).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("releases the backend when host Stop interrupts a held load even when an inner cleanup fails", async () => {
    const { game, canvas, root, handle, input, owner } = await backendFixture();
    const session = await startPlayerWithBackend({ game, canvas });
    sessions.push(session);
    const releaseInput = input().dispose;
    const failedDispose = vi.spyOn(input(), "dispose").mockImplementation(() => { releaseInput(); throw new Error("Input disposal failed"); });
    TestWorker.instances[0]!.command({ channel: "command", payload: { type: "sceneLoading", sceneAssetGuid: "world", sceneLoadId: 1 } });
    expect(root.dataset.sceneLoading).toBe("true");
    expect(handle.scheduler.acquireObstruction).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")).toBeNull();
    const result = session.stop();
    expect(owner.dispose).toHaveBeenCalledOnce();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "player.cleanup.failed", message: expect.stringContaining("Input disposal failed") }));
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(document.querySelector("dialog")).toBeNull();
    expect(frames.size).toBe(0);
    session.stop();
    expect(failedDispose).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(owner.dispose).toHaveBeenCalledOnce();
  });

  it("reports loading on the player root without a dialog and clears it when the scene is ready", async () => {
    const { game, canvas, root, handle } = await backendFixture();
    const session = await startPlayerWithBackend({ game, canvas });
    sessions.push(session);
    const worker = TestWorker.instances[0]!;
    worker.command({ channel: "command", payload: { type: "sceneLoading", sceneAssetGuid: "world", sceneLoadId: 1 } });
    expect(root.dataset.sceneLoading).toBe("true");
    expect(root.dataset.sceneLoadPhase).toBe("Preparing Scene");
    expect(root.dataset.sceneLoadProgress).toBe("0");
    expect(root.dataset.sceneLoadId).toBe("1");
    expect(document.querySelector("dialog")).toBeNull();
    expect(handle.scheduler.acquireObstruction).not.toHaveBeenCalled();
    flushFrames(2);
    await vi.waitFor(() => {
      expect(worker.messages).toContainEqual({ channel: "control", payload: { type: "sceneLoadingPainted", sceneAssetGuid: "world", sceneLoadId: 1 } });
    });
    worker.command({ channel: "command", payload: { type: "activeScene", sceneAssetGuid: "world", sceneLoadId: 1 } });
    worker.command({ channel: "command", payload: { type: "sceneRealized", sceneAssetGuid: "world", sceneLoadId: 1 } });
    // Each readiness step awaits a paint that completes on end-frame or after
    // two animation frames; keep feeding frames while the chain advances.
    await vi.waitFor(() => {
      flushFrames(1);
      expect(handle.presentFirstFrame).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      flushFrames(1);
      expect(worker.messages).toContainEqual({ channel: "control", payload: { type: "sceneModelsReady", sceneAssetGuid: "world", sceneLoadId: 1 } });
    });
    expect(root.dataset.sceneLoading).toBe("false");
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
    const { game, canvas, handle, owner } = await backendFixture();
    vi.spyOn(inputs, "attachInputCapture").mockImplementation(() => { throw new Error("Input setup failed"); });
    await expect(startPlayerWithBackend({ game, canvas })).rejects.toThrow("Input setup failed");
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(owner.dispose).toHaveBeenCalledOnce();
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
    const { game, canvas, handle, owner } = await backendFixture();
    const session = await startPlayerWithBackend({ game, canvas });
    sessions.push(session);
    const worker = TestWorker.instances[0]!;
    worker.command({ channel: "command", payload: { type: "sceneLoading", sceneAssetGuid: "world", sceneLoadId: 1 } });
    expect(document.getElementById("player-root")?.dataset.sceneLoading).toBe("true");
    TestWorker.failPost = true;
    worker.command({ channel: "command", payload: { type: "sceneLoadFailed", sceneAssetGuid: "world", sceneLoadId: 1, message: "Owned scene realization failed" } });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(owner.dispose).toHaveBeenCalledOnce();
    expect(document.querySelector("dialog")).toBeNull();
    expect(session.stop().diagnostics).toContainEqual(expect.objectContaining({ code: "scene.load.failed" }));
    expect(owner.dispose).toHaveBeenCalledOnce();
  });
});
