import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene, DEFAULT_RENDER_PROJECT_SETTINGS } from "@babylonslate/core";
import { exportGame } from "@babylonslate/exporter";
import { createDefaultMaterialDocument, newCustomGlslProperties } from "@babylonslate/shader-graph";
import type { AbstractEngine } from "@babylonjs/core";
import type { BackendEngineSession } from "@babylonslate/render";
import type { PlayerBootHandle, PlayerBootOptions } from "./boot";
import { loadGameFromFiles } from "./artifact";

const { createBackend, start } = vi.hoisted(() => ({ createBackend: vi.fn(), start: vi.fn() }));
vi.mock("@babylonslate/render", async () => ({
  createBackendEngineSession: createBackend,
  ...await import("../../../packages/render/src/material-backend-compatibility"),
}));
vi.mock("./boot", () => ({ startPlayer: start }));
import { startPlayerWithBackend } from "./player-backend";

async function game(custom = false) {
  const material = createDefaultMaterialDocument("Packed Surface");
  if (custom) {
    material.nodes.push({ id: "custom", type: "custom.glsl", position: { x: 0, y: 0 }, properties: newCustomGlslProperties() });
    material.edges.push({ id: "roughness", sourceNodeId: "custom", sourcePinId: "out", targetNodeId: "output", targetPinId: "roughness" });
  }
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const files = await exportGame({
    bundleDebugger: false,
    startupSceneGuid: "scene",
    renderSettings: { ...DEFAULT_RENDER_PROJECT_SETTINGS, gpuBackend: "webgpu" },
    scripts: [],
    assets: [
      { guid: "scene", type: "Scene", sceneGuid: "scene", requiredDependencies: ["material"], bytes: encode(createDefaultScene()) },
      { guid: "material", type: "Material", sceneGuid: "scene", bytes: encode(material) },
    ],
  });
  if (!files.ok) throw new Error(files.error);
  return loadGameFromFiles(files.value.files);
}

describe("packed player backend lifetime", () => {
  const events: string[] = [];
  // Active render loops and end-of-frame observers on the private Engine.
  const renderLoops = new Set<() => void>();
  const endFrame = new Set<() => void>();
  /** Like Babylon's frame queue: a frame ends only while a render loop runs. */
  const renderFrame = () => {
    if (!renderLoops.size) return;
    for (const loop of [...renderLoops]) loop();
    for (const observer of [...endFrame]) observer();
  };
  let owner: BackendEngineSession;
  let player: PlayerBootHandle;
  const canvas = { width: 320, height: 180 } as HTMLCanvasElement;
  beforeEach(() => {
    vi.resetAllMocks();
    events.length = 0;
    renderLoops.clear();
    endFrame.clear();
    vi.stubGlobal("document", {
      baseURI: "https://game.example/subdir/index.html",
      createElement: () => ({ width: 0, height: 0, remove: vi.fn() }),
    });
    owner = {
      engine: {
        runRenderLoop: (loop: () => void) => { renderLoops.add(loop); },
        stopRenderLoop: (loop: () => void) => { renderLoops.delete(loop); },
      } as unknown as AbstractEngine,
      requestedBackend: "webgpu",
      effectiveBackend: "webgpu",
      dispose: vi.fn(() => { events.push("engine"); }),
    };
    player = {
      ticks: () => 0,
      rendering: () => null,
      scalability: () => undefined,
      shadowDiagnostics: () => null,
      visuals: () => [],
      meshMaterialNames: () => [],
      text2dLayouts: () => [],
      postProcessPassCount: () => 0,
      renderTasks: () => null,
      setRenderSettings: vi.fn(),
      executeConsoleCommand: async () => ({ success: true, output: "" }),
      inspectWorld: async () => { throw new Error("No inspection in this fixture"); },
      stop: vi.fn(() => { events.push("player"); return { diagnostics: [] }; }),
    };
    createBackend.mockResolvedValue(owner);
    start.mockReturnValue(player);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("boots the packed preference on a private canvas and releases the player before its engine", async () => {
    const loaded = await game();
    const handle = await startPlayerWithBackend({ game: loaded, canvas });
    const factory = createBackend.mock.calls[0]![0];
    expect(factory.requestedBackend).toBe("webgpu");
    const privateCanvas = factory.createCanvas();
    expect(privateCanvas).not.toBe(canvas);
    expect([privateCanvas.width, privateCanvas.height]).toEqual([320, 180]);
    expect(factory.decoders).toEqual({
      ktx2BasePath: "https://game.example/subdir/ktx2/",
      dracoBasePath: "https://game.example/subdir/draco/",
      meshoptBasePath: "https://game.example/subdir/meshopt/",
    });
    const boot = start.mock.calls[0]![0] as PlayerBootOptions;
    expect(boot.sharedEngine).toBe(owner.engine);
    expect(boot.canvas).toBe(canvas);
    expect(owner.engine.inputElement).toBe(canvas);
    expect(boot.content?.materialDocuments.get("material")?.name).toBe("Packed Surface");
    expect(handle.backend.effectiveBackend).toBe("webgpu");
    handle.stop();
    handle.stop();
    expect(events).toEqual(["player", "engine"]);
  });

  it("defaults a legacy pack without a backend preference to WebGL2", async () => {
    const loaded = await game();
    delete loaded.manifest.render.gpuBackend;
    owner.requestedBackend = owner.effectiveBackend = "webgl2";
    const handle = await startPlayerWithBackend({ game: loaded, canvas });
    expect(createBackend.mock.calls[0]![0].requestedBackend).toBe("webgl2");
    expect(handle.backend.effectiveBackend).toBe("webgl2");
    expect(loaded.manifest.render.gpuBackend).toBeUndefined();
    handle.stop();
  });

  it("passes actual packed Custom GLSL incompatibility to fallback while preserving the saved request", async () => {
    const loaded = await game(true);
    owner.effectiveBackend = "webgl2";
    owner.fallbackReason = "Custom GLSL requires WebGL2.";
    const handle = await startPlayerWithBackend({ game: loaded, canvas });
    expect(createBackend.mock.calls[0]![0].webGpuCompatibilityReason).toContain('Material "Packed Surface" uses Custom GLSL');
    expect(handle.backend).toEqual({ requestedBackend: "webgpu", effectiveBackend: "webgl2", fallbackReason: "Custom GLSL requires WebGL2." });
    expect(loaded.manifest.render.gpuBackend).toBe("webgpu");
    handle.stop();
  });

  it("releases an engine that completes after Stop without starting authored runtime", async () => {
    const loaded = await game();
    const abort = new AbortController();
    createBackend.mockImplementation(async () => {
      abort.abort(new Error("Preview stopped"));
      return owner;
    });
    await expect(startPlayerWithBackend({ game: loaded, canvas, signal: abort.signal })).rejects.toBe(abort.signal.reason);
    expect(start).not.toHaveBeenCalled();
    expect(events).toEqual(["engine"]);
  });

  it("releases the engine after startup failure and after a failing Stop", async () => {
    const loaded = await game();
    const startup = new Error("Player startup failed");
    start.mockImplementationOnce(() => { throw startup; });
    await expect(startPlayerWithBackend({ game: loaded, canvas })).rejects.toBe(startup);
    expect(events).toEqual(["engine"]);
    events.length = 0;
    const shutdown = new Error("Worker shutdown failed");
    vi.mocked(player.stop).mockImplementation(() => { events.push("player"); throw shutdown; });
    const handle = await startPlayerWithBackend({ game: loaded, canvas });
    expect(() => handle.stop()).toThrow("Player shutdown failed");
    handle.stop();
    expect(events).toEqual(["player", "engine"]);
  });

  it("keeps frames running on its private Engine until a frame-drained view release settles", async () => {
    const loaded = await game();
    const handle = await startPlayerWithBackend({ game: loaded, canvas });
    const boot = start.mock.calls[0]![0] as PlayerBootOptions;
    // WebGPU releases the view's retired resources at the next end of frame.
    boot.onStopped!(new Promise<void>((resolve) => { endFrame.add(resolve); }));
    await Promise.resolve();
    expect(events).toEqual([]);
    renderFrame();
    await vi.waitFor(() => expect(events).toEqual(["engine"]));
    expect(renderLoops.size).toBe(0);
    handle.stop();
    expect(owner.dispose).toHaveBeenCalledOnce();
  });

  it("disposes the Engine after a bounded wait when only Engine disposal can complete the view release", async () => {
    const loaded = await game();
    const handle = await startPlayerWithBackend({ game: loaded, canvas });
    const boot = start.mock.calls[0]![0] as PlayerBootOptions;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settle!: () => void;
    const viewReleased = new Promise<void>((resolve) => { settle = resolve; });
    vi.mocked(owner.dispose).mockImplementation(() => { events.push("engine"); settle(); });
    boot.onStopped!(viewReleased);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    await vi.runAllTimersAsync();
    expect(events).toEqual(["engine"]);
    await viewReleased;
    handle.stop();
    expect(owner.dispose).toHaveBeenCalledOnce();
  });

  it("reports a graphics device lost while the game runs, but not after Stop", async () => {
    const loaded = await game();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let lose!: (loss: { reason: string; message: string }) => void;
    owner.deviceLost = new Promise((resolve) => { lose = resolve; });
    const onDiagnostic = vi.fn();
    await startPlayerWithBackend({ game: loaded, canvas, onDiagnostic });
    lose({ reason: "unknown", message: "Out of memory" });
    await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledWith([expect.objectContaining({
      code: "render.device.lost", severity: "error", message: expect.stringContaining("Out of memory"),
    })]));
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("graphics device was lost"));

    const stopped = vi.fn();
    owner.deviceLost = new Promise((resolve) => { lose = resolve; });
    const handle = await startPlayerWithBackend({ game: loaded, canvas, onDiagnostic: stopped });
    handle.stop();
    lose({ reason: "destroyed", message: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).not.toHaveBeenCalled();
  });

  it("reports a failed deferred Engine disposal without disposing the uncertain backend again", async () => {
    const loaded = await game();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pageFailure = new Error("Page cleanup failed");
    vi.mocked(owner.dispose).mockImplementation(() => { events.push("engine"); throw new Error("Device disposal failed"); });
    const onStopped = vi.fn(() => { throw pageFailure; });
    const onDiagnostic = vi.fn();
    const handle = await startPlayerWithBackend({ game: loaded, canvas, onStopped, onDiagnostic });
    const boot = start.mock.calls[0]![0] as PlayerBootOptions;
    expect(() => boot.onStopped!(Promise.resolve())).toThrow(pageFailure);
    await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledWith([expect.objectContaining({
      code: "player.cleanup.failed", severity: "error", message: expect.stringContaining("Device disposal failed"),
    })]));
    expect(() => handle.stop()).toThrow("Player shutdown failed");
    handle.stop();
    expect(owner.dispose).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledOnce();
  });
});
