import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultWaterDefinition, createDefaultScene, createDefaultRenderTargetCaptureProperties, DEFAULT_RENDER_PROJECT_SETTINGS, resolveRenderingPipeline,
  SaveGameService, createSaveStorageClient, type SaveGameConfiguration, type SaveGameStorage } from "@babylonslate/core";
import { exportGame } from "@babylonslate/exporter";
import * as rendering from "@babylonslate/render";
import * as runtimes from "@babylonslate/runtime";
import type { BridgeHostMessage, BridgeWorkerMessage } from "@babylonslate/bridge";
import type { AbstractEngine } from "@babylonjs/core";
import { loadGameFromFiles } from "./artifact";
import { startPlayer, type PlayerBootHandle } from "./boot";
import { startPlayerWithBackend } from "./player-backend";
import * as inputs from "./input";
const attachInputCapture = inputs.attachInputCapture;

class TestWorker {
  static instances: TestWorker[] = [];
  static failPost = false;
  readonly messages: BridgeHostMessage[] = [];
  onmessage: ((event: MessageEvent<BridgeWorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
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

async function fixture(withWater = false, saveGame?: SaveGameConfiguration) {
  const scene = { ...createDefaultScene(), actors: [] };
  const packed = await exportGame({ bundleDebugger: false, startupSceneGuid: "world", scripts: [], renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
    ...(saveGame ? { saveGame, physicsWorld: "2d" as const } : {}),
    assets: [{ guid: "world", type: "Scene", sceneGuid: "world", requiredDependencies: withWater ? ["water"] : [], bytes: new TextEncoder().encode(JSON.stringify(scene)) }, ...(withWater ? [{ guid: "water", type: "Water", sceneGuid: "world", bytes: new TextEncoder().encode(JSON.stringify(createDefaultWaterDefinition("stylized"))) }] : [])] });
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
    acquireSceneSources: vi.fn(async () => () => {}), releaseInitialSources: vi.fn(),
    applySceneEnvironment: vi.fn(),
    resize: vi.fn(), setSize: vi.fn(), dispose: vi.fn(),
    applyCommand: vi.fn(), pushSnapshot: vi.fn(), setPaused: vi.fn(),
    prepareSceneStream: vi.fn(async (_slots: readonly number[], _signal: AbortSignal, progress?: (value: number) => void) => { progress?.(1); }),
    setSceneStreamingPaused: vi.fn(),
    playVisualStates: () => [], playMeshMaterialNames: () => [], isFreeCamEnabled: () => false,
    renderPathStatus: () => resolveRenderingPipeline(game.manifest.render),
    whenEditorModelsReady: async () => {}, whenMaterialTexturesReady: async () => {},
    prewarmSceneMaterials: async () => {}, presentFirstFrame: vi.fn(async () => {}),
    unlockAudio: async () => {},
    scheduler: { invalidate: vi.fn(), acquireObstruction: vi.fn(() => () => {}), stats: () => ({ renderedFps: 0 }) },
  };
  vi.spyOn(rendering, "createEngine").mockReturnValue(handle as unknown as rendering.EngineHandle);
  let input: inputs.InputCaptureHandle | undefined;
  vi.spyOn(inputs, "attachInputCapture").mockImplementation((...args) => (input = attachInputCapture(...args)));
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
  it("reopens a packed player's checkpoint through the real in-process fallback", async () => {
    const files = new Map<string, string>();
    const saveStorage: SaveGameStorage = { read: async (key) => files.get(key) ?? null,
      write: async (key, text) => { files.set(key, text); }, remove: async (key) => { files.delete(key); },
      list: async (prefix) => [...files.keys()].filter((key) => key.startsWith(prefix)), withLock: async (_key, work) => work() };
    const saveGame: SaveGameConfiguration = { projectId: "exported-progress", defaultProfile: "player-two", defaultSlot: "checkpoint",
      definition: { id: "progress", schemaVersion: 1, fields: [{ id: "coins-id", name: "Coins", type: "int", defaultValue: 3 }] } };
    TestWorker.failPost = true;
    const createRuntime = runtimes.createRuntimeFromLoad;
    const create = vi.spyOn(runtimes, "createRuntimeFromLoad").mockImplementation((...args) => {
      const runtime = createRuntime(...args);
      // This persistence test uses the driver's existing software backend;
      // loading a browser WASM physics engine is an independent boundary.
      vi.spyOn(runtime, "loadPhysics").mockResolvedValue(undefined);
      return runtime;
    });
    for (const restart of [false, true]) {
      const { game, canvas, root, fireEndFrame } = await fixture(false, saveGame);
      const commands: Array<{ type: string; [key: string]: unknown }> = [];
      const session = startPlayer({ game, canvas, saveStorage, onConsoleEvent: (command) => commands.push(command) });
      sessions.push(session);
      const runtime = create.mock.results.at(-1)!.value as runtimes.RuntimeDriver;
      const ready = vi.spyOn(runtime, "notifySceneModelsReady");
      await vi.waitFor(() => {
        flushFrames(2);
        fireEndFrame();
        if (!ready.mock.calls.length) throw new Error(JSON.stringify({ phase: root.dataset.sceneLoadPhase,
          commands: commands.map((command) => ({ type: command.type, message: command.message })) }));
      });
      expect(root.dataset.sceneLoading).toBe("false");
      const service = runtime.getSaveGameService()!;
      expect(service).toBeDefined();
      if (!restart) {
        service.getSaveData().Coins = 27;
        expect(await service.saveGame()).toMatchObject({ ok: true, value: { profile: "player-two", slot: "checkpoint" } });
      } else {
        expect(service.getSaveData().Coins).toBe(3);
        expect((await service.loadGame()).ok).toBe(true);
        expect(service.getSaveData().Coins).toBe(27);
      }
      session.stop();
      root.remove();
    }
    expect([...files.keys()].every((key) => key.startsWith("save-games/exported-progress/game/player-two/checkpoint/"))).toBe(true);
  });

  it("routes exported worker saves through the player's storage host with the same namespace", async () => {
    const files = new Map<string, string>();
    const saveStorage: SaveGameStorage = { read: async (key) => files.get(key) ?? null,
      write: async (key, text) => { files.set(key, text); }, remove: async (key) => { files.delete(key); },
      list: async (prefix) => [...files.keys()].filter((key) => key.startsWith(prefix)), withLock: async (_key, work) => work() };
    const config: SaveGameConfiguration = { projectId: "worker-progress", definition: { id: "progress", schemaVersion: 1,
      fields: [{ id: "coins-id", name: "Coins", type: "int", defaultValue: 0 }] } };
    const { game, canvas } = await fixture(false, config);
    sessions.push(startPlayer({ game, canvas, saveStorage }));
    const worker = TestWorker.instances[0]!;
    const load = worker.messages.find((message) => message.channel === "control" && message.payload.type === "load");
    if (load?.channel !== "control" || load.payload.type !== "load" || !load.payload.saveGame) throw new Error("Save configuration did not reach the worker");
    const client = createSaveStorageClient((request) => worker.command({ channel: "command", payload: { type: "saveStorageRequest", request } }));
    const post = worker.postMessage.bind(worker);
    vi.spyOn(worker, "postMessage").mockImplementation((message) => {
      post(message);
      if (message.channel === "control" && message.payload.type === "saveStorageResponse") client.receive(message.payload.response);
    });
    try {
      const saved = new SaveGameService({ ...load.payload.saveGame, storage: client.storage });
      saved.getSaveData().Coins = 41;
      expect((await saved.saveGame()).ok).toBe(true);
      const reopened = new SaveGameService({ ...config, storage: saveStorage });
      expect((await reopened.loadGame()).ok).toBe(true);
      expect(reopened.getSaveData().Coins).toBe(41);
      const preview = new SaveGameService({ ...config, storage: saveStorage, preview: true });
      expect(await preview.loadGame()).toMatchObject({ ok: false, error: { code: "missing" } });
    } finally { client.dispose(); }
  });

  it.each(["error", "messageerror"] as const)("reports an asynchronous worker %s and releases the player", async (kind) => {
    const { game, canvas, handle, owner } = await backendFixture();
    const onDiagnostic = vi.fn();
    const session = await startPlayerWithBackend({ game, canvas, onDiagnostic });
    sessions.push(session);
    const worker = TestWorker.instances[0]!;
    if (kind === "error") worker.onerror?.(new ErrorEvent("error", { message: "Worker module could not load" }));
    else worker.onmessageerror?.(new MessageEvent("messageerror"));
    expect(onDiagnostic).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ code: "player.worker.failed", severity: "error" }),
    ]));
    expect(worker.terminated).toBe(true);
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(owner.dispose).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(session.stop().diagnostics).toContainEqual(expect.objectContaining({ code: "player.worker.failed" }));
    expect(owner.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    { traceByteBudget: undefined, retainedTicks: [1, 2, 3, 4, 5, 6, 7, 8] },
    { traceByteBudget: 1024, retainedTicks: [8] },
  ])("records using the Preview session trace budget of $traceByteBudget", async ({ traceByteBudget, retainedTicks }) => {
    const { game, canvas } = await fixture();
    game.manifest.bundleDebugger = true;
    sessions.push(startPlayer({ game, canvas, traceByteBudget }));
    const message = TestWorker.instances[0]!.messages.find((entry) =>
      entry.channel === "control" && entry.payload.type === "load");
    if (message?.channel !== "control" || message.payload.type !== "load") throw new Error("Player did not load its runtime");
    const runtime = runtimes.createRuntimeFromLoad(message.payload, () => {});
    try {
      const world = runtime.getWorld();
      world.spawnActorNow(world.createActor({
        classId: "Actor", guid: "trace-probe", variables: { payload: "x".repeat(1024) },
      }));
      runtime.start();
      runtime.executeConsoleCommand("snapshot start");
      for (let i = 0; i < 8; i++) runtime.tick();
      runtime.executeConsoleCommand("snapshot stop");
      expect(runtime.stopTrace()?.frames.map((frame) => frame.tickIndex)).toEqual(retainedTicks);
    } finally {
      runtime.stop();
    }
  });

  it("delivers capture configuration and explicit requests from the worker to the renderer", async () => {
    const { game, canvas, handle } = await fixture();
    sessions.push(startPlayer({ game, canvas }));
    const worker = TestWorker.instances[0]!;
    const configure = {
      type: "configureRenderTargetCapture" as const, actorGuid: "capture", slotId: 7,
      settings: { ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: "screen", captureEveryFrame: false },
    };
    worker.command({ channel: "command", payload: configure });
    worker.command({ channel: "command", payload: { type: "captureRenderTarget", actorGuid: "capture" } });
    expect(handle.applyCommand).toHaveBeenCalledWith(configure);
    expect(handle.applyCommand).toHaveBeenCalledWith({ type: "captureRenderTarget", actorGuid: "capture" });
  });

  it("acknowledges independent stream readiness and blocks effects without changing manual pause", async () => {
    const { game, canvas, handle } = await fixture();
    let finish!: () => void;
    handle.prepareSceneStream.mockImplementationOnce(async () => new Promise<void>((resolve) => { finish = resolve; }));
    sessions.push(startPlayer({ game, canvas }));
    const worker = TestWorker.instances[0]!;
    const before = worker.messages.length;
    worker.command({ channel: "command", payload: { type: "sceneStreamBlocking", blocking: true } });
    worker.command({ channel: "command", payload: { type: "sceneStreamLoading", actorGuid: "left", streamLoadId: 5 } });
    expect(handle.applyCommand).toHaveBeenCalledWith({ type: "sceneStreamLoading", actorGuid: "left", streamLoadId: 5 });
    worker.command({ channel: "command", payload: { type: "sceneStreamRealized", actorGuid: "left", streamLoadId: 5, slotIds: [7, 9] } });
    expect(handle.setSceneStreamingPaused).toHaveBeenCalledWith(true);
    expect(worker.messages.slice(before).some((message) => message.channel === "control" && message.payload.type === "setPaused")).toBe(false);
    expect(worker.messages.some((message) => message.channel === "control" && message.payload.type === "sceneStreamReady")).toBe(false);
    finish();
    await vi.waitFor(() => expect(worker.messages).toContainEqual({ channel: "control", payload: { type: "sceneStreamReady", actorGuid: "left", streamLoadId: 5 } }));
    expect(handle.loadScene).not.toHaveBeenCalled();
    worker.command({ channel: "command", payload: { type: "sceneStreamBlocking", blocking: false } });
    expect(handle.setSceneStreamingPaused).toHaveBeenLastCalledWith(false);
    worker.command({ channel: "command", payload: { type: "sceneStreamRemoved", actorGuid: "left", streamLoadId: 5 } });
    expect(handle.applyCommand).toHaveBeenCalledWith({ type: "sceneStreamRemoved", actorGuid: "left", streamLoadId: 5 });
  });
  it.each([false, true])("loads the same Water definition into rendering and simulation (fallback=%s)", async (fallbackMode) => {
    const { game, canvas } = await fixture(true);
    TestWorker.failPost = fallbackMode;
    const registered = vi.fn();
    if (fallbackMode) vi.spyOn(runtimes, "createRuntimeFromLoad").mockImplementation((load, onCommand) => {
      const runtime = runtimes.createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, playScene: load.scene, onCommand });
      vi.spyOn(runtime, "registerWaterContent").mockImplementation(registered);
      return runtime;
    });
    sessions.push(startPlayer({ game, canvas }));
    const water = createDefaultWaterDefinition("stylized");
    expect(rendering.createEngine).toHaveBeenCalledWith(canvas, expect.objectContaining({ waterPayloads: new Map([["water", water]]) }));
    if (fallbackMode) expect(registered).toHaveBeenCalledWith(new Map([["water", water]]));
    else {
      const controls = TestWorker.instances[0]!.messages.filter((message) => message.channel === "control").map((message) => message.payload);
      expect(controls).toContainEqual({ type: "loadWater", waters: [{ guid: "water", document: water }] });
      expect(controls.findIndex((message) => message.type === "loadWater")).toBeLessThan(controls.findIndex((message) => message.type === "play"));
    }
  });
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
