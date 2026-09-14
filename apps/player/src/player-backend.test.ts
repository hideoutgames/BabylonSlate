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
  ...await import("@babylonslate/render/material-backend-compatibility"),
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
    startupSceneGuid: "scene",
    customResolution: { ...DEFAULT_RENDER_PROJECT_SETTINGS, backend: "webgpu" },
    scripts: [],
    assets: [
      { guid: "scene", type: "Scene", sceneGuid: "scene", bytes: encode(createDefaultScene()) },
      { guid: "material", type: "Material", sceneGuid: "scene", bytes: encode(material) },
    ],
  });
  if (!files.ok) throw new Error(files.error);
  return loadGameFromFiles(files.value.files);
}

describe("packed player backend lifetime", () => {
  const events: string[] = [];
  let owner: BackendEngineSession;
  let player: PlayerBootHandle;
  const canvas = { width: 320, height: 180 } as HTMLCanvasElement;
  beforeEach(() => {
    vi.resetAllMocks();
    events.length = 0;
    vi.stubGlobal("document", {
      baseURI: "https://game.example/subdir/index.html",
      createElement: () => ({ width: 0, height: 0, remove: vi.fn() }),
    });
    owner = {
      engine: {} as AbstractEngine,
      requestedBackend: "webgpu",
      effectiveBackend: "webgpu",
      dispose: vi.fn(() => { events.push("engine"); }),
    };
    player = {
      ticks: () => 0,
      visuals: () => [],
      meshMaterialNames: () => [],
      executeConsoleCommand: async () => ({ success: true, output: "" }),
      inspectWorld: async () => { throw new Error("No inspection in this fixture"); },
      stop: vi.fn(() => { events.push("player"); return { diagnostics: [] }; }),
    };
    createBackend.mockResolvedValue(owner);
    start.mockReturnValue(player);
  });
  afterEach(() => vi.unstubAllGlobals());

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

  it("passes actual packed Custom GLSL incompatibility to fallback while preserving the saved request", async () => {
    const loaded = await game(true);
    owner.effectiveBackend = "webgl2";
    owner.fallbackReason = "Custom GLSL requires WebGL2.";
    const handle = await startPlayerWithBackend({ game: loaded, canvas });
    expect(createBackend.mock.calls[0]![0].webGpuCompatibilityReason).toContain('Material "Packed Surface" uses Custom GLSL');
    expect(handle.backend).toEqual({ requestedBackend: "webgpu", effectiveBackend: "webgl2", fallbackReason: "Custom GLSL requires WebGL2." });
    expect(loaded.manifest.render.backend).toBe("webgpu");
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
});
