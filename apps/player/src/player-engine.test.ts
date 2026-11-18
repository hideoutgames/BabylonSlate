import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene, DEFAULT_RENDER_PROJECT_SETTINGS } from "@haptic/core";
import { exportGame } from "@haptic/exporter";
import { createDefaultMaterialDocument } from "@haptic/shader-graph";
import type { AbstractEngine } from "@babylonjs/core";
import type { EngineSession } from "@haptic/render";
import type { PlayerBootHandle, PlayerBootOptions } from "./boot";
import { loadGameFromFiles } from "./artifact";

const { createSession, start } = vi.hoisted(() => ({ createSession: vi.fn(), start: vi.fn() }));
vi.mock("@haptic/render", () => ({ createEngineSession: createSession }));
vi.mock("./boot", () => ({ startPlayer: start }));
import { startPlayerWithEngine } from "./player-engine";

async function game(renderSettings = DEFAULT_RENDER_PROJECT_SETTINGS) {
  const material = createDefaultMaterialDocument("Packed Surface");
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const files = await exportGame({
    platform: "web",
    bundleDebugger: false,
    startupSceneGuid: "scene",
    renderSettings,
    scripts: [],
    assets: [
      { guid: "scene", type: "Scene", sceneGuid: "scene", requiredDependencies: ["material"], bytes: encode(createDefaultScene()) },
      { guid: "material", type: "Material", sceneGuid: "scene", bytes: encode(material) },
    ],
  });
  if (!files.ok) throw new Error(files.error);
  return loadGameFromFiles(files.value.files);
}

describe("packed player Engine lifetime", () => {
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
  let owner: EngineSession;
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
    createSession.mockResolvedValue(owner);
    start.mockReturnValue(player);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("boots on a private canvas that the page shows directly, and releases the player before its engine", async () => {
    const loaded = await game();
    const handle = await startPlayerWithEngine({ game: loaded, canvas });
    const factory = createSession.mock.calls[0]![0];
    const privateCanvas = factory.createCanvas();
    expect(privateCanvas).not.toBe(canvas);
    expect([privateCanvas.width, privateCanvas.height]).toEqual([320, 180]);
    // The game's view shows the Engine canvas itself instead of copying every frame into the page's canvas.
    expect(factory.presentViewsDirectly).toBe(true);
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
    handle.stop();
    handle.stop();
    expect(events).toEqual(["player", "engine"]);
  });

  it("builds the Engine in the exported project's Large World Rendering, off by default", async () => {
    for (const largeWorldRendering of [false, true]) {
      const handle = await startPlayerWithEngine({ game: await game({ ...DEFAULT_RENDER_PROJECT_SETTINGS, largeWorldRendering }), canvas });
      expect(createSession.mock.calls.at(-1)![0].largeWorldRendering).toBe(largeWorldRendering);
      handle.stop();
    }
  });

  it("releases an engine that completes after Stop without starting authored runtime", async () => {
    const loaded = await game();
    const abort = new AbortController();
    createSession.mockImplementation(async () => {
      abort.abort(new Error("Preview stopped"));
      return owner;
    });
    await expect(startPlayerWithEngine({ game: loaded, canvas, signal: abort.signal })).rejects.toBe(abort.signal.reason);
    expect(start).not.toHaveBeenCalled();
    expect(events).toEqual(["engine"]);
  });

  it("releases the engine after startup failure and after a failing Stop", async () => {
    const loaded = await game();
    const startup = new Error("Player startup failed");
    start.mockImplementationOnce(() => { throw startup; });
    await expect(startPlayerWithEngine({ game: loaded, canvas })).rejects.toBe(startup);
    expect(events).toEqual(["engine"]);
    events.length = 0;
    const shutdown = new Error("Worker shutdown failed");
    vi.mocked(player.stop).mockImplementation(() => { events.push("player"); throw shutdown; });
    const handle = await startPlayerWithEngine({ game: loaded, canvas });
    expect(() => handle.stop()).toThrow("Player shutdown failed");
    handle.stop();
    expect(events).toEqual(["player", "engine"]);
  });

  it("keeps frames running on its private Engine until a frame-drained view release settles", async () => {
    const loaded = await game();
    const handle = await startPlayerWithEngine({ game: loaded, canvas });
    const boot = start.mock.calls[0]![0] as PlayerBootOptions;
    // The view's retired resources are released at the next end of frame.
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
    const handle = await startPlayerWithEngine({ game: loaded, canvas });
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

  it("reports a failed deferred Engine disposal without disposing the uncertain Engine again", async () => {
    const loaded = await game();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pageFailure = new Error("Page cleanup failed");
    vi.mocked(owner.dispose).mockImplementation(() => { events.push("engine"); throw new Error("Engine disposal failed"); });
    const onStopped = vi.fn(() => { throw pageFailure; });
    const onDiagnostic = vi.fn();
    const handle = await startPlayerWithEngine({ game: loaded, canvas, onStopped, onDiagnostic });
    const boot = start.mock.calls[0]![0] as PlayerBootOptions;
    expect(() => boot.onStopped!(Promise.resolve())).toThrow(pageFailure);
    await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledWith([expect.objectContaining({
      code: "player.cleanup.failed", severity: "error", message: expect.stringContaining("Engine disposal failed"),
    })]));
    expect(() => handle.stop()).toThrow("Player shutdown failed");
    handle.stop();
    expect(owner.dispose).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledOnce();
  });
});
