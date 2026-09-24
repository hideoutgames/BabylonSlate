import { mockCubeTextureIO, mockDepthTextureIO } from "./texture-test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Camera, Constants, InputBlock, Matrix, NodeMaterial, NullEngine, PBRMaterial, RawTexture, RenderTargetTexture, Scene, UniversalCamera, Vector3, type Mesh } from "@babylonjs/core";
import {
  SNAPSHOT_FLAG_OVERLAY,
  SNAPSHOT_FLAG_VISIBLE,
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
} from "@babylonslate/bridge";
import {
  createActor,
  areaRectLightBindings,
  outlineBindings,
  createDefaultScene,
  createMeshComponent,
  DEFAULT_RENDER_EFFECTS,
  normalizeRenderProjectSettings,
  engineCommandBus,
  requestEditorDrop,
} from "@babylonslate/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createEngine, syncEditorPlayState } from "./create-engine";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { AREA_EMISSION_EDGE, decodeAreaEmission, encodeAreaEmission, createDefaultParticleEmitterPayload, createDefaultParticleSystemPayload, encodeGlbJsonBin } from "@babylonslate/assets";
import { encodeTriangleGlb } from "./model-mesh";
import { ResourceCache, resourceCacheForEngine } from "./resource-cache";
import { editorMeshName } from "./scene-loader";
import { visualMeshes } from "./visual-meshes";
import { prewarmMaterial } from "./material-compiler";
import { MaterialLibrary } from "./material-library";
import { OwnedPostProcess } from "./owned-post-process";
import { markSceneReadinessDirty, prewarmSceneMaterials, SCENE_SHADER_WARM_TIMEOUT_MS } from "./scene-perf";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import type { SharedOutlineView } from "./shared-outline";
import * as sceneWork from "./scene-work";
import * as snapshotApply from "./snapshot-apply";
import * as presentation from "./presented-frame";
import { SnapshotInterpolator } from "./snapshot-sync";

/**
 * The babylon Vitest project runs under Node. createEngine only needs a
 * listener surface plus width/height for registerView.
 */
function livePassCount(
  camera: { _postProcesses?: Array<unknown | null> } | null | undefined,
): number {
  return camera?._postProcesses?.filter((pass) => pass != null).length ?? 0;
}

class FakeCanvas {
  width = 256;
  height = 256;
  clientWidth = 256;
  clientHeight = 256;
  readonly style = { cursor: "", touchAction: "" };
  readonly listeners = new Map<string, Set<EventListener>>();
  capturedPointers: number[] = [];
  prevented = 0;

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  setPointerCapture(pointerId: number): void {
    this.capturedPointers.push(pointerId);
  }

  getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      width: this.clientWidth,
      height: this.clientHeight,
    };
  }

  getContext(kind: string): unknown {
    if (kind === "2d") return { clearRect() {}, drawImage() {} };
    return null;
  }

  emit(type: string, event: Record<string, unknown>): void {
    const payload = {
      ...event,
      preventDefault: () => {
        this.prevented += 1;
      },
    } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload);
    }
  }
}

function spawnOverlayButton(
  handle: ReturnType<typeof createEngine>,
  layerId = "hud",
  layerBounds?: { width: number; height: number },
): void {
  handle.applyCommand({
    type: "sceneLayerCreate",
    layerId,
    assetGuid: "hud-asset",
    zOrder: 0,
    ownerSceneGuid: null,
    postProcessStack: [],
    ...(layerBounds ? { layerBounds } : {}),
  });
  handle.applyCommand({
    type: "spawn",
    slotId: 1,
    actorGuid: "btn",
    classId: "SceneLayerActor",
    sceneLayerId: layerId,
  });
  handle.applyCommand({
    type: "assignMesh",
    slotId: 1,
    meshAssetGuid: null,
    meshKind: "2dbutton",
    actorGuid: "btn",
    hitTest: "block",
    hasButton: true,
  });
}

function pointerAt(
  x: number,
  y: number,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pointerId: 1,
    clientX: x,
    clientY: y,
    button: 0,
    pointerType: "touch",
    ...extras,
  };
}

describe("Play createEngine view", () => {
  const handles: Array<{ dispose: () => void }> = [];
  const engines: NullEngine[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.dispose();
    }
    while (engines.length > 0) {
      engines.pop()?.dispose();
    }
  });

  it("installs collected editor assets and materials without replaying the previous document", async () => {
    const engine = new NullEngine();
    engines.push(engine);
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { sharedEngine: engine, editor: true });
    handles.push(handle);
    const oldActor = createActor("old", "Old", { components: [createMeshComponent("old-mesh", "box")] });
    const newActor = createActor("next", "Next", { components: [createMeshComponent("next-mesh", "box")] });
    handle.loadScene({ ...createDefaultScene(), actors: [oldActor] });
    const addMesh = vi.spyOn(handle.scene, "addMesh");
    await handle.loadSceneAsync({ ...createDefaultScene(), actors: [newActor] }, {
      signal: new AbortController().signal,
      assets: { pixelsPerUnit: 64 },
      materialDocuments: new Map(),
      materialFunctions: new Map(),
    });
    const created = addMesh.mock.calls.map(([mesh]) => mesh.name);
    addMesh.mockRestore();
    expect(created.filter((name) => name === editorMeshName("old"))).toHaveLength(0);
    expect(created.filter((name) => name === editorMeshName("next"))).toHaveLength(1);
    expect(handle.scene.getMeshByName(editorMeshName("old"))).toBeNull();
    expect(handle.scene.getMeshByName(editorMeshName("next"))?.isDisposed()).toBe(false);
  });

  it("keeps the loading owner when a surface Material completes between realization chunks", async () => {
    const engine = sharedEngine();
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { sharedEngine: engine, editor: true });
    handles.push(handle);
    handle.loadScene({ ...createDefaultScene(), actors: [] });
    const material = createDefaultMaterialDocument();
    material.twoSided = true;
    const next = { ...createDefaultScene(), actors: Array.from({ length: 80 }, (_, index) => {
      const mesh = createMeshComponent(`mesh-${index}`, "ground");
      mesh.properties.materialGuid = "surface";
      return createActor(`receiver-${index}`, "Receiver", { components: [mesh] });
    }) };
    const run = sceneWork.runSceneWork;
    let completedDuringLoad: NodeMaterial | null = null;
    let firstRoot: Mesh | null = null;
    // Control only the cooperative scheduling boundary. The real compiler,
    // library publication callback and scene realization all remain in use.
    const scheduling = vi.spyOn(sceneWork, "runSceneWork").mockImplementation((steps, options) => run(steps, {
      ...options,
      yieldControl: async () => {
        const candidate = handle.scene.getMaterialByName("material:surface");
        if (!(candidate instanceof NodeMaterial) || completedDuringLoad) return;
        completedDuringLoad = candidate;
        firstRoot = handle.editor!.sync.meshForActor("receiver-0");
        expect(handle.editor!.sync.serializedScene()?.actors).toEqual([]);
        await prewarmMaterial(candidate, null);
      },
    }));
    try {
      await handle.loadSceneAsync(next, {
        signal: new AbortController().signal,
        materialDocuments: new Map([["surface", material]]),
      });
      await handle.whenEditorModelsReady();
      expect(completedDuringLoad).toBeInstanceOf(NodeMaterial);
      expect(handle.editor!.sync.serializedScene()).toBe(next);
      expect(handle.editor!.sync.meshForActor("receiver-0")).toBe(firstRoot);
      expect(handle.editor!.sync.actorCount()).toBe(80);
      for (const actor of next.actors)
        expect(handle.editor!.sync.meshForActor(actor.id)?.material).toBe(completedDuringLoad);
    } finally { scheduling.mockRestore(); }
  });

  function sharedEngine(): NullEngine {
    const engine = new NullEngine();
    // These tests drive frames explicitly; keep real loop registration without
    // a competing timer drawing while an async preparation assertion waits.
    vi.spyOn(engine, "_queueNewFrame").mockReturnValue(0);
    mockCubeTextureIO(engine);
    mockDepthTextureIO(engine);
    // NullEngine stores raw bytes but never marks the upload complete. Model
    // the real synchronous raw-texture upload boundary without bypassing the
    // scene's texture readiness checks (individual tests can hold a texture).
    const upload = engine.createRawTexture.bind(engine);
    vi.spyOn(engine, "createRawTexture").mockImplementation((...args) => {
      const texture = upload(...args);
      texture.isReady = true;
      return texture;
    });
    // Keep production FrameGraph ownership, replacing only absent NullEngine
    // MRT driver calls.
    vi.spyOn(engine, "buildTextureLayout").mockImplementation((enabled, backbuffer) =>
      backbuffer ? [0x0405] : enabled.map((value, index) => value ? 0x8ce0 + index : 0));
    vi.spyOn(engine, "bindAttachments").mockImplementation(() => {});
    vi.spyOn(engine, "restoreSingleAttachment").mockImplementation(() => {});
    vi.spyOn(engine, "restoreSingleAttachmentForRenderTarget").mockImplementation(() => {});
    engines.push(engine);
    return engine;
  }

  function playHandle(engine: NullEngine) {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
    });
    handles.push(handle);
    return { handle, canvas };
  }

  function renderViews(engine: NullEngine) {
    if (!engine.getRenderingCanvas())
      vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(new FakeCanvas() as unknown as HTMLCanvasElement);
    return engine._renderViews();
  }

  it("retires particle owners on world replacement and SceneLayer lifecycle commands", async () => {
    const engine = sharedEngine();
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
      sharedEngine: engine, playMode: true,
      textureBytes: new Map([["particle-texture", new Uint8Array([1])]]),
      particleLibrary: {
        emitters: new Map([["emitter", { ...createDefaultParticleEmitterPayload(), textureGuid: "particle-texture" }]]),
        systems: new Map([["system", { ...createDefaultParticleSystemPayload(), emitterGuids: ["emitter"] }]]),
      },
    });
    handles.push(handle);
    const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, handle.scene);
    const acquire = ResourceCache.prototype.acquireTexture;
    let liveLeases = 0;
    vi.spyOn(ResourceCache.prototype, "acquireTexture").mockImplementation(function (this: ResourceCache, ...args) {
      if (args[0] !== "particle-texture") return acquire.apply(this, args);
      liveLeases += 1;
      return { resource: texture, key: "controlled-particle-texture", release: () => { liveLeases -= 1; } };
    });
    const assign = (slotId: number, layer?: string) => {
      handle.applyCommand({ type: "spawn", slotId, actorGuid: `particle-${slotId}`, classId: "Actor", sceneLayerId: layer });
      handle.applyCommand({ type: "assignParticle", slotId, actorGuid: `particle-${slotId}`, componentId: "particle", particleSystemGuid: "system" });
    };
    const createLayer = () => handle.applyCommand({ type: "sceneLayerCreate", layerId: "particles", assetGuid: "layer", zOrder: 0, ownerSceneGuid: null, postProcessStack: [] });
    assign(1);
    assign(2, "particles");
    expect(handle.scene.particleSystems).toHaveLength(1);
    expect(liveLeases).toBe(1);
    createLayer();
    expect(handle.sceneLayerScenes()[0]!.scene.particleSystems).toHaveLength(1);
    expect(liveLeases).toBe(2);
    handle.applyCommand({ type: "sceneLoading", sceneAssetGuid: "next", sceneLoadId: 1 });
    expect(handle.scene.particleSystems).toHaveLength(0);
    expect(liveLeases).toBe(1);
    handle.applyCommand({ type: "sceneLayerRemove", layerId: "particles" });
    expect(liveLeases).toBe(0);
    createLayer(); assign(3, "particles");
    handle.applyCommand({ type: "sceneLayerClear" });
    expect(liveLeases).toBe(0);
    assign(4);
    handle.applyCommand({ type: "despawn", slotId: 4, actorGuid: "particle-4" });
    expect(liveLeases).toBe(0);
    assign(5);
    handle.resetParticleSession();
    expect(liveLeases).toBe(0);
    assign(6);
    handle.dispose();
    await handle.whenReleased();
    expect(liveLeases).toBe(0);
  });

  function postProcessGraphEngine(): NullEngine {
    const engine = sharedEngine();
    Object.assign(engine.getCaps(), {
      maxTextureSize: 4096, maxDrawBuffers: 4, drawBuffersExtension: true,
      depthTextureExtension: true, textureFloatRender: true, textureHalfFloatRender: true,
    });
    // Same absent native allocation boundary as scene-post-process-graph.test:
    // real wrappers/textures and the production graph retain all ownership.
    vi.spyOn(engine, "_createInternalTexture").mockImplementation((size, options) => {
      const creation = typeof options === "object" ? options : {};
      const wrapper = engine.createRenderTargetTexture(size, { ...creation, generateDepthBuffer: false });
      const texture = wrapper.texture!;
      texture.format = creation.format ?? Constants.TEXTUREFORMAT_RGBA;
      wrapper.dispose(true);
      return texture;
    });
    vi.spyOn(engine, "createMultipleRenderTarget").mockImplementation((size) =>
      engine._createHardwareRenderTargetWrapper(true, false, size));
    return engine;
  }

  function editorHandle(engine: NullEngine) {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, { sharedEngine: engine });
    handles.push(handle);
    return { handle, canvas };
  }

  it.each(["editor", "play"] as const)("rolls back late %s construction failure without disturbing shared views", async (kind) => {
    const engine = sharedEngine();
    const { handle: sibling } = editorHandle(engine);
    const { handle: hidden } = editorHandle(engine);
    await sibling.prewarmSceneMaterials();
    await hidden.prewarmSceneMaterials();
    hidden.setRegisterViewEnabled(false);
    // NullEngine hardcodes its scaling getter to 1; model the real engine's
    // mutable scaling boundary so rollback must restore the prior value.
    let hardwareScaling = 1;
    vi.spyOn(engine, "getHardwareScalingLevel").mockImplementation(() => hardwareScaling);
    vi.spyOn(engine, "setHardwareScalingLevel").mockImplementation((level) => { hardwareScaling = level; });
    engine.setHardwareScalingLevel(2);
    const scenes = [...engine.scenes];
    const utilityScenes = [...engine._virtualScenes];
    const views = [...engine.views];
    const enabled = views.map((view) => view.enabled);
    const loops = [...engine.activeRenderLoops];
    const observers = [engine.onEndFrameObservable, engine.onContextLostObservable, engine.onContextRestoredObservable];
    const observerCounts = observers.map((observable) => observable.observers.length);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const retainedLease = sibling.resourceCache.acquireTexture("sibling-texture", engine, bytes);
    const retained = retainedLease.resource;
    const cache = resourceCacheForEngine(engine);
    sibling.setTextureBudget(100, true);
    hidden.setTextureBudget(100, true);
    const failedCanvas = new FakeCanvas();
    const failure = new Error("Injected late construction failure");
    // Cover partial loop registration and a later failure after context/pointer
    // subscriptions have been installed by the Play view.
    const originalRun = engine.runRenderLoop.bind(engine);
    const injection = kind === "editor"
      ? vi.spyOn(engine, "runRenderLoop").mockImplementationOnce((callback) => {
        originalRun(callback);
        throw failure;
      })
      : vi.spyOn(engineCommandBus, "subscribe").mockImplementationOnce(() => { throw failure; });
    try {
      expect(() => createEngine(failedCanvas as unknown as HTMLCanvasElement, {
        sharedEngine: engine,
        editor: kind === "editor",
        playMode: kind === "play",
        hardwareScalingLevel: 1.5,
        textureBudgetEnabled: false,
        textureBytes: new Map([["failed-view-texture", bytes]]),
      })).toThrow(failure);
    } finally {
      injection.mockRestore();
    }
    expect(engine.scenes).toEqual(scenes);
    expect(engine._virtualScenes).toEqual(utilityScenes);
    expect(engine.views).toEqual(views);
    expect(engine.views.map((view) => view.enabled)).toEqual(enabled);
    expect(engine.activeRenderLoops).toEqual(loops);
    expect(engine.getHardwareScalingLevel()).toBe(2);
    expect([...failedCanvas.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    await vi.waitFor(() => expect(observers.map((observable) => observable.observers.length)).toEqual(observerCounts));
    expect(resourceCacheForEngine(engine)).toBe(cache);
    expect(sibling.resourceCache.acquireTexture("sibling-texture", engine, bytes).resource).toBe(retained);
    expect(isDisposedGpuTexture(retained)).toBe(false);
    const retainedBytes = cache.accountedBytes();
    // Accounting only: no GPU or CPU allocation. A failed view's disabled
    // budget must not prevent the remaining clients from evicting unused data.
    cache.account("unused-after-failure", 4 * 1024 ** 3);
    cache.releaseAccounting("unused-after-failure");
    cache.evictToCeiling();
    expect(cache.accountedBytes()).toBe(retainedBytes);
    sibling.scheduler.invalidate("manual");
    const previousFrames = sibling.scheduler.stats().renderedFrames;
    const now = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1_000);
    try { loops[0]!(); } finally { now.mockRestore(); }
    expect(sibling.scheduler.stats().renderedFrames).toBe(previousFrames + 1);
  });

  it("reports rollback errors while continuing to release remaining owners", () => {
    const engine = sharedEngine();
    const constructionError = new Error("Render loop failed");
    const cleanupError = new Error("Scene cleanup failed");
    const run = vi.spyOn(engine, "runRenderLoop").mockImplementationOnce(() => {
      vi.spyOn(engine.scenes.at(-1)!, "dispose").mockImplementationOnce(() => { throw cleanupError; });
      throw constructionError;
    });
    let failure: unknown;
    try {
      createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { sharedEngine: engine, playMode: true });
    } catch (error) { failure = error; } finally { run.mockRestore(); }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(constructionError);
    expect((failure as AggregateError).errors).toEqual([constructionError, cleanupError]);
    expect(engine.scenes).toEqual([]);
    expect(engine.views).toEqual([]);
    expect(engine.activeRenderLoops).toEqual([]);
  });

  it("presents exactly one loading frame under a modal without resuming normal rendering", async () => {
    const engine = sharedEngine();
    const { handle } = playHandle(engine);
    await handle.prewarmSceneMaterials();
    const render = () => renderViews(engine);
    handle.setPaused(true);
    handle.scheduler.setObstructed(true);
    let frames = 0;
    handle.scene.onBeforeRenderObservable.add(() => { expect(handle.scene.frameGraph).not.toBeNull(); });
    handle.scene.onAfterRenderObservable.add(() => { frames += 1; });
    let ready = false;
    const presented = handle.presentFirstFrame().then(() => { ready = true; });
    render();
    expect(frames).toBe(1);
    expect(ready).toBe(false);
    engine.onEndFrameObservable.notifyObservers(engine);
    await presented;
    render();
    expect(frames).toBe(1);
    expect(handle.scheduler.shouldRender(performance.now() + 1000)).toBe(false);
  });

  it("does not acknowledge a copied first frame until its owning GPU fence completes", async () => {
    const engine = sharedEngine();
    const { handle } = playHandle(engine);
    await handle.prewarmSceneMaterials();
    let signaled = false;
    const gl = {
      NO_ERROR: 0, CONTEXT_LOST_WEBGL: 37442, SYNC_GPU_COMMANDS_COMPLETE: 37143,
      WAIT_FAILED: 37149, ALREADY_SIGNALED: 37146, CONDITION_SATISFIED: 37148,
      getError: () => 0, isContextLost: () => false, fenceSync: () => ({}),
      clientWaitSync: () => signaled ? 37148 : 37147, deleteSync: vi.fn(), flush: () => {},
    };
    Object.assign(engine, { _gl: gl });
    handle.setPaused(true);
    let ready = false;
    const presented = handle.presentFirstFrame().then(() => { ready = true; });
    renderViews(engine);
    engine.onEndFrameObservable.notifyObservers(engine);
    await Promise.resolve();
    expect(ready).toBe(false);
    signaled = true;
    await presented;
    expect(ready).toBe(true);
    expect(gl.deleteSync).toHaveBeenCalledOnce();
    Reflect.deleteProperty(engine, "_gl");
  });

  it("applies locked output quality before preparation without resizing inside a scene render owner", async () => {
    const engine = sharedEngine();
    // NullEngine hard-codes scale 1; model the native scale storage boundary.
    let hardwareScaling = 1;
    vi.spyOn(engine, "getHardwareScalingLevel").mockImplementation(() => hardwareScaling);
    vi.spyOn(engine, "setHardwareScalingLevel").mockImplementation((level) => { hardwareScaling = level; });
    const { handle } = playHandle(engine);
    let width = 256, height = 256;
    vi.spyOn(engine, "getRenderWidth").mockImplementation(() => width);
    vi.spyOn(engine, "getRenderHeight").mockImplementation(() => height);
    const resize = vi.spyOn(engine, "setSize").mockImplementation((nextWidth, nextHeight) => {
      if (nextWidth === width && nextHeight === height) return false;
      expect(handle.scene.frameGraph).toBeNull();
      width = nextWidth; height = nextHeight;
      // Pinned WebGPU attachment recreation emits beginFrame synchronously.
      // Keep the real registered-view admission and graph ownership around it.
      engine.onBeginFrameObservable.notifyObservers(engine);
      return true;
    });
    handle.setSize(480, 270);
    handle.setRenderSettings(normalizeRenderProjectSettings({
      quality: { resolution: { scale: 0.8, minScale: 0.8, dynamic: false } },
    }));
    await handle.prewarmSceneMaterials();
    expect(resize).toHaveBeenCalledWith(384, 216);
    expect([width, height]).toEqual([384, 216]);
    const presented = handle.presentFirstFrame();
    renderViews(engine);
    engine.onEndFrameObservable.notifyObservers(engine);
    await presented;
    expect(handle.scene.frameGraph).toBeNull();
  });

  it("restores the editor scale before readmitting shared views when Play stops", async () => {
    const engine = sharedEngine();
    let hardwareScaling = 1;
    let restoring = false;
    vi.spyOn(engine, "getHardwareScalingLevel").mockImplementation(() => hardwareScaling);
    vi.spyOn(engine, "setHardwareScalingLevel").mockImplementation((level) => {
      hardwareScaling = level;
      if (restoring) {
        // WebGPU resizing can synchronously re-enter native view admission.
        expect(engine.views.every((view) => !view.enabled)).toBe(true);
        engine.onBeginFrameObservable.notifyObservers(engine);
      }
    });
    const { handle: editor } = editorHandle(engine);
    editor.setRenderSettings(normalizeRenderProjectSettings({
      quality: { resolution: { scale: 0.8, minScale: 0.8, dynamic: false } },
    }));
    await editor.prewarmSceneMaterials();
    expect(hardwareScaling).toBe(1.25);
    const editorView = engine.views[0]!;
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const { handle: play } = playHandle(engine);
      play.setRenderSettings(normalizeRenderProjectSettings({
        quality: { resolution: { scale: 0.5, minScale: 0.5, dynamic: false } },
      }));
      await play.prewarmSceneMaterials();
      expect(hardwareScaling).toBe(2);
      expect(editorView.enabled).toBe(false);
      restoring = true;
      play.dispose();
      restoring = false;
      await play.whenReleased();
      expect(engine.getHardwareScalingLevel()).toBe(1.25);
      expect(editor.scaling.getLevel()).toBe(1.25);
      expect(engine.views).toEqual([editorView]);
      expect(editorView.enabled).toBe(true);
    }
  });

  it("draws an RTT preview once while every registered canvas retains its paused bitmap", async () => {
    const engine = sharedEngine();
    const nativeDispatch = engine._renderViews;
    const source = new FakeCanvas();
    vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(source as unknown as HTMLCanvasElement);
    const visible = new FakeCanvas();
    const clear = vi.fn();
    const copy = vi.fn();
    vi.spyOn(visible, "getContext").mockReturnValue({ clearRect: clear, drawImage: copy });
    const main = createEngine(visible as unknown as HTMLCanvasElement, { sharedEngine: engine, editor: true });
    const preview = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { sharedEngine: engine, editor: true, present: "rtt" });
    handles.push(main, preview);
    main.setPaused(true);
    await preview.prewarmSceneMaterials();
    const mainDraw = vi.fn();
    const previewDraw = vi.fn();
    main.scene.onAfterRenderObservable.add(mainDraw);
    preview.scene.onAfterRenderObservable.add(previewDraw);
    engine.beginFrame();
    expect(engine.views?.every((view) => !view.enabled)).toBe(true);
    if (!renderViews(engine)) engine._renderFrame();
    engine.endFrame();
    await Promise.resolve();
    expect(previewDraw).toHaveBeenCalledOnce();
    expect(mainDraw).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(engine.activeView).toBeNull();
    expect(engine._currentRenderTarget).toBeNull();
    preview.dispose();
    expect(engine._renderViews).toBe(nativeDispatch);
  });

  it("waits for the exact RTT canvas copy after engine end-frame", async () => {
    const engine = sharedEngine();
    const loops = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas();
    let copied = false;
    vi.spyOn(canvas, "getContext").mockImplementation(() => ({ putImageData: () => { copied = true; } }));
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, { sharedEngine: engine, present: "rtt", playMode: true });
    handles.push(handle);
    handle.setPaused(true);
    await handle.prewarmSceneMaterials();
    let resolve!: (pixels: Uint8Array) => void;
    const pixels = new Promise<Uint8Array>((done) => { resolve = done; });
    const read = vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockReturnValue(pixels);
    const previousImageData = globalThis.ImageData;
    globalThis.ImageData = class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} } as unknown as typeof ImageData;
    let ready = false;
    const presented = handle.presentFirstFrame().then(() => { ready = true; });
    void presented.catch(() => {});
    try {
      loops.mock.calls[0]![0]();
      engine.onEndFrameObservable.notifyObservers(engine);
      await Promise.resolve();
      expect(ready).toBe(false);
      expect(copied).toBe(false);
      expect(read).toHaveBeenCalledOnce();
      resolve(new Uint8Array(256 * 256 * 4));
      await presented;
      expect(ready).toBe(true);
      expect(copied).toBe(true);
    } finally {
      handle.dispose();
      await presented.catch(() => {});
      read.mockRestore();
      globalThis.ImageData = previousImageData;
    }
  });

  it.each(["completed", "stalled"] as const)("waits beyond shader readiness for a slow owned GPU frame that is %s", async (completion) => {
    const engine = sharedEngine();
    const { handle } = playHandle(engine);
    await handle.prewarmSceneMaterials();
    handle.setPaused(true);
    let finishGpu!: () => void;
    let cancelGpu!: (error: Error) => void;
    const gpu = new Promise<void>((resolve, reject) => { finishGpu = resolve; cancelGpu = reject; });
    const cancel = vi.fn(() => cancelGpu(new Error("Owned GPU wait cancelled")));
    const submission = vi.spyOn(presentation, "submitPresentedFrame").mockImplementation((_engine, draw) => {
      draw();
      return { completed: gpu, cancel };
    });
    vi.useFakeTimers();
    let state = "pending";
    const frame = handle.presentFirstFrame().then(() => { state = "ready"; }, error => { state = "failed"; return error as Error; });
    try {
      renderViews(engine);
      engine.onEndFrameObservable.notifyObservers(engine);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(state).toBe("pending");
      expect(cancel).not.toHaveBeenCalled();
      if (completion === "completed") {
        finishGpu();
        await frame;
        expect(state).toBe("ready");
      } else {
        await vi.advanceTimersByTimeAsync(11_000);
        expect(await frame).toMatchObject({ message: expect.stringContaining("loading deadline") });
        expect(state).toBe("failed");
        expect(cancel).toHaveBeenCalledOnce();
      }
    } finally {
      handle.dispose();
      await frame;
      submission.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not spend a loading permit on a sibling view or a hidden document", async () => {
    const engine = sharedEngine();
    const runLoop = vi.spyOn(engine, "runRenderLoop");
    const { handle, canvas } = playHandle(engine);
    const { canvas: sibling } = editorHandle(engine);
    await handle.prewarmSceneMaterials();
    const render = runLoop.mock.calls[0]![0];
    handle.setPaused(true);
    let frames = 0;
    handle.scene.onAfterRenderObservable.add(() => { frames += 1; });
    const presented = handle.presentFirstFrame();
    engine.activeView = engine.views!.find((view) => view.target === sibling)!;
    render();
    expect(frames).toBe(0);
    engine.activeView = engine.views!.find((view) => view.target === canvas)!;
    handle.scheduler.setDocumentVisible(false);
    render();
    expect(frames).toBe(0);
    handle.scheduler.setDocumentVisible(true);
    renderViews(engine);
    engine.onEndFrameObservable.notifyObservers(engine);
    await presented;
    expect(frames).toBe(1);
    engine.activeView = null;
  });

  it("keeps loading through skipped effects until a complete ready frame is presented", async () => {
    const engine = sharedEngine();
    const { handle } = playHandle(engine);
    await handle.prewarmSceneMaterials();
    handle.setPaused(true);
    const ready = vi.fn(() => false);
    const draw = vi.spyOn(handle.scene, "render");
    handle.scene.addIsReadyCheck({ isReady: ready });
    // Custom checks join strict readiness without a Scene observable; the
    // production registration path marks the cached readiness result dirty.
    markSceneReadinessDirty(handle.scene);
    let presented = false;
    const frame = handle.presentFirstFrame().then(() => { presented = true; });
    const render = () => renderViews(engine);
    render();
    engine.onEndFrameObservable.notifyObservers(engine);
    await Promise.resolve();
    expect(presented).toBe(false);
    expect(draw).not.toHaveBeenCalled();
    ready.mockReturnValue(true);
    render();
    engine.onEndFrameObservable.notifyObservers(engine);
    await frame;
    expect(presented).toBe(true);
  });

  it("rejects stale first-frame and shader completions after reload or disposal", async () => {
    const engine = sharedEngine();
    const { handle } = editorHandle(engine);
    const oldFrame = expect(handle.presentFirstFrame()).rejects.toThrow("superseded");
    handle.loadScene(createDefaultScene());
    await oldFrame;
    let finishCompile!: () => void;
    vi.spyOn(handle.scene.defaultMaterial, "forceCompilationAsync").mockReturnValue(
      new Promise((resolve) => { finishCompile = resolve; }),
    );
    // Shared-engine teardown defers scene disposal, so warming aborts through
    // the handle's loading-generation check instead of scene.isDisposed.
    const warming = expect(handle.prewarmSceneMaterials()).rejects.toThrow("superseded or disposed");
    const frame = expect(handle.presentFirstFrame()).rejects.toThrow("disposed");
    handle.dispose();
    finishCompile();
    await Promise.all([warming, frame]);
    await expect(handle.whenMaterialTexturesReady()).rejects.toThrow("disposed");
  });

  it("fails the loading transaction when its first render throws", async () => {
    const engine = sharedEngine();
    const runLoop = vi.spyOn(engine, "runRenderLoop");
    const { handle } = playHandle(engine);
    handle.setPaused(true);
    await handle.prewarmSceneMaterials();
    vi.spyOn(handle.scene, "render").mockImplementation(() => { throw new Error("allocation failed"); });
    const frame = expect(handle.presentFirstFrame()).rejects.toThrow("allocation failed");
    runLoop.mock.calls[0]![0]();
    await frame;
    engine.onEndFrameObservable.notifyObservers(engine);
    expect(handle.scheduler.stats().renderedFrames).toBe(0);
  });

  it("keeps a ready global layer drawing while a different owner waits, and cancels only the removed layer's frame", async () => {
    const engine = sharedEngine();
    const { handle } = playHandle(engine);
    const render = () => renderViews(engine);
    const addLayer = (layerId: string, layerLoadId: number) => {
      handle.applyCommand({ type: "sceneLayerLoading", layerId, layerLoadId, assetGuid: "overlay" });
      handle.applyCommand({ type: "sceneLayerCreate", layerId, assetGuid: "overlay", zOrder: 1, ownerSceneGuid: null, postProcessStack: [] });
      return engine.scenes.at(-1)!;
    };
    const global = addLayer("global", 1);
    await handle.prewarmSceneMaterials({ layerId: "global", layerLoadId: 1 });
    const frames: string[] = [];
    handle.scene.onAfterRenderObservable.add(() => { frames.push("world"); });
    global.onAfterRenderObservable.add(() => { frames.push("global"); });
    global.onBeforeRenderObservable.add(() => { expect(global.frameGraph).not.toBeNull(); });
    const release = handle.scheduler.acquireObstruction();
    handle.applyCommand({ type: "sceneLoading", sceneAssetGuid: "next", sceneLoadId: 2 });
    const first = handle.presentFirstFrame({ layerId: "global", layerLoadId: 1 });
    render();
    engine.onEndFrameObservable.notifyObservers(engine);
    await first;
    expect(frames).toEqual(["global"]);
    const pending = addLayer("pending", 2);
    pending.onAfterRenderObservable.add(() => { frames.push("pending"); });
    const notReady = { isReady: () => false };
    pending.addIsReadyCheck(notReady);
    const time = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1000);
    render();
    expect(frames).toEqual(["global", "global"]);
    handle.setPaused(true);
    render();
    expect(frames).toHaveLength(2);
    const cancelled = expect(handle.presentFirstFrame({ layerId: "pending", layerLoadId: 2 })).rejects.toThrow("removed");
    handle.applyCommand({ type: "sceneLayerRemove", layerId: "pending" });
    await cancelled;
    handle.setPaused(false);
    time.mockRestore();
    release();
  });

  it("waits for owned BRDF decode after texture load without waiting on an unrelated scene texture", async () => {
    const engine = sharedEngine();
    const { handle } = playHandle(engine);
    const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, handle.scene, false);
    const internal = texture.getInternalTexture()!;
    handle.scene.environmentBRDFTexture = texture;
    internal.isReady = false;
    texture.onLoadObservable.notifyObservers(texture);
    let ready = false;
    const loaded = handle.whenMaterialTexturesReady().then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    const unrelated = new Scene(engine);
    const other = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, unrelated, false);
    other.getInternalTexture()!.isReady = false;
    internal.isReady = true;
    await loaded;
    expect(ready).toBe(true);
    unrelated.dispose();
  });

  it("fails texture readiness only when the pending set stalls, naming what is still unready", async () => {
    vi.useFakeTimers();
    try {
      const engine = sharedEngine();
      const { handle } = playHandle(engine);
      const first = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, handle.scene, false);
      first.name = "slow-albedo";
      const second = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, handle.scene, false);
      second.name = "stuck-normal";
      first.getInternalTexture()!.isReady = false;
      second.getInternalTexture()!.isReady = false;
      let outcome: "ready" | Error | null = null;
      const pending = handle.whenMaterialTexturesReady().then(() => { outcome = "ready"; }, (error: Error) => { outcome = error; });
      // Progress just before the stall budget keeps the load alive past the total budget.
      await vi.advanceTimersByTimeAsync(SCENE_SHADER_WARM_TIMEOUT_MS - 100);
      expect(outcome).toBeNull();
      first.getInternalTexture()!.isReady = true;
      await vi.advanceTimersByTimeAsync(SCENE_SHADER_WARM_TIMEOUT_MS - 100);
      expect(outcome).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as unknown as Error).message).toBe(
        'Material textures did not become ready before the loading deadline. Still waiting for 1: texture "stuck-normal".',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not evict shared GPU textures on restore or retain disposed handle callbacks", () => {
    const engine = sharedEngine();
    const { handle: first } = editorHandle(engine);
    const { handle: live } = editorHandle(engine);
    const release = vi.spyOn(live.resourceCache, "releaseGpuTextures");
    const logs: string[] = [];
    const unsubscribe = engineCommandBus.subscribe((command) => {
      if (command.type === "log") logs.push(command.message);
    });
    first.dispose();
    engine.onContextLostObservable.notifyObservers(engine);
    engine.onContextRestoredObservable.notifyObservers(engine);
    expect(release).not.toHaveBeenCalled();
    expect(live.scene.isDisposed).toBe(false);
    expect(logs.filter((message) => /context restored/i.test(message))).toHaveLength(1);
    unsubscribe();
  });

  it("scopes editor Drop requests to one viewport and unregisters on disposal", () => {
    const engine = sharedEngine();
    const make = (editorViewportId: string, floorY: number) => {
      const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { sharedEngine: engine, editor: true, editorViewportId });
      handles.push(handle);
      handle.loadScene({ ...createDefaultScene(), actors: [
        createActor("selected", "Selected", { transform: { position: [0, 10, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, components: [createMeshComponent("mesh", "box")] }),
        createActor("floor", "Floor", { transform: { position: [0, floorY, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, components: [createMeshComponent("floor-mesh", "box")] }),
      ] });
      return handle;
    };
    const scene = make("scene-viewport", 0);
    const prefab = make("prefab-viewport", 3);
    expect(requestEditorDrop("scene-viewport", ["selected"])[0]?.position).toEqual([0, 1.5, 0]);
    expect(requestEditorDrop("prefab-viewport", ["selected"])[0]?.position).toEqual([0, 4.5, 0]);
    expect(requestEditorDrop("scene-viewport", ["selected"], 8.5)).toEqual([]);
    expect(requestEditorDrop("scene-viewport", ["selected"], 8.6)[0]?.position).toEqual([0, 1.5, 0]);
    expect(requestEditorDrop("prefab-viewport", ["selected"], 5.5)).toEqual([]);
    expect(requestEditorDrop("prefab-viewport", ["selected"], 5.6)[0]?.position).toEqual([0, 4.5, 0]);
    expect(scene.editor!.sync.meshForActor("selected")!.position.y).toBe(10);
    prefab.dispose(); handles.pop();
    expect(requestEditorDrop("prefab-viewport", ["selected"])).toEqual([]);
  });

  it("does not plant document authored lights from play-mode loadScene", () => {
    const { handle } = playHandle(sharedEngine());
    const scene = createDefaultScene();
    handle.loadScene({
      ...scene,
      actors: [
        createActor("lamp", "Lamp", {
          components: [
            {
              id: "lamp-light",
              classId: "LightComponent",
              properties: { lightKind: "point", intensity: 1 },
            },
          ],
        }),
      ],
    });
    expect(handle.scene.getLightByName("authoredLight:lamp")).toBeNull();
    expect(
      handle.scene.meshes.filter((mesh) => mesh.name.startsWith("editorActor:")),
    ).toHaveLength(0);
  });

  it("still applies environment from play-mode loadScene", () => {
    const { handle } = playHandle(sharedEngine());
    const scene = createDefaultScene();
    handle.loadScene({
      ...scene,
      settings: {
        ...scene.settings,
        environmentColor: [0.1, 0.2, 0.3],
        fogEnabled: true,
        fogColor: [0.4, 0.5, 0.6],
        fogStart: 2,
        fogEnd: 40,
      },
    });
    expect(handle.scene.clearColor.r).toBeCloseTo(0.1);
    expect(handle.scene.clearColor.g).toBeCloseTo(0.2);
    expect(handle.scene.clearColor.b).toBeCloseTo(0.3);
    expect(handle.scene.fogEnabled).toBe(true);
    expect(handle.scene.fogStart).toBe(2);
    expect(handle.scene.fogEnd).toBe(40);
  });

  it("does not seed the default scene actors into a Play scene", () => {
    const { handle } = playHandle(sharedEngine());
    const actorMeshes = handle.scene.meshes.filter((mesh) =>
      mesh.name.startsWith("editorActor:"),
    );
    expect(actorMeshes).toHaveLength(0);
    expect(handle.scene.getMeshByName(editorMeshName("actor-1"))).toBeNull();
  });

  it("still seeds the default scene into a non-Play view", () => {
    const { handle } = editorHandle(sharedEngine());
    expect(handle.scene.getMeshByName(editorMeshName("actor-1"))).not.toBeNull();
  });

  it("lights an isolated prefab preview through PBR and Unlit mode changes", () => {
    const engine = sharedEngine();
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      editor: true,
      previewLighting: true,
    });
    handles.push(handle);
    const data = createDefaultScene();
    data.actors = [
      createActor("prefab", "Prefab", {
        components: [createMeshComponent("mesh", "box")],
      }),
    ];
    handle.loadScene(data);
    expect(
      handle.scene.lights.some((light) => light.isEnabled() && light.intensity > 0),
    ).toBe(true);
    const lights = [...handle.scene.lights];
    handle.editor!.setViewportShadingMode("unlit");
    expect(handle.scene.lightsEnabled).toBe(false);
    expect((handle.scene.defaultMaterial as PBRMaterial).unlit).toBe(true);
    handle.loadScene(data);
    handle.editor!.setViewportShadingMode("pbr");
    expect(handle.scene.lightsEnabled).toBe(true);
    expect((handle.scene.defaultMaterial as PBRMaterial).unlit).toBe(false);
    expect(handle.scene.lights).toEqual(lights);
    expect(data.actors).toHaveLength(1);
  });

  it("registerView clears the overlay canvas before copying", () => {
    const engine = sharedEngine();
    const registerView = vi.spyOn(engine, "registerView");
    const { canvas } = playHandle(engine);
    expect(registerView).toHaveBeenCalledWith(canvas, undefined, true);
  });

  it("takes a 2d blit context on the view canvas before registerView", () => {
    const engine = sharedEngine();
    const canvas = new FakeCanvas();
    const getContext = vi.spyOn(canvas, "getContext");
    const registerView = vi.spyOn(engine, "registerView");
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      editor: true,
    });
    handles.push(handle);
    expect(getContext).toHaveBeenCalledWith("2d");
    expect(registerView).toHaveBeenCalledWith(canvas, undefined, true);
    expect(getContext.mock.invocationCallOrder[0]!).toBeLessThan(
      registerView.mock.invocationCallOrder[0]!,
    );
  });

  it("skips registerView when the view canvas cannot host a 2d blit", () => {
    const engine = sharedEngine();
    const canvas = new FakeCanvas();
    canvas.getContext = () => null;
    const registerView = vi.spyOn(engine, "registerView");
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      editor: true,
    });
    handles.push(handle);
    expect(registerView).not.toHaveBeenCalled();
  });

  it("whenEditorModelsReady waits for Play GLB instantiations", async () => {
    const { handle } = playHandle(sharedEngine());
    handle.setMeshAssets({
      modelBytes: new Map([["hero", encodeTriangleGlb()]]),
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 2,
      meshKind: "box",
      meshAssetGuid: "hero",
    });
    expect(handle.modelLoadCount()).toBeGreaterThan(0);
    const root = handle.scene.getMeshByName("actor-2");
    await handle.whenEditorModelsReady();
    expect(visualMeshes(root!).length).toBeGreaterThan(0);
  });

  it("keeps failed Play GLB imports unready until the failed assignment is replaced", async () => {
    const { handle } = playHandle(sharedEngine());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    handle.setMeshAssets({ modelBytes: new Map([
      ["broken", encodeGlbJsonBin({ asset: { version: "99.0" } }, new Uint8Array())],
      ["hero", encodeTriangleGlb()],
    ]) });
    try {
      handle.applyCommand({ type: "assignMesh", slotId: 2, meshKind: "box", meshAssetGuid: "broken" });
      // Delivery does not await model promises. A later waiter must still see
      // the real loader failure, with no unhandled fire-and-forget rejection.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(handle.whenEditorModelsReady()).rejects.toThrow();
      await expect(handle.whenEditorModelsReady()).rejects.toThrow();
      expect(visualMeshes(handle.scene.getMeshByName("actor-2")!)).toHaveLength(0);
      handle.applyCommand({ type: "assignMesh", slotId: 2, meshKind: "box", meshAssetGuid: "hero" });
      await handle.whenEditorModelsReady();
      expect(visualMeshes(handle.scene.getMeshByName("actor-2")!)).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  it("does not throw when a shared view canvas has no getContext", () => {
    const engine = sharedEngine();
    const canvas = new FakeCanvas();
    canvas.getContext = undefined as unknown as typeof canvas.getContext;
    const registerView = vi.spyOn(engine, "registerView");
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      editor: true,
    });
    handles.push(handle);
    expect(registerView).not.toHaveBeenCalled();
  });

  it("dispose stops the same render loop callback it registered", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const stopRenderLoop = vi.spyOn(engine, "stopRenderLoop");
    const { handle } = playHandle(engine);
    expect(runRenderLoop).toHaveBeenCalled();
    const callback = runRenderLoop.mock.calls[0]?.[0];
    handle.dispose();
    handles.pop();
    expect(stopRenderLoop).toHaveBeenCalledWith(callback);
  });

  it("Play holds a continuous render lease so every blit is preceded by scene.render", () => {
    const { handle } = playHandle(sharedEngine());
    handle.scheduler.noteRendered();
    expect(handle.scheduler.shouldRender()).toBe(true);
  });

  it("snapshots _drawCalls after scene.render instead of reading unset engine.drawCalls", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const { handle } = playHandle(engine);
    const callback = runRenderLoop.mock.calls[0]?.[0];
    expect(callback).toBeTypeOf("function");
    expect((engine as { drawCalls?: number }).drawCalls).toBeUndefined();
    expect(handle.drawCalls()).toBe(0);

    vi.spyOn(handle.scene, "render").mockImplementation(() => {
      engine._drawCalls.addCount(2, false);
    });
    callback!();
    expect(handle.drawCalls()).toBe(2);

    vi.spyOn(handle.scene, "render").mockImplementation(() => {
      engine._drawCalls.addCount(1, false);
    });
    callback!();
    expect(handle.drawCalls()).toBe(1);
  });

  it("honors live Play frame caps without adding render cost to the interval", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
      frameCap: 30,
    });
    handles.push(handle);
    const renderLoop = runRenderLoop.mock.calls[0]![0];
    let renders = 0;
    // Keep Babylon rendering real; only model its elapsed CPU cost.
    handle.scene.onAfterRenderObservable.add(() => {
      renders += 1;
      now += 4;
    });
    for (const [second, cap] of [30, 60, 15, 30].entries()) {
      // The first second must use the configured cap before any console setter.
      if (second > 0) handle.applyCommand({ type: "setFrameCap", fps: cap });
      const before = renders;
      for (let frame = 0; frame < 60; frame += 1) {
        now = second * 1000 + frame * (1000 / 60);
        renderLoop();
      }
      expect(renders - before).toBe(cap);
    }
  });

  it("re-attaches the gizmo to the live mesh after setMeshAssets rebuilds", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      editor: true,
    });
    handles.push(handle);
    const editor = handle.editor;
    expect(editor).not.toBeNull();
    editor!.gizmos.setTool("translate");
    editor!.setSelectedActors(["actor-1"]);
    const selected = editor!.sync.meshForActor("actor-1");
    expect(editor!.gizmos.attachedMesh()).toBe(selected);

    handle.setMeshAssets({
      textureBytes: new Map([["tex-1", new Uint8Array([1, 2, 3, 4])]]),
    });
    const live = editor!.sync.meshForActor("actor-1");
    expect(live).not.toBeNull();
    expect(live!.isDisposed()).toBe(false);
    expect(editor!.gizmos.attachedMesh()).toBe(live);
    expect(selected!.isDisposed()).toBe(true);
  });

  it("uses an overlay transform box instead of TRS gizmos when requested", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      editor: true,
      overlayTransformBox: true,
    });
    handles.push(handle);
    handle.loadScene({
      ...createDefaultScene("2d"),
      actors: [createActor("banner", "Banner")],
    });
    handle.editor!.setSelectedActors(["banner"]);
    expect(handle.editor!.gizmos.attachedMesh()).not.toBeNull();
    expect(handle.editor!.gizmos.positionGizmo.attachedMesh).toBeNull();
    expect(handle.editor!.gizmos.rotationGizmo.attachedMesh).toBeNull();
    expect(handle.editor!.gizmos.scaleGizmo.attachedMesh).toBeNull();
  });

  it("keeps world 2D on axis gizmos when overlayTransformBox is off", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      editor: true,
      viewportMode: "2d",
    });
    handles.push(handle);
    handle.loadScene({
      ...createDefaultScene("2d"),
      actors: [createActor("sprite", "Sprite")],
    });
    handle.editor!.gizmos.setTool("translate");
    handle.editor!.setSelectedActors(["sprite"]);
    expect(handle.editor!.gizmos.positionGizmo.attachedMesh).toBe(
      handle.editor!.gizmos.attachedMesh(),
    );
    expect(handle.editor!.gizmos.positionGizmo.zGizmo.isEnabled).toBe(false);
  });

  it("attaches the gizmo to a Model actor whose placeholder is unpickable", async () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      editor: true,
    });
    handles.push(handle);
    const mesh = createMeshComponent("mesh", "box");
    mesh.properties.assetGuid = "hero";
    handle.setMeshAssets({
      modelBytes: new Map([["hero", encodeTriangleGlb()]]),
    });
    handle.loadScene({
      ...createDefaultScene(),
      actors: [createActor("hero", "Hero", { components: [mesh] })],
    });
    await handle.whenEditorModelsReady();
    const root = handle.editor!.sync.meshForActor("hero");
    expect(root?.isPickable).toBe(false);
    handle.editor!.gizmos.setTool("translate");
    handle.editor!.setSelectedActors(["hero"]);
    expect(handle.editor!.gizmos.attachedMesh()).toBe(root);
  });

  it("does not attach the gizmo to a locked Model actor", async () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      editor: true,
    });
    handles.push(handle);
    const mesh = createMeshComponent("mesh", "box");
    mesh.properties.assetGuid = "hero";
    handle.setMeshAssets({
      modelBytes: new Map([["hero", encodeTriangleGlb()]]),
    });
    handle.loadScene({
      ...createDefaultScene(),
      actors: [
        createActor("hero", "Hero", { locked: true, components: [mesh] }),
      ],
    });
    await handle.whenEditorModelsReady();
    handle.editor!.gizmos.setTool("translate");
    handle.editor!.setSelectedActors(["hero"]);
    expect(handle.editor!.gizmos.attachedMesh()).toBeNull();
  });

  it("prepares Scene resizing without clearing its last visible drawing buffer", () => {
    const canvas = new FakeCanvas();
    canvas.width = 256;
    canvas.height = 256;
    canvas.clientWidth = 800;
    canvas.clientHeight = 360;
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, {
      sharedEngine: sharedEngine(),
      editor: true,
    });
    handles.push(handle);
    handle.resize();
    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(256);
  });

  it("holds an unready steady-state editor frame without copying or counting it and resumes automatically", async () => {
    const engine = sharedEngine();
    const source = new FakeCanvas() as unknown as HTMLCanvasElement;
    vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(source);
    const canvas = new FakeCanvas();
    const copy = vi.fn();
    vi.spyOn(canvas, "getContext").mockReturnValue({ clearRect() {}, drawImage: copy });
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, { sharedEngine: engine, editor: true });
    handles.push(handle);
    await handle.prewarmSceneMaterials();
    const frame = () => { engine.beginFrame(); renderViews(engine); engine.endFrame(); };
    frame();
    expect(handle.scheduler.stats().renderedFrames).toBe(1);
    let ready = false;
    handle.scene.addIsReadyCheck({ isReady: () => ready });
    markSceneReadinessDirty(handle.scene);
    frame();
    frame();
    expect(copy).toHaveBeenCalledTimes(1);
    expect(handle.scheduler.stats().renderedFrames).toBe(1);
    expect(handle.renderDiagnostics().presentation).toMatchObject({ drawn: 1, copied: 1, held: 2 });
    ready = true;
    frame();
    expect(copy).toHaveBeenCalledTimes(2);
    expect(handle.scheduler.stats().renderedFrames).toBe(2);
  });

  it("retains prepared rendering and material ownership through transform commits and equivalent asset refreshes", async () => {
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { sharedEngine: sharedEngine(), editor: true });
    handles.push(handle);
    const mesh = createMeshComponent("mesh", "box");
    const data = { ...createDefaultScene(), actors: [createActor("a", "A", { components: [mesh] })] };
    handle.setMaterialDocuments(new Map());
    handle.loadScene(data);
    await handle.prewarmSceneMaterials();
    const renderers = [...handle.scene.objectRenderers];
    expect(renderers.length).toBeGreaterThan(0);
    const visual = handle.editor!.sync.meshForActor("a")!;
    const material = visual.material;
    const next = structuredClone(data);
    next.actors[0]!.transform.position = [3, 2, 1];
    handle.loadScene(next);
    handle.setMaterialDocuments(new Map());
    expect(handle.scene.objectRenderers).toEqual(renderers);
    expect(handle.editor!.sync.meshForActor("a")).toBe(visual);
    expect(visual.material).toBe(material);
    expect(visual.position.asArray()).toEqual([3, 2, 1]);
  });

  it("retries a layer's first-frame copy when an unready world holds the composite", async () => {
    const engine = sharedEngine();
    const { handle } = playHandle(engine);
    const frame = () => { engine.beginFrame(); renderViews(engine); engine.endFrame(); };
    await handle.prewarmSceneMaterials();
    frame();
    handle.applyCommand({ type: "sceneLayerLoading", layerId: "overlay", layerLoadId: 1, assetGuid: "overlay" });
    handle.applyCommand({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay", zOrder: 1, ownerSceneGuid: null, postProcessStack: [] });
    const owner = { layerId: "overlay", layerLoadId: 1 };
    await handle.prewarmSceneMaterials(owner);
    let worldReady = false;
    handle.scene.addIsReadyCheck({ isReady: () => worldReady });
    markSceneReadinessDirty(handle.scene);
    handle.setPaused(true);
    let presented = false;
    const pending = handle.presentFirstFrame(owner).then(() => { presented = true; });
    const copied = handle.renderDiagnostics().presentation!.copied;
    frame();
    await Promise.resolve();
    expect(presented).toBe(false);
    expect(handle.renderDiagnostics().presentation!.copied).toBe(copied);
    worldReady = true;
    frame();
    await pending;
    expect(presented).toBe(true);
    expect(handle.renderDiagnostics().presentation!.copied).toBe(copied + 1);
  });

  it("reports hidden pre-snapshot visuals and their published world positions", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
    });
    handles.push(handle);
    for (const [slotId, meshKind] of [[0, "box"], [1, "sphere"]] as const) {
      handle.applyCommand({
        type: "assignMesh",
        slotId,
        meshKind,
        meshAssetGuid: null,
      });
    }
    expect(handle.playVisualStates().every((visual) => !visual.visible)).toBe(true);

    const snapshot = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(snapshot, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 2,
      scriptMs: 0,
      physicsMs: 0,
    });
    for (const [index, slotId, x] of [[0, 0, -3], [1, 1, 3]] as const) {
      writeActorSlot(snapshot, index, {
        slotId,
        position: { x, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        flags: 1,
      });
    }
    handle.pushSnapshot(snapshot);
    runRenderLoop.mock.calls[0]?.[0]?.();
    expect(handle.playVisualStates()).toEqual([
      expect.objectContaining({
        slotId: 0,
        name: "actor-0",
        visible: true,
        position: [-3, 1, 0],
        worldMatrixPosition: [-3, 1, 0],
      }),
      expect.objectContaining({
        slotId: 1,
        name: "actor-1",
        visible: true,
        position: [3, 1, 0],
        worldMatrixPosition: [3, 1, 0],
      }),
    ]);
  });

  it("exposes snapshot actor orientation for spatial audio cones", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
    });
    handles.push(handle);
    const snapshot = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(snapshot, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(snapshot, 0, {
      slotId: 0,
      position: { x: 2, y: 3, z: 4 },
      rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    handle.pushSnapshot(snapshot);
    runRenderLoop.mock.calls[0]?.[0]?.();
    const pose = handle.lastActorPositions()[0];
    expect(pose).toMatchObject({ slotId: 0, x: 2, y: 3, z: 4 });
    expect(pose?.qx).toBeCloseTo(0, 5);
    expect(pose?.qy).toBeCloseTo(Math.SQRT1_2, 5);
    expect(pose?.qz).toBeCloseTo(0, 5);
    expect(pose?.qw).toBeCloseTo(Math.SQRT1_2, 5);
  });

  function actorSnapshot(frameId: number, x: number): Float32Array {
    const snapshot = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(snapshot, {
      frameId,
      tickIndex: frameId,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(snapshot, 0, {
      slotId: 0,
      position: { x, y: 1, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: SNAPSHOT_FLAG_VISIBLE,
    });
    return snapshot;
  }

  it("applies each sampled snapshot once per frame for a registered Play view", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const { handle } = playHandle(engine);
    const renderLoop = runRenderLoop.mock.calls[0]![0]!;
    // Babylon's frame: begin-frame admission prepares the view, the view render
    // loop prepares it again, then end-frame observers restore admission.
    const frame = () => {
      engine.onBeginFrameObservable.notifyObservers(engine);
      renderLoop();
      engine.onEndFrameObservable.notifyObservers(engine);
    };
    const apply = vi.spyOn(snapshotApply, "applySnapshotToScene");
    try {
      handle.applyCommand({
        type: "assignMesh",
        slotId: 0,
        meshKind: "box",
        meshAssetGuid: null,
      });
      handle.pushSnapshot(actorSnapshot(1, 0));
      frame();
      expect(apply).toHaveBeenCalledTimes(1);
      frame();
      expect(apply).toHaveBeenCalledTimes(1);

      handle.pushSnapshot(actorSnapshot(2, 4));
      frame();
      expect(apply).toHaveBeenCalledTimes(2);
      expect(handle.lastActorPositions()[0]?.x).toBe(4);

      // A binding-mutating command invalidates the applied identity even when
      // the sampled snapshot is unchanged.
      handle.applyCommand({
        type: "assignMesh",
        slotId: 1,
        meshKind: "sphere",
        meshAssetGuid: null,
      });
      frame();
      expect(apply).toHaveBeenCalledTimes(3);
    } finally {
      apply.mockRestore();
    }
  });

  it("re-applies the same snapshot frame when the sampled alpha changes", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const { handle } = playHandle(engine);
    const renderLoop = runRenderLoop.mock.calls[0]![0]!;
    const frame = () => {
      engine.onBeginFrameObservable.notifyObservers(engine);
      renderLoop();
      engine.onEndFrameObservable.notifyObservers(engine);
    };
    handle.applyCommand({
      type: "assignMesh",
      slotId: 0,
      meshKind: "box",
      meshAssetGuid: null,
    });
    handle.pushSnapshot(actorSnapshot(1, 0));
    handle.pushSnapshot(actorSnapshot(2, 10));
    const apply = vi.spyOn(snapshotApply, "applySnapshotToScene");
    // The host samples between the pushed pair; force the interpolation alpha
    // through the interpolator boundary so the pose really differs.
    const realSample = SnapshotInterpolator.prototype.sample;
    let forcedAlpha: number | null = null;
    const sample = vi
      .spyOn(SnapshotInterpolator.prototype, "sample")
      .mockImplementation(function (this: SnapshotInterpolator, alpha: number) {
        return realSample.call(this, forcedAlpha ?? alpha);
      });
    try {
      forcedAlpha = 0.5;
      frame();
      expect(apply).toHaveBeenCalledTimes(1);
      expect(handle.lastActorPositions()[0]?.x).toBeCloseTo(5);
      frame();
      expect(apply).toHaveBeenCalledTimes(1);

      forcedAlpha = 0.75;
      frame();
      expect(apply).toHaveBeenCalledTimes(2);
      expect(handle.lastActorPositions()[0]?.x).toBeCloseTo(7.5);
    } finally {
      sample.mockRestore();
      apply.mockRestore();
    }
  });

  it("restores an already-blocked material dirty mechanism after snapshot apply", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const { handle } = playHandle(engine);
    handle.scene.blockMaterialDirtyMechanism = true;
    handle.pushSnapshot(actorSnapshot(1, 0));
    engine.onBeginFrameObservable.notifyObservers(engine);
    runRenderLoop.mock.calls[0]?.[0]?.();
    engine.onEndFrameObservable.notifyObservers(engine);
    expect(handle.scene.blockMaterialDirtyMechanism).toBe(true);
  });

  it("syncs the audio listener once per applied snapshot even when the frame cap skips the render", async () => {
    const { AudioService } = await import("./audio-service");
    const { FakeAudioPlaybackBackend } = await import("./audio-playback-backend");
    const listener = vi.spyOn(AudioService.prototype, "syncListener");
    try {
      const engine = sharedEngine();
      const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
      const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
      const handle = createEngine(canvas, {
        sharedEngine: engine,
        playMode: true,
        frameCap: 1,
        audioBackend: new FakeAudioPlaybackBackend(),
      });
      handles.push(handle);
      await handle.prewarmSceneMaterials();
      const renderLoop = runRenderLoop.mock.calls[0]![0]!;
      const frame = () => {
        engine.onBeginFrameObservable.notifyObservers(engine);
        renderLoop();
        engine.onEndFrameObservable.notifyObservers(engine);
      };
      handle.pushSnapshot(actorSnapshot(1, 0));
      frame();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(handle.scheduler.stats().renderedFrames).toBe(1);

      // The 1 fps cap refuses the next draw, but the applied snapshot still
      // owns audio: one listener sync for the newly pushed snapshot.
      handle.pushSnapshot(actorSnapshot(2, 4));
      frame();
      expect(handle.scheduler.stats().renderedFrames).toBe(1);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      listener.mockRestore();
    }
  });

  it("reports shared-engine GPU attribution and null gpuMs with two registered Play views", async () => {
    const engine = sharedEngine();
    const first = playHandle(engine);
    const second = playHandle(engine);
    await first.handle.prewarmSceneMaterials();
    await second.handle.prewarmSceneMaterials();
    // A Play handle disables sibling views on construction so the overlay owns
    // the framebuffer; re-enable the first to model two live Play clients.
    first.handle.setRegisterViewEnabled(true);
    first.handle.pushSnapshot(actorSnapshot(1, 0));
    engine.onBeginFrameObservable.notifyObservers(engine);
    renderViews(engine);
    engine.onEndFrameObservable.notifyObservers(engine);
    // Model a timer-capable driver for attribution only; NullEngine supplies no
    // GPU sample, and these diagnostics must not attribute a shared frame to one view.
    Object.assign(engine.getCaps(), { timerQuery: {} });
    const diagnostics = first.handle.renderDiagnostics();
    expect(diagnostics.gpuAttribution).toBe("shared-engine");
    expect(diagnostics.gpuMs).toBeNull();
    expect(diagnostics.pressure?.gpuMs).toBeNull();
    expect(diagnostics.pressure?.cpuMs).toBeGreaterThanOrEqual(0);
  });

  it("feeds cpuMs-only pressure samples for free-running editor views", async () => {
    const engine = sharedEngine();
    const { handle } = editorHandle(engine);
    await handle.prewarmSceneMaterials();
    const renderLoop = () => renderViews(engine);
    engine.onBeginFrameObservable.notifyObservers(engine);
    renderLoop();
    engine.onEndFrameObservable.notifyObservers(engine);
    engine.onBeginFrameObservable.notifyObservers(engine);
    renderLoop();
    engine.onEndFrameObservable.notifyObservers(engine);
    const pressure = handle.renderDiagnostics().pressure;
    expect(pressure?.cpuMs).toBeGreaterThanOrEqual(0);
    // Editor viewports are free-running: presented-frame intervals measure
    // host event-loop contention, not frame cost, and must not feed the valve.
    expect(pressure?.presentationMs).toBeNull();
    expect(pressure?.gpuMs).toBeNull();
  });

  it("rebinds editor MeshComponent materials after setMaterialDocuments", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      editor: true,
    });
    handles.push(handle);
    const mesh = createMeshComponent("c1", "box");
    mesh.properties.materialGuid = "mat-1";
    handle.loadScene({
      ...createDefaultScene(),
      actors: [createActor("a", "A", { components: [mesh] })],
    });
    const visual = handle.editor!.sync.meshForActor("a");
    expect(visual).not.toBeNull();
    expect(visual?.material?.name ?? "").not.toContain("mat-1");

    handle.setMaterialDocuments(
      new Map([["mat-1", createDefaultMaterialDocument()]]),
    );
    expect(handle.editor!.sync.meshForActor("a")).toBe(visual);
    expect(visual?.material?.name).toContain("mat-1");
  });

  it("syncEditorPlayState unpauses, resizes, and invalidates when Play ends", () => {
    const engine = sharedEngine();
    const resize = vi.spyOn(engine, "resize");
    const { handle } = editorHandle(engine);
    handle.setPaused(true);
    handle.scheduler.noteRendered();
    expect(handle.scheduler.shouldRender()).toBe(false);

    syncEditorPlayState(handle, false);

    expect(handle.scheduler.shouldRender()).toBe(true);
    expect(resize).toHaveBeenCalled();
  });

  it("disables the Scene registerView while overlay Play owns the framebuffer", () => {
    const engine = sharedEngine();
    const { handle: editor, canvas: editorCanvas } = editorHandle(engine);
    const playCanvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const play = createEngine(playCanvas, {
      sharedEngine: engine,
      playMode: true,
    });

    const editorView = engine.views.find((view) => view.target === editorCanvas);
    const playView = engine.views.find((view) => view.target === playCanvas);
    expect(editorView?.enabled).toBe(false);
    expect(playView?.enabled).toBe(true);

    play.dispose();
    syncEditorPlayState(editor, false);
    expect(editorView?.enabled).toBe(true);
  });

  it("syncEditorPlayState disables the editor view while playing", () => {
    const engine = sharedEngine();
    const { handle, canvas } = editorHandle(engine);
    expect(engine.views.find((view) => view.target === canvas)?.enabled).toBe(
      true,
    );

    syncEditorPlayState(handle, true);
    expect(engine.views.find((view) => view.target === canvas)?.enabled).toBe(
      false,
    );
  });

  it("does not setSize from a disabled Scene view while Play is open", () => {
    const engine = sharedEngine();
    const { handle, canvas } = editorHandle(engine);
    Object.assign(canvas, { clientWidth: 640, clientHeight: 360 });
    syncEditorPlayState(handle, true);
    const setSize = vi.spyOn(engine, "setSize");
    handle.resize();
    expect(setSize).not.toHaveBeenCalled();
  });

  it("keeps Play autoClear on after Intermediate so frames do not accumulate", () => {
    const { handle } = playHandle(sharedEngine());
    expect(handle.scene.autoClear).toBe(true);
  });

  it("uses authored environmentColor as the Play clear color", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
      environmentColor: [0.2, 0.4, 0.6],
    });
    handles.push(handle);
    expect(handle.scene.clearColor.r).toBeCloseTo(0.2);
    expect(handle.scene.clearColor.g).toBeCloseTo(0.4);
    expect(handle.scene.clearColor.b).toBeCloseTo(0.6);
    expect(handle.scene.clearColor.a).toBe(1);
  });

  it("does not drop a hardware scaling tier on WebGL context restore", () => {
    const engine = sharedEngine();
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
      hardwareScalingLevel: 1,
    });
    handles.push(handle);
    const logs: string[] = [];
    const unsubscribe = engineCommandBus.subscribe((command) => {
      if (command.type === "log") logs.push(command.message);
    });
    handle.scaling.dropTier();
    expect(handle.scaling.getLevel()).toBe(1.25);
    engine.onContextLostObservable.notifyObservers(engine);
    engine.onContextRestoredObservable.notifyObservers(engine);
    expect(handle.scaling.getLevel()).toBe(1);
    expect(logs.some((message) => /context lost/i.test(message))).toBe(true);
    expect(logs.some((message) => /context restored/i.test(message))).toBe(
      true,
    );
    unsubscribe();
  });

  it("applies Engine Settings hardware scaling to the shared Engine", () => {
    const engine = sharedEngine();
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
      hardwareScalingLevel: 1.5,
    });
    handles.push(handle);
    expect(handle.scaling.getLevel()).toBe(1.5);
  });

  it("does not supersample below the Engine Settings hardware scaling floor", () => {
    const engine = sharedEngine();
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
      hardwareScalingLevel: 1,
      frameCap: 30,
    });
    handles.push(handle);
    for (let i = 0; i < 40; i++) {
      handle.scaling.noteFramePressure({ presentationMs: null, cpuMs: 4, gpuMs: null });
    }
    expect(handle.scaling.getLevel()).toBe(1);
  });

  it("uses the view frame cap as the scaling valve target", () => {
    const engine = sharedEngine();
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
      hardwareScalingLevel: 1,
      frameCap: 30,
    });
    handles.push(handle);
    // 20ms is slow vs 60fps (16.7ms) but cheap vs a 30fps cap (33ms).
    for (let i = 0; i < 40; i++) {
      handle.scaling.noteFramePressure({ presentationMs: null, cpuMs: 20, gpuMs: null });
    }
    expect(handle.scaling.getLevel()).toBe(1);
  });

  it.each([false, true])("keeps post-process materials and passes after asynchronous readiness (Play: %s)", async (playMode) => {
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
      sharedEngine: sharedEngine(),
      playMode,
      editor: !playMode,
      materialDocuments: new Map([
        ["pp", createDefaultMaterialDocument("Scene Color", "postProcess")],
      ]),
    });
    try {
      handle.setPostProcessStack([
        { materialGuid: "pp", enabled: true },
        { materialGuid: "pp", enabled: true },
      ]);
      await handle.prewarmSceneMaterials();
      const material = handle.scene.getMaterialByName("material:pp");
      expect(material).toBeInstanceOf(NodeMaterial);
      const camera = handle.scene.activeCamera!;
      const passes = camera._postProcesses.filter((pass) => pass != null);
      expect(passes).toHaveLength(2);

      await prewarmMaterial(material as NodeMaterial, null);
      // Two independent pass materials intentionally share this display name.
      expect(handle.scene.materials).toContain(material);
      expect(camera._postProcesses.filter((pass) => pass != null)).toEqual(passes);
      expect(handle.postProcessPassCount()).toBe(2);

      handle.setPostProcessStack([]);
      expect(livePassCount(camera)).toBe(0);
      expect(handle.scene.getMaterialByName("material:pp")).toBeNull();
    } finally {
      handle.dispose();
    }
  });

  it("routes editor, Play and layer post effects through their coordinators", async () => {
    const attach = vi.spyOn(SceneRenderCoordinator.prototype, "attachPostProcess");
    const options = { sharedEngine: sharedEngine(), materialDocuments: new Map([["pp", createDefaultMaterialDocument("Scene Color", "postProcess")]]), postProcessStack: [{ materialGuid: "pp", enabled: true }] };
    const editor = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { ...options, editor: true });
    handles.push(editor);
    editor.setPostProcessStack(options.postProcessStack);
    await editor.prewarmSceneMaterials();
    expect(attach.mock.calls.some(([value]) => value.scene === editor.scene && value.camera === editor.scene.activeCamera && value.deviceBuffers === undefined)).toBe(true);
    expect(editor.postProcessPassCount()).toBe(1);
    const play = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { ...options, playMode: true });
    handles.push(play);
    expect(attach.mock.calls.some(([value]) => value.scene === play.scene && value.camera === play.scene.activeCamera && value.deviceBuffers === undefined)).toBe(true);
    play.applyCommand({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay", zOrder: 0, ownerSceneGuid: null, postProcessStack: options.postProcessStack });
    const layer = play.sceneLayerScenes()[0]!.scene;
    expect(attach.mock.calls.some(([value]) => value.scene === layer && value.camera === layer.activeCamera && value.deviceBuffers === undefined)).toBe(true);
  });

  it("keeps shared Scene and cache resources alive until graph retirement settles after Stop", async () => {
    const engine = sharedEngine();
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { sharedEngine: engine, playMode: true });
    handles.push(handle);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const retire = SceneRenderCoordinator.prototype.retire;
    vi.spyOn(SceneRenderCoordinator.prototype, "retire").mockImplementation(function (this: SceneRenderCoordinator) {
      return retire.call(this).then(() => held);
    });
    const retireTextures = vi.spyOn(handle.resourceCache, "dispose");
    const stopped = vi.spyOn(engine, "stopRenderLoop");
    handle.dispose();
    expect(stopped).toHaveBeenCalled();
    expect(handle.scene.isDisposed).toBe(false);
    expect(engine.isDisposed).toBe(false);
    expect(retireTextures).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => { expect(handle.scene.isDisposed).toBe(true); });
    expect(retireTextures).toHaveBeenCalledOnce();
    expect(engine.isDisposed).toBe(false);
  });

  it("keeps shared Scene and MaterialLibrary owners until a held native release confirms", async () => {
    const engine = sharedEngine();
    const document = createDefaultMaterialDocument("Blur", "postProcess");
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      editor: true,
      materialDocuments: new Map([["pp", document]]),
    });
    handles.push(handle);
    // Editor handles seed the default scene, which owns the post-process stack.
    handle.setPostProcessStack([{ materialGuid: "pp", enabled: true }]);
    await handle.prewarmSceneMaterials();
    const pass = handle.scene.activeCamera!._postProcesses.filter(Boolean).at(-1) as OwnedPostProcess;
    expect(pass).toBeInstanceOf(OwnedPostProcess);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(pass, "isReleased", "get").mockReturnValue(false);
    vi.spyOn(pass, "whenReleased").mockReturnValue(held);
    const disposeLibrary = vi.spyOn(MaterialLibrary.prototype, "dispose");
    const stopped = vi.spyOn(engine, "stopRenderLoop");
    handle.dispose();
    expect(stopped).toHaveBeenCalled();
    expect(handle.scene.isDisposed).toBe(false);
    expect(disposeLibrary).not.toHaveBeenCalled();
    release();
    await handle.whenReleased();
    await vi.waitFor(() => { expect(handle.scene.isDisposed).toBe(true); });
    expect(disposeLibrary).toHaveBeenCalled();
    expect(engine.isDisposed).toBe(false);
  });

  it("awaits a rendering-quality replaced post-process generation at shared teardown", async () => {
    const engine = sharedEngine();
    const document = createDefaultMaterialDocument("Blur", "postProcess");
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      editor: true,
      materialDocuments: new Map([["pp", document]]),
    });
    handles.push(handle);
    handle.setPostProcessStack([{ materialGuid: "pp", enabled: true }]);
    await handle.prewarmSceneMaterials();
    const retired = handle.scene.activeCamera!._postProcesses.filter(Boolean).at(-1) as OwnedPostProcess;
    expect(retired).toBeInstanceOf(OwnedPostProcess);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(retired, "isReleased", "get").mockReturnValue(false);
    vi.spyOn(retired, "whenReleased").mockReturnValue(held);
    // A postprocessing resolutionScale change rebuilds the stack generation;
    // the first override only establishes the quality baseline.
    handle.setLocalQualityOverrides({ postprocessing: { resolutionScale: 0.5 } });
    handle.setLocalQualityOverrides({ postprocessing: { resolutionScale: 0.25 } });
    await handle.prewarmSceneMaterials();
    expect(handle.postProcessPassCount()).toBe(1);
    expect(handle.scene.activeCamera!._postProcesses.filter(Boolean).at(-1)).not.toBe(retired);
    handle.dispose();
    expect(handle.scene.isDisposed).toBe(false);
    release();
    await handle.whenReleased();
    await vi.waitFor(() => { expect(handle.scene.isDisposed).toBe(true); });
    expect(engine.isDisposed).toBe(false);
  });

  it("quarantines shared Scene owners when actual release never confirms", async () => {
    const engine = sharedEngine();
    const document = createDefaultMaterialDocument("Blur", "postProcess");
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      editor: true,
      materialDocuments: new Map([["pp", document]]),
    });
    handles.push(handle);
    handle.setPostProcessStack([{ materialGuid: "pp", enabled: true }]);
    await handle.prewarmSceneMaterials();
    const pass = handle.scene.activeCamera!._postProcesses.filter(Boolean).at(-1) as OwnedPostProcess;
    expect(pass).toBeInstanceOf(OwnedPostProcess);
    vi.spyOn(pass, "isReleased", "get").mockReturnValue(false);
    vi.spyOn(pass, "whenReleased").mockRejectedValue(new Error("Native release never confirmed."));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    handle.dispose();
    await expect(handle.whenReleased()).rejects.toThrow();
    expect(handle.scene.isDisposed).toBe(false);
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes("quarantined")),
    ).toHaveLength(1);
    expect(engine.isDisposed).toBe(false);
  });

  it("disposes shared Scene owners after actual release when the bounded report is uncertain", async () => {
    const engine = sharedEngine();
    const document = createDefaultMaterialDocument("Blur", "postProcess");
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      editor: true,
      materialDocuments: new Map([["pp", document]]),
    });
    handles.push(handle);
    handle.setPostProcessStack([{ materialGuid: "pp", enabled: true }]);
    await handle.prewarmSceneMaterials();
    const pass = handle.scene.activeCamera!._postProcesses.filter(Boolean).at(-1) as OwnedPostProcess;
    expect(pass).toBeInstanceOf(OwnedPostProcess);
    // An uncertain bounded report warns but never authorizes or blocks
    // disposal: the confirmed actual release still permits it.
    vi.spyOn(pass, "whenDisposed").mockRejectedValue(new Error("Bounded cleanup report timed out."));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    handle.dispose();
    expect(handle.scene.isDisposed).toBe(false);
    await handle.whenReleased();
    await vi.waitFor(() => { expect(handle.scene.isDisposed).toBe(true); });
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes("uncertain")),
    ).toHaveLength(1);
    expect(engine.isDisposed).toBe(false);
  });

  it("routes current-owner entry writes into independent instances and replays disabled passes after rebuild", async () => {
    const engine = postProcessGraphEngine();
    const document = createDefaultMaterialDocument("Gain", "postProcess");
    document.nodes.push(
      { id: "gain", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Gain", value: [0.5] } },
      { id: "multiply", type: "math.multiply", position: { x: 0, y: 0 }, properties: {} },
    );
    document.edges = document.edges.filter((edge) => edge.id !== "e-scene-output");
    document.edges.push(
      { id: "color", sourceNodeId: "sceneColor", sourcePinId: "color", targetNodeId: "multiply", targetPinId: "a" },
      { id: "gain", sourceNodeId: "gain", sourcePinId: "out", targetNodeId: "multiply", targetPinId: "b" },
      { id: "out", sourceNodeId: "multiply", sourcePinId: "out", targetNodeId: "output", targetPinId: "color" },
    );
    const authored = [
      { id: "first", materialGuid: "gain", enabled: true, parameters: { Gain: { kind: "float" as const, value: 0.25 } } },
      { id: "second", materialGuid: "gain", enabled: true },
      { id: "disabled", materialGuid: "gain", enabled: false },
    ];
    const before = structuredClone({ document, authored });
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
      sharedEngine: engine, playMode: true, materialDocuments: new Map([["gain", document]]), postProcessStack: authored,
    });
    handles.push(handle);
    const draw = () => renderViews(engine);
    const values = (scene: Scene) => scene.materials.filter((material): material is NodeMaterial => material instanceof NodeMaterial && material.name === "material:gain")
      .map((material) => (material.getBlockByName("gain") as InputBlock).value);
    const worldOwner = { kind: "scene" as const, sceneAssetGuid: "world", sceneLoadId: 1 };
    const write = (owner: Extract<import("@babylonslate/bridge").CommandMessage, { type: "setPostProcessMaterialParameter" }>["owner"], entryId: string, value: number) =>
      handle.applyCommand({ type: "setPostProcessMaterialParameter", owner, entryId, materialAssetGuid: "gain", parameterName: "Gain", parameter: { kind: "float", value } });
    handle.applyCommand({ type: "sceneLoading", sceneAssetGuid: "world", sceneLoadId: 1 });
    write(worldOwner, "first", 0.7);
    await handle.prewarmSceneMaterials();
    expect(values(handle.scene)).toEqual([0.25, 0.5]);
    const present = async (owner?: { layerId: string; layerLoadId: number }) => {
      await handle.prewarmSceneMaterials(owner);
      const frame = handle.presentFirstFrame(owner);
      draw(); engine.onEndFrameObservable.notifyObservers(engine); await frame;
    };
    await present();
    write(worldOwner, "first", 0.7); write(worldOwner, "disabled", 0.9);
    expect(values(handle.scene)).toEqual([0.7, 0.5]);
    handle.setPostProcessStack(authored.map((entry) => ({ ...entry, enabled: true })));
    await handle.prewarmSceneMaterials();
    expect(values(handle.scene)).toEqual([0.7, 0.5, 0.9]);
    handle.setPostProcessingEnabled(false); expect(values(handle.scene)).toEqual([]);
    handle.setPostProcessingEnabled(true); await handle.prewarmSceneMaterials(); expect(values(handle.scene)).toEqual([0.7, 0.5, 0.9]);
    handle.applyCommand({ type: "sceneLayerLoading", layerId: "overlay", layerLoadId: 1, assetGuid: "overlay-asset" });
    handle.applyCommand({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay-asset", zOrder: 0, ownerSceneGuid: null, postProcessStack: authored });
    const layer = handle.sceneLayerScenes()[0]!.scene;
    const layerOwner = { kind: "sceneLayer" as const, layerId: "overlay", layerLoadId: 1 };
    write(layerOwner, "first", 0.6); await handle.prewarmSceneMaterials({ layerId: "overlay", layerLoadId: 1 }); expect(values(layer)).toEqual([0.25, 0.5]);
    await present({ layerId: "overlay", layerLoadId: 1 });
    write(layerOwner, "first", 0.6); write(layerOwner, "disabled", 0.8);
    handle.applyCommand({ type: "sceneLayerPostProcess", layerId: "overlay", postProcessStack: authored.map((entry) => ({ ...entry, enabled: true })) });
    await handle.prewarmSceneMaterials({ layerId: "overlay", layerLoadId: 1 });
    expect(values(layer)).toEqual([0.6, 0.5, 0.8]); expect(values(handle.scene)).toEqual([0.7, 0.5, 0.9]);
    write({ ...worldOwner, sceneLoadId: 0 }, "first", 0.1);
    write({ ...layerOwner, layerLoadId: 0 }, "first", 0.1);
    expect(values(layer)).toEqual([0.6, 0.5, 0.8]); expect(values(handle.scene)).toEqual([0.7, 0.5, 0.9]);
    handle.applyCommand({ type: "sceneLoading", sceneAssetGuid: "world", sceneLoadId: 2 });
    const reloaded = createDefaultScene(); reloaded.settings.postProcessStack = authored;
    handle.loadScene(reloaded); write(worldOwner, "first", 0.1);
    await handle.prewarmSceneMaterials();
    expect(values(handle.scene)).toEqual([0.25, 0.5]);
    await present();
    write({ ...worldOwner, sceneLoadId: 2 }, "first", 0.7);
    expect(values(handle.scene)).toEqual([0.7, 0.5]);
    handle.applyCommand({ type: "sceneLoading", sceneAssetGuid: "world", sceneLoadId: 3 });
    handle.loadScene(reloaded);
    await handle.prewarmSceneMaterials();
    expect(values(handle.scene)).toEqual([0.25, 0.5]);
    handle.applyCommand({ type: "sceneLayerRemove", layerId: "overlay" }); write(layerOwner, "first", 0.1);
    expect(handle.sceneLayerScenes()).toEqual([]);
    expect({ document, authored }).toEqual(before);
  });

  it("attaches an authored post-process stack when the local gate is on", async () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: postProcessGraphEngine(),
      playMode: true,
      postProcessingEnabled: true,
      postProcessStack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      materialDocuments: new Map([
        ["pp", createDefaultMaterialDocument("Blur", "postProcess")],
      ]),
    });
    handles.push(handle);
    await handle.prewarmSceneMaterials();
    expect(handle.postProcessPassCount()).toBeGreaterThan(0);
  });

  it("keeps world post-process on the world camera when a SceneLayer is created", async () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: postProcessGraphEngine(),
      playMode: true,
      postProcessingEnabled: true,
      postProcessStack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      materialDocuments: new Map([
        ["pp", createDefaultMaterialDocument("Blur", "postProcess")],
      ]),
    });
    handles.push(handle);
    await handle.prewarmSceneMaterials();
    const worldPasses = handle.postProcessPassCount();
    expect(worldPasses).toBeGreaterThan(0);
    handle.applyCommand({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 1,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    expect(handle.postProcessPassCount()).toBe(worldPasses);
    const overlay = handle.sceneLayerScenes()[0];
    expect(overlay?.scene).not.toBe(handle.scene);
    expect(overlay?.scene.autoClear).toBe(false);
    expect(overlay?.scene.lightsEnabled).toBe(false);
    expect(livePassCount(overlay?.scene.activeCamera)).toBe(0);
  });

  it("parents overlay spawn meshes into the SceneLayer scene and draws by z-order", async () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
    });
    handles.push(handle);
    handle.setPaused(true);
    handle.applyCommand({
      type: "sceneLayerCreate",
      layerId: "back",
      assetGuid: "hud",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    handle.applyCommand({
      type: "sceneLayerCreate",
      layerId: "front",
      assetGuid: "hud",
      zOrder: 3,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    handle.applyCommand({
      type: "spawn",
      slotId: 4,
      actorGuid: "banner",
      classId: "SceneLayerActor",
      sceneLayerId: "front",
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: null,
      meshKind: "2dtexture",
    });
    const front = handle.sceneLayerScenes().find((layer) => layer.layerId === "front");
    expect(front?.scene.getMeshByName("actor-4")).not.toBeNull();
    expect(handle.scene.getMeshByName("actor-4")).toBeNull();
    await prewarmSceneMaterials(front!.scene);

    const order: string[] = [];
    handle.scene.onAfterRenderObservable.add(() => {
      order.push("world");
    });
    for (const layer of handle.sceneLayerScenes()) {
      layer.scene.onAfterRenderObservable.add(() => {
        order.push(layer.layerId);
      });
    }
    handle.setPaused(false);
    runRenderLoop.mock.calls[0]?.[0]?.();
    expect(order).toEqual(["world", "back", "front"]);
  });

  it("does not parent overlay spawn meshes into the world when the layer scene is missing", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
    });
    handles.push(handle);
    handle.applyCommand({
      type: "spawn",
      slotId: 4,
      actorGuid: "banner",
      classId: "SceneLayerActor",
      sceneLayerId: "front",
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: null,
      meshKind: "2dtexture",
    });
    expect(handle.scene.getMeshByName("actor-4")).toBeNull();
    expect(handle.sceneLayerScenes()).toHaveLength(0);

    handle.applyCommand({
      type: "sceneLayerCreate",
      layerId: "front",
      assetGuid: "hud",
      zOrder: 3,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    const front = handle.sceneLayerScenes().find((layer) => layer.layerId === "front");
    expect(front?.scene.getMeshByName("actor-4")).not.toBeNull();
    expect(handle.scene.getMeshByName("actor-4")).toBeNull();
  });

  it("holds overlay-only assignMesh off the world until spawn tags a layer scene", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
    });
    handles.push(handle);
    handle.applyCommand({
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: null,
      meshKind: "2dtexture",
    });
    expect(handle.scene.getMeshByName("actor-4")).toBeNull();
    handle.applyCommand({
      type: "spawn",
      slotId: 4,
      actorGuid: "banner",
      classId: "SceneLayerActor",
      sceneLayerId: "front",
    });
    handle.applyCommand({
      type: "sceneLayerCreate",
      layerId: "front",
      assetGuid: "hud",
      zOrder: 3,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    const front = handle.sceneLayerScenes().find((layer) => layer.layerId === "front");
    expect(front?.scene.getMeshByName("actor-4")).not.toBeNull();
    expect(handle.scene.getMeshByName("actor-4")).toBeNull();
  });

  it("holds sprite assignMesh off the world until overlay spawn tags a layer scene", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
    });
    handles.push(handle);
    handle.applyCommand({
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: null,
      meshKind: "sprite",
    });
    expect(handle.scene.getMeshByName("actor-4")).toBeNull();
    handle.applyCommand({
      type: "spawn",
      slotId: 4,
      actorGuid: "banner",
      classId: "SceneLayerActor",
      sceneLayerId: "front",
    });
    handle.applyCommand({
      type: "sceneLayerCreate",
      layerId: "front",
      assetGuid: "hud",
      zOrder: 3,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    const front = handle.sceneLayerScenes().find((layer) => layer.layerId === "front");
    expect(front?.scene.getMeshByName("actor-4")).not.toBeNull();
    expect(handle.scene.getMeshByName("actor-4")).toBeNull();
  });

  it("plants sprite assignMesh on the world after a world spawn", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
    });
    handles.push(handle);
    handle.applyCommand({
      type: "assignMesh",
      slotId: 2,
      meshAssetGuid: null,
      meshKind: "sprite",
    });
    expect(handle.scene.getMeshByName("actor-2")).toBeNull();
    handle.applyCommand({
      type: "spawn",
      slotId: 2,
      actorGuid: "hero",
      classId: "Actor",
    });
    expect(handle.scene.getMeshByName("actor-2")).not.toBeNull();
    expect(handle.sceneLayerScenes()).toHaveLength(0);
  });

  it("keeps scene-owned overlay sprite commands off the world Scene", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
    });
    handles.push(handle);
    handle.applyCommand({
      type: "sceneLayerCreate",
      layerId: "hud-instance",
      assetGuid: "hud",
      zOrder: 0,
      ownerSceneGuid: "world-a",
      postProcessStack: [],
    });
    handle.applyCommand({
      type: "spawn",
      slotId: 7,
      actorGuid: "banner",
      classId: "SceneLayerActor",
      sceneLayerId: "hud-instance",
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 7,
      meshAssetGuid: null,
      meshKind: "sprite",
      actorGuid: "banner",
      sceneLayerId: "hud-instance",
    });
    const overlay = handle.sceneLayerScenes().find(
      (layer) => layer.layerId === "hud-instance",
    );
    expect(overlay?.scene.getMeshByName("actor-7")).not.toBeNull();
    expect(handle.scene.getMeshByName("actor-7")).toBeNull();
  });

  it("keeps graph createSceneLayer sprite commands off the world Scene", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
    });
    handles.push(handle);
    handle.applyCommand({
      type: "sceneLayerCreate",
      layerId: "graph-hud",
      assetGuid: "hud",
      zOrder: 5,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    handle.applyCommand({
      type: "spawn",
      slotId: 8,
      actorGuid: "banner",
      classId: "SceneLayerActor",
      sceneLayerId: "graph-hud",
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 8,
      meshAssetGuid: null,
      meshKind: "sprite",
      actorGuid: "banner",
      sceneLayerId: "graph-hud",
    });
    const overlay = handle.sceneLayerScenes().find(
      (layer) => layer.layerId === "graph-hud",
    );
    expect(overlay?.scene.getMeshByName("actor-8")).not.toBeNull();
    expect(handle.scene.getMeshByName("actor-8")).toBeNull();
  });

  it("keeps overlay box assignMesh off the world Scene", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
    });
    handles.push(handle);
    handle.applyCommand({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 9,
      meshAssetGuid: null,
      meshKind: "box",
      actorGuid: "panel",
      sceneLayerId: "hud",
    });
    const overlay = handle.sceneLayerScenes().find((layer) => layer.layerId === "hud");
    expect(overlay?.scene.getMeshByName("actor-9")).not.toBeNull();
    expect(handle.scene.getMeshByName("actor-9")).toBeNull();
  });

  it("keeps overlay HUD ortho and NDC stable when the world perspective camera moves", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
    });
    handles.push(handle);
    handle.applyCommand({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud",
      zOrder: 0,
      ownerSceneGuid: "world-a",
      postProcessStack: [],
    });
    handle.applyCommand({
      type: "spawn",
      slotId: 3,
      actorGuid: "banner",
      classId: "SceneLayerActor",
      sceneLayerId: "hud",
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 3,
      meshAssetGuid: null,
      meshKind: "2dtexture",
      actorGuid: "banner",
      sceneLayerId: "hud",
    });
    const overlay = handle.sceneLayerScenes().find((layer) => layer.layerId === "hud");
    const overlayScene = overlay?.scene;
    const overlayCam = overlayScene?.activeCamera as UniversalCamera | null;
    const mesh = overlayScene?.getMeshByName("actor-3");
    expect(overlayCam?.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
    expect(mesh).not.toBeNull();
    expect(handle.scene.getMeshByName("actor-3")).toBeNull();

    const worldCam = handle.scene.activeCamera as UniversalCamera;
    worldCam.mode = Camera.PERSPECTIVE_CAMERA;
    worldCam.fov = 0.9;
    worldCam.position.set(0, 1, -8);
    mesh!.position.set(1.25, 0.4, 0);
    mesh!.computeWorldMatrix(true);
    overlayScene!.updateTransformMatrix();
    const viewport = overlayCam!.viewport.toGlobal(
      engine.getRenderWidth(),
      engine.getRenderHeight(),
    );
    const project = () =>
      Vector3.Project(
        mesh!.getAbsolutePosition(),
        Matrix.Identity(),
        overlayScene!.getTransformMatrix(),
        viewport,
      );
    const before = project();

    worldCam.position.x += 10;
    worldCam.rotation.y += 0.6;
    worldCam.fov = 1.35;
    handle.scene.updateTransformMatrix();
    runRenderLoop.mock.calls[0]?.[0]?.();
    overlayScene!.updateTransformMatrix();
    const after = project();
    expect(overlayScene?.activeCamera).toBe(overlayCam);
    expect(overlayCam?.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
    expect(overlayCam?.position.z).toBeCloseTo(-10);
    expect(handle.scene.getMeshByName("actor-3")).toBeNull();
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("does not plant overlay-flagged snapshot meshes in the world before spawn", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
    });
    handles.push(handle);
    const snapshot = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(snapshot, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(snapshot, 0, {
      slotId: 4,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: SNAPSHOT_FLAG_VISIBLE | SNAPSHOT_FLAG_OVERLAY,
    });
    handle.pushSnapshot(snapshot);
    runRenderLoop.mock.calls[0]?.[0]?.();
    expect(handle.scene.getMeshByName("actor-4")).toBeNull();
  });

  it("parents assignMesh with sceneLayerId into the overlay scene without a prior spawn", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
    });
    handles.push(handle);
    handle.applyCommand({
      type: "sceneLayerCreate",
      layerId: "front",
      assetGuid: "hud",
      zOrder: 3,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: null,
      meshKind: "2dtexture",
      sceneLayerId: "front",
    });
    const overlay = handle.sceneLayerScenes().find((layer) => layer.layerId === "front");
    expect(overlay?.scene.getMeshByName("actor-4")).not.toBeNull();
    expect(handle.scene.getMeshByName("actor-4")).toBeNull();
  });

  it("attaches the authored stack when postProcessingEnabled is omitted", async () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
      postProcessStack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      materialDocuments: new Map([
        ["pp", createDefaultMaterialDocument("Blur", "postProcess")],
      ]),
    });
    handles.push(handle);
    // Play routes the stack through the render coordinator; passes/tasks are
    // instantiated once preparation selects the graph or native path.
    await handle.prewarmSceneMaterials();
    expect(handle.postProcessPassCount()).toBeGreaterThan(0);
  });

  it("skips the authored stack when the local gate is off, then restores it", async () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
      postProcessingEnabled: false,
      postProcessStack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      materialDocuments: new Map([
        ["pp", createDefaultMaterialDocument("Blur", "postProcess")],
      ]),
    });
    handles.push(handle);
    await handle.prewarmSceneMaterials();
    expect(handle.postProcessPassCount()).toBe(0);
    handle.setPostProcessingEnabled(true);
    await handle.prewarmSceneMaterials();
    expect(handle.postProcessPassCount()).toBeGreaterThan(0);
    handle.setPostProcessingEnabled(false);
    expect(handle.postProcessPassCount()).toBe(0);
  });

  it("applies project effects after the editor coordinator prepares its native capability fallback", async () => {
    const engine = sharedEngine();
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { sharedEngine: engine, editor: true });
    handles.push(handle);
    // The viewport applies settings through the before-render quality pass;
    // the first pass only records the baseline key, matching a rendered frame
    // before Project Settings commits.
    handle.scene.onBeforeRenderObservable.notifyObservers(handle.scene);
    handle.setRenderSettings({
      effects: {
        ...DEFAULT_RENDER_EFFECTS,
        bloom: { enabled: true, threshold: 0.9, weight: 0.5, kernel: 32, scale: 0.5 },
      },
    });
    handle.scene.onBeforeRenderObservable.notifyObservers(handle.scene);
    await handle.prewarmSceneMaterials();
    const camera = handle.scene.activeCamera!;
    const passes = camera._postProcesses.filter(Boolean);
    expect(passes.map((pass) => pass!.getClassName())).toEqual([
      "ExtractHighlightsPostProcess",
      "BlurPostProcess",
      "BlurPostProcess",
      "BloomMergePostProcess",
    ]);
    expect(handle.postProcessPassCount()).toBe(4);
    // Admission gates on camera.isReady: a deferred-compile pass can never
    // become ready while the gate withholds the frame that would compile it.
    for (const pass of passes)
      expect(pass!.getEffect(), pass!.name).toBeTruthy();
  });

  it("keeps overlay 2DMaterial assignMaterial as an overlay unlit compile", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
      materialDocuments: new Map([["mat-1", createDefaultMaterialDocument()]]),
    });
    handles.push(handle);
    handle.applyCommand({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    handle.applyCommand({
      type: "spawn",
      slotId: 4,
      actorGuid: "banner",
      classId: "SceneLayerActor",
      sceneLayerId: "hud",
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: "mat-1",
      meshKind: "2dmaterial",
      actorGuid: "banner",
      sceneLayerId: "hud",
    });
    handle.applyCommand({
      type: "assignMaterial",
      slotId: 4,
      materialAssetGuid: "mat-1",
    });
    const overlay = handle.sceneLayerScenes().find((layer) => layer.layerId === "hud");
    const mesh = overlay?.scene.getMeshByName("actor-4");
    expect(mesh).not.toBeNull();
    expect(handle.scene.getMeshByName("actor-4")).toBeNull();
    expect(mesh?.material?.name).toContain(":unlit");
    expect(handle.playMeshMaterialNames()).toEqual(
      expect.arrayContaining([expect.stringContaining(":unlit")]),
    );
  });

  it("resolves assignMaterial through the scene-local material library", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
      materialDocuments: new Map([["mat-1", createDefaultMaterialDocument()]]),
    });
    handles.push(handle);
    const callback = runRenderLoop.mock.calls[0]?.[0];
    handle.applyCommand({
      type: "assignMesh",
      slotId: 1,
      meshKind: "box",
      meshAssetGuid: null,
    });
    const buf = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(buf, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(buf, 0, {
      slotId: 1,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    handle.pushSnapshot(buf);
    callback?.();
    handle.applyCommand({
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: "mat-1",
    });
    const mesh = handle.scene.getMeshByName("actor-1");
    expect(mesh?.material?.name).toContain("mat-1");
    expect(handle.assignedMaterialGuids()).toEqual(["mat-1"]);
    expect(handle.playMeshMaterialNames()).toEqual(
      expect.arrayContaining([expect.stringContaining("mat-1")]),
    );
  });

  it("records a mesh material after a possessing Default Camera is assigned", () => {
    const { handle } = playHandle(sharedEngine());
    handle.applyCommand({
      type: "assignMesh",
      slotId: 0,
      meshKind: "box",
      meshAssetGuid: null,
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 1,
      meshKind: "camera",
      meshAssetGuid: null,
      camera: {
        projectionMode: "perspective",
        fieldOfView: 60,
        isDefault: true,
      },
    });
    handle.applyCommand({ type: "possessCamera", slotId: 1 });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 2,
      meshKind: "box",
      meshAssetGuid: null,
    });
    handle.applyCommand({
      type: "assignMaterial",
      slotId: 2,
      materialAssetGuid: "mat-rock",
    });
    expect(handle.assignedMaterialGuids()).toEqual(["mat-rock"]);
  });

  it("keeps assigned materials when an unpublished snapshot arrives before the first tick", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
    });
    handles.push(handle);
    const callback = runRenderLoop.mock.calls[0]?.[0];
    handle.applyCommand({
      type: "assignMesh",
      slotId: 0,
      meshKind: "box",
      meshAssetGuid: null,
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 1,
      meshKind: "camera",
      meshAssetGuid: null,
      camera: {
        projectionMode: "perspective",
        fieldOfView: 60,
        isDefault: true,
      },
    });
    handle.applyCommand({ type: "possessCamera", slotId: 1 });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 2,
      meshKind: "box",
      meshAssetGuid: null,
    });
    handle.applyCommand({
      type: "assignMaterial",
      slotId: 2,
      materialAssetGuid: "mat-rock",
    });
    handle.pushSnapshot(new Float32Array(snapshotFloatCount(8)));
    callback?.();
    expect(handle.assignedMaterialGuids()).toEqual(["mat-rock"]);

    const live = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(live, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 3,
      scriptMs: 0,
      physicsMs: 0,
    });
    for (const slotId of [0, 1, 2]) {
      writeActorSlot(live, slotId, {
        slotId,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        flags: 1,
      });
    }
    handle.pushSnapshot(live);
    callback?.();
    expect(handle.assignedMaterialGuids()).toEqual(["mat-rock"]);
  });

  it("moves the native fallback post-process stack onto the authored Default Camera", async () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
      postProcessStack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      materialDocuments: new Map([
        ["pp", createDefaultMaterialDocument("Blur", "postProcess")],
      ]),
    });
    handles.push(handle);
    await new Promise<void>((resolve) => handle.scene.freezeActiveMeshes(false, resolve));
    await handle.prewarmSceneMaterials();
    const fallback = handle.scene.getCameraByName("camera");
    expect(livePassCount(fallback)).toBeGreaterThan(0);

    handle.applyCommand({
      type: "assignMesh",
      slotId: 1,
      meshKind: "camera",
      meshAssetGuid: null,
      camera: { isDefault: true, projectionMode: "perspective" },
    });
    const buf = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(buf, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(buf, 0, {
      slotId: 1,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    handle.pushSnapshot(buf);
    runRenderLoop.mock.calls[0]?.[0]?.();
    await handle.prewarmSceneMaterials();

    const authored = handle.scene.activeCamera;
    expect(authored?.name).toBe("authoredCamera:1");
    expect(livePassCount(authored)).toBeGreaterThan(0);
    expect(livePassCount(fallback)).toBe(0);
  });

  it("reattaches the native post-process stack to the fallback camera after Default Camera despawn", async () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
      postProcessStack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      materialDocuments: new Map([
        ["pp", createDefaultMaterialDocument("Blur", "postProcess")],
      ]),
    });
    handles.push(handle);
    await new Promise<void>((resolve) => handle.scene.freezeActiveMeshes(false, resolve));
    const callback = runRenderLoop.mock.calls[0]?.[0];
    handle.applyCommand({
      type: "assignMesh",
      slotId: 1,
      meshKind: "camera",
      meshAssetGuid: null,
      camera: { isDefault: true, projectionMode: "perspective" },
    });
    const spawn = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(spawn, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(spawn, 0, {
      slotId: 1,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    handle.pushSnapshot(spawn);
    callback?.();
    await handle.prewarmSceneMaterials();
    expect(handle.scene.activeCamera?.name).toBe("authoredCamera:1");
    expect(livePassCount(handle.scene.activeCamera)).toBeGreaterThan(0);

    const empty = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(empty, {
      frameId: 2,
      tickIndex: 2,
      actorCount: 0,
      scriptMs: 0,
      physicsMs: 0,
    });
    handle.pushSnapshot(empty);
    callback?.();

    await handle.prewarmSceneMaterials();
    const fallback = handle.scene.getCameraByName("camera");
    expect(handle.scene.activeCamera).toBe(fallback);
    expect(fallback?.isDisposed()).toBe(false);
    expect(livePassCount(fallback)).toBeGreaterThan(0);
    expect(handle.postProcessPassCount()).toBeGreaterThan(0);
  });

  it("routes playSound through an injected audio backend after unlock", async () => {
    const { createDefaultAudioPayload } = await import("@babylonslate/assets");
    const { FakeAudioPlaybackBackend } = await import("./audio-playback-backend");
    const backend = new FakeAudioPlaybackBackend();
    const engine = sharedEngine();
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
      audioBackend: backend,
      audioBytes: new Map([["jump", new Uint8Array([1, 2, 3, 4])]]),
      audioLibrary: {
        mixerGuid: null,
        mixers: new Map(),
        channels: new Map(),
        audio: new Map([
          ["jump", { ...createDefaultAudioPayload(), volume: 0.5 }],
        ]),
        attenuations: new Map(),
      },
    });
    handles.push(handle);
    handle.applyCommand({
      type: "playSound",
      assetGuid: "jump",
      volume: 0.5,
      frameId: 1,
      voiceId: "v1",
    });
    expect(backend.plays).toHaveLength(0);
    await handle.unlockAudio();
    expect(backend.plays).toEqual([
      expect.objectContaining({ assetGuid: "jump", gain: 0.25, voiceId: "v1" }),
    ]);
    handle.dispose();
  });

  function publishedSlotSnapshot(slotId: number, tickIndex = 1): Float32Array {
    const buf = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(buf, {
      frameId: tickIndex,
      tickIndex,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(buf, 0, {
      slotId,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: SNAPSHOT_FLAG_VISIBLE,
    });
    return buf;
  }

  it("lets the destination Default Camera win after play loadScene", () => {
    const { handle } = playHandle(sharedEngine());
    handle.applyCommand({
      type: "spawn",
      slotId: 1,
      actorGuid: "cam-a",
      classId: "Actor",
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 1,
      meshKind: "camera",
      meshAssetGuid: null,
      camera: {
        projectionMode: "perspective",
        fieldOfView: 60,
        isDefault: false,
      },
    });
    handle.applyCommand({ type: "possessCamera", slotId: 1 });
    expect(handle.scene.activeCamera?.name).toBe("authoredCamera:1");

    handle.loadScene(createDefaultScene());
    handle.applyCommand({
      type: "spawn",
      slotId: 2,
      actorGuid: "cam-b",
      classId: "Actor",
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 2,
      meshKind: "camera",
      meshAssetGuid: null,
      camera: {
        projectionMode: "perspective",
        fieldOfView: 60,
        isDefault: true,
      },
    });
    expect(handle.scene.activeCamera?.name).toBe("authoredCamera:2");
    expect(handle.scene.getCameraByName("authoredCamera:1")).toBeFalsy();
  });

  it("keeps destination possess when a stale pre-swap snapshot renders", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
    });
    handles.push(handle);
    const callback = runRenderLoop.mock.calls[0]?.[0];

    handle.applyCommand({
      type: "spawn",
      slotId: 1,
      actorGuid: "cam-a",
      classId: "Actor",
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 1,
      meshKind: "camera",
      meshAssetGuid: null,
      camera: {
        projectionMode: "perspective",
        fieldOfView: 60,
        isDefault: true,
      },
    });
    handle.applyCommand({ type: "possessCamera", slotId: 1 });
    handle.pushSnapshot(publishedSlotSnapshot(1, 1));
    callback?.();
    expect(handle.scene.activeCamera?.name).toBe("authoredCamera:1");

    handle.loadScene(createDefaultScene());
    handle.applyCommand({
      type: "spawn",
      slotId: 2,
      actorGuid: "cam-b",
      classId: "Actor",
    });
    handle.applyCommand({
      type: "assignMesh",
      slotId: 2,
      meshKind: "camera",
      meshAssetGuid: null,
      camera: {
        projectionMode: "perspective",
        fieldOfView: 60,
        isDefault: true,
      },
    });
    handle.applyCommand({ type: "possessCamera", slotId: 2 });
    expect(handle.scene.activeCamera?.name).toBe("authoredCamera:2");

    callback?.();
    expect(handle.scene.activeCamera?.name).toBe("authoredCamera:2");
    expect(handle.scene.getCameraByName("authoredCamera:2")).toBeTruthy();
  });

  it("applies setFreeCam without pausing and restores on possessCamera", () => {
    const { handle } = playHandle(sharedEngine());
    const defaultCam = handle.scene.activeCamera;
    expect(handle.isFreeCamEnabled()).toBe(false);
    handle.applyCommand({ type: "setFreeCam", enabled: true });
    expect(handle.isFreeCamEnabled()).toBe(true);
    expect(handle.scene.activeCamera?.name).toBe("playFreeCam");
    expect(handle.scene.activeCamera).not.toBe(defaultCam);
    handle.applyCommand({
      type: "assignMesh",
      slotId: 1,
      meshKind: "camera",
      meshAssetGuid: null,
      camera: {
        projectionMode: "perspective",
        fieldOfView: 60,
        isDefault: true,
      },
    });
    handle.applyCommand({ type: "possessCamera", slotId: 1 });
    expect(handle.isFreeCamEnabled()).toBe(false);
    expect(handle.scene.activeCamera?.name).not.toBe("playFreeCam");
    handle.applyCommand({ type: "setFreeCam", enabled: true });
    expect(handle.isFreeCamEnabled()).toBe(true);
    handle.loadScene(createDefaultScene());
    expect(handle.isFreeCamEnabled()).toBe(false);
  });

  it("steers the free camera while it is enabled", () => {
    const { handle } = playHandle(sharedEngine());
    handle.applyCommand({ type: "setFreeCam", enabled: true });
    const start = handle.scene.activeCamera!.position.clone();
    handle.steerPlayFreeCam?.(1, 0);
    expect(
      handle.scene.activeCamera!.position.equalsWithEpsilon(start, 1e-4),
    ).toBe(false);
  });

  it("applies setRenderingQuality on Play views only, not the editor viewport", () => {
    const play = playHandle(sharedEngine());
    const editor = editorHandle(sharedEngine());
    play.handle.applyCommand({ type: "setRenderingQuality", overrides: { resolution: { scale: 0.5, minScale: 0.5 } } });
    editor.handle.applyCommand({ type: "setRenderingQuality", overrides: { resolution: { scale: 0.5, minScale: 0.5 } } });
    expect(play.handle.scaling.getLevel()).toBe(2);
    expect(editor.handle.scaling.getLevel()).toBe(1);
  });

  it("syncs the Fake audio listener to the possessed camera world pose", async () => {
    const { FakeAudioPlaybackBackend } = await import("./audio-playback-backend");
    const backend = new FakeAudioPlaybackBackend();
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
      audioBackend: backend,
    });
    handles.push(handle);
    handle.applyCommand({
      type: "assignMesh",
      slotId: 1,
      meshKind: "camera",
      meshAssetGuid: null,
      camera: {
        projectionMode: "perspective",
        fieldOfView: 60,
        isDefault: true,
      },
    });
    handle.applyCommand({ type: "possessCamera", slotId: 1 });
    const buf = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(buf, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      scriptMs: 0,
      physicsMs: 0,
    });
    writeActorSlot(buf, 0, {
      slotId: 1,
      position: { x: 10, y: 4, z: -6 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    });
    handle.pushSnapshot(buf);
    runRenderLoop.mock.calls[0]?.[0]?.();
    const fallback = handle.scene.getCameraByName("camera");
    expect(handle.scene.activeCamera?.name).toBe("authoredCamera:1");
    expect(backend.listener.x).toBeCloseTo(10, 5);
    expect(backend.listener.y).toBeCloseTo(4, 5);
    expect(backend.listener.z).toBeCloseTo(-6, 5);
    expect(fallback?.globalPosition.x ?? 0).not.toBeCloseTo(10, 0);
    handle.dispose();
  });

  it("does not registerView when present is rtt", () => {
    const engine = sharedEngine();
    const registerView = vi.spyOn(engine, "registerView");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      editor: true,
      present: "rtt",
    });
    handles.push(handle);
    expect(registerView).not.toHaveBeenCalled();
    expect(handle.engine).toBe(engine);
    expect(handle.editor).not.toBeNull();
  });

  it("does not unRegisterView on dispose when present is rtt", () => {
    const engine = sharedEngine();
    const unRegisterView = vi.spyOn(engine, "unRegisterView");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      editor: true,
      present: "rtt",
    });
    handle.dispose();
    handles.pop();
    expect(unRegisterView).not.toHaveBeenCalled();
  });

  it("uses one Engine for editor viewport, Prefab rtt, and Play overlay", () => {
    const engine = sharedEngine();
    const editorCanvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const prefabCanvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const playCanvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const editor = createEngine(editorCanvas, {
      sharedEngine: engine,
      editor: true,
    });
    const prefab = createEngine(prefabCanvas, {
      sharedEngine: engine,
      editor: true,
      present: "rtt",
    });
    const play = createEngine(playCanvas, {
      sharedEngine: engine,
      playMode: true,
    });
    handles.push(editor, prefab, play);
    expect(editor.engine).toBe(engine);
    expect(prefab.engine).toBe(engine);
    expect(play.engine).toBe(engine);
    expect(prefab.scene).not.toBe(editor.scene);
    expect(prefab.scene).not.toBe(play.scene);
    expect(editor.scene).not.toBe(play.scene);
    expect(resourceCacheForEngine(engine)).toBe(
      resourceCacheForEngine(editor.engine),
    );
    expect(resourceCacheForEngine(play.engine)).toBe(
      resourceCacheForEngine(editor.engine),
    );
  });

  it("Play overlay dispose leaves the shared ResourceCache live for the editor", () => {
    const engine = sharedEngine();
    const editor = createEngine(
      new FakeCanvas() as unknown as HTMLCanvasElement,
      { sharedEngine: engine, editor: true },
    );
    handles.push(editor);
    const play = createEngine(
      new FakeCanvas() as unknown as HTMLCanvasElement,
      { sharedEngine: engine, playMode: true },
    );
    expect(play.resourceCache).not.toBeNull();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    editor.setMeshAssets({
      textureBytes: new Map([["tex-shared", bytes]]),
    });
    const firstLease = editor.resourceCache.acquireTexture("tex-shared", engine, bytes);
    const first = firstLease.resource;
    const disposeCache = vi.spyOn(ResourceCache.prototype, "dispose");
    play.dispose();
    expect(disposeCache).not.toHaveBeenCalled();
    const secondLease = editor.resourceCache.acquireTexture("tex-shared", engine, bytes);
    const second = secondLease.resource;
    expect(second).toBe(first);
    expect(isDisposedGpuTexture(first)).toBe(false);
  });

  it("Play overlay dispose leaves the editor skybox cubemap live", () => {
    const engine = sharedEngine();
    const editor = createEngine(
      new FakeCanvas() as unknown as HTMLCanvasElement,
      { sharedEngine: engine, editor: true },
    );
    handles.push(editor);
    editor.setMeshAssets({
      resourceCache: editor.resourceCache,
      textureBytes: new Map([["tex-albedo", new Uint8Array([1, 2, 3, 4])]]),
    });
    const editorSky = editor.scene.getMeshByName(editorMeshName("actor-skybox"));
    const cube = (editorSky?.material as PBRMaterial | null)?.reflectionTexture;
    expect(cube).toBeTruthy();
    const play = createEngine(
      new FakeCanvas() as unknown as HTMLCanvasElement,
      { sharedEngine: engine, playMode: true },
    );
    play.applyCommand({
      type: "assignMesh",
      slotId: 3,
      meshAssetGuid: null,
      meshKind: "skybox",
      skybox: {
        size: 1000,
        faces: {
          px: null,
          py: null,
          pz: null,
          nx: null,
          ny: null,
          nz: null,
        },
      },
    });
    play.dispose();
    expect(isDisposedGpuTexture(cube!)).toBe(false);
    expect(cube!.getInternalTexture()).not.toBeNull();
  });

  it("does not dispose the shared Engine when Prefab rtt handle disposes", () => {
    const engine = sharedEngine();
    const disposeEngine = vi.spyOn(engine, "dispose");
    const handle = createEngine(
      new FakeCanvas() as unknown as HTMLCanvasElement,
      { sharedEngine: engine, editor: true, present: "rtt" },
    );
    handle.dispose();
    expect(disposeEngine).not.toHaveBeenCalled();
    expect(engine.getLoadedTexturesCache()).toBeDefined();
  });

  it("renders Prefab into camera.outputRenderTarget instead of the default framebuffer", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      editor: true,
      present: "rtt",
    });
    handles.push(handle);
    const camera = handle.scene.activeCamera;
    expect(camera).not.toBeNull();
    runRenderLoop.mock.calls[0]?.[0]?.();
    expect(camera?.outputRenderTarget).not.toBeNull();
  });

  it("does not call engine.resize from Prefab rtt present", () => {
    const engine = sharedEngine();
    const resize = vi.spyOn(engine, "resize");
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      editor: true,
      present: "rtt",
    });
    handles.push(handle);
    resize.mockClear();
    handle.resize();
    expect(resize).not.toHaveBeenCalled();
    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(256);
  });

  it("forwards Prefab RTT canvas pointers into the scene for gizmo drags", () => {
    const engine = sharedEngine();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(800);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(400);
    const canvas = new FakeCanvas();
    canvas.clientWidth = 200;
    canvas.clientHeight = 100;
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      editor: true,
      present: "rtt",
    });
    handles.push(handle);
    const down = vi.spyOn(handle.scene, "simulatePointerDown");
    canvas.emit("pointerdown", {
      pointerId: 3,
      clientX: 100,
      clientY: 50,
    });
    expect(handle.scene.pointerX).toBeCloseTo(400);
    expect(handle.scene.pointerY).toBeCloseTo(200);
    expect(down).toHaveBeenCalled();
  });

  it("forwards Scene shared-view canvas pointers into the scene for gizmo drags", () => {
    const engine = sharedEngine();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(800);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(400);
    const canvas = new FakeCanvas();
    canvas.clientWidth = 200;
    canvas.clientHeight = 100;
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      editor: true,
    });
    handles.push(handle);
    const down = vi.spyOn(handle.scene, "simulatePointerDown");
    canvas.emit("pointerdown", {
      pointerId: 3,
      clientX: 100,
      clientY: 50,
    });
    expect(handle.scene.pointerX).toBeCloseTo(400);
    expect(handle.scene.pointerY).toBeCloseTo(200);
    expect(down).toHaveBeenCalled();
  });

  it("refreshes spawned area lights when prepared assets arrive or disappear without another actor command", async () => {
    const engine = sharedEngine();
    const { handle } = playHandle(engine);
    const lights = areaRectLightBindings([{ id: "emitter", classId: "AreaRectLightComponent", properties: { textureGuid: "texture" } }]);
    handle.applyCommand({ type: "setAreaLights", slotId: 4, lights });
    const light = handle.scene.getLightByName("playAreaLight:4:emitter")!;
    expect(light.isEnabled()).toBe(false);
    const pixels = await decodeAreaEmission(await encodeAreaEmission(new Uint8Array(AREA_EMISSION_EDGE ** 2 * 4).fill(170), "a".repeat(64)));
    const areaEmissions = new Map([["texture", pixels]]);
    handle.setMeshAssets({ areaEmissions });
    expect(light.isEnabled()).toBe(true);
    expect(light.metadata.areaLight.error).toBeNull();
    const uploaded = [...engine.getLoadedTexturesCache()];
    handle.setMeshAssets({ areaEmissions });
    expect(engine.getLoadedTexturesCache()).toEqual(uploaded);
    handle.setMeshAssets({ areaEmissions: new Map() });
    expect(light.isEnabled()).toBe(false);
    expect(light.metadata.areaLight.error).toContain("Prepare Emission");
    handle.setMeshAssets({ areaEmissions });
    expect(handle.scene.getLightByName(light.name)).toBe(light);
    expect(light.isEnabled()).toBe(true);
    handle.applyCommand({ type: "setAreaLights", slotId: 4, lights: [] });
    expect(handle.scene.getLightByName(light.name)).toBeNull();
  });

  it("hydrates outline commands before meshes arrive and retains actor styles across visual replacement until despawn", async () => {
    const attach = SceneRenderCoordinator.prototype.attachSharedOutline;
    let view: SharedOutlineView | undefined;
    const observing = vi.spyOn(SceneRenderCoordinator.prototype, "attachSharedOutline").mockImplementation(function (this: SceneRenderCoordinator, value: SharedOutlineView) {
      view = value; return attach.call(this, value);
    });
    try {
      const { handle } = playHandle(sharedEngine());
      const outlines = outlineBindings("hero", [{ id: "ink", classId: "OutlineComponent", properties: { color: [1, 0, 0], width: 3 } }]);
      handle.applyCommand({ type: "setActorOutlines", slotId: 4, actorId: "hero", outlines });
      expect(view!.active).toBe(false);
      const assign = { type: "assignMesh" as const, slotId: 4, actorGuid: "hero", meshAssetGuid: null, meshKind: "box" };
      handle.applyCommand(assign);
      const previous = view!.contributions.get("component:hero:ink")!.targets[0]!.meshes[0]!;
      handle.applyCommand({ ...assign, meshKind: "sphere" });
      let replacement = view!.contributions.get("component:hero:ink")!;
      expect(previous.isDisposed()).toBe(true);
      expect(replacement.targets[0]!.meshes[0]).not.toBe(previous);
      expect(replacement).toMatchObject({ color: [1, 0, 0], width: 3 });
      expect(view!.contributions.has("selection")).toBe(false);
      handle.setMeshAssets({ modelBytes: new Map([
        ["model-a", encodeTriangleGlb()], ["model-b", encodeTriangleGlb()],
      ]) });
      for (const assetGuid of ["model-a", "model-b"]) {
        const predecessor = replacement.targets[0]!.meshes[0]!;
        handle.applyCommand({ ...assign, meshAssetGuid: assetGuid });
        await handle.whenEditorModelsReady();
        replacement = view!.contributions.get("component:hero:ink")!;
        expect(predecessor.isDisposed()).toBe(true);
        expect(replacement.targets[0]!.meshes).toHaveLength(1);
        expect(replacement.targets[0]!.meshes[0]!.getTotalVertices()).toBe(3);
        expect(replacement).toMatchObject({ color: [1, 0, 0], width: 3 });
      }
      const predecessor = replacement.targets[0]!.meshes[0]!;
      handle.applyCommand({ ...assign, parts: ["model-a", "model-b"].map((guid, index) => ({
        componentId: `part-${index}`, parentId: null, meshKind: "box", meshAssetGuid: guid,
        position: [index * 2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      })) });
      await handle.whenEditorModelsReady();
      replacement = view!.contributions.get("component:hero:ink")!;
      expect(predecessor.isDisposed()).toBe(true);
      expect(replacement.targets[0]!.meshes.map((mesh) => mesh.getTotalVertices())).toEqual([3, 3]);
      expect(replacement).toMatchObject({ color: [1, 0, 0], width: 3 });
      handle.applyCommand({ type: "setActorOutlines", slotId: 5, actorId: "child", outlines: outlineBindings("child", [{ id: "ink", classId: "OutlineComponent", properties: {} }]) });
      handle.applyCommand({ ...assign, slotId: 5, actorGuid: "child" });
      const child = view!.contributions.get("component:child:ink")!.targets[0]!.meshes[0]!;
      child.parent = replacement.targets[0]!.meshes[0]!;
      handle.applyCommand({ type: "setActorOutlines", slotId: 4, actorId: "hero", outlines });
      expect(view!.contributions.get("component:hero:ink")!.targets[0]!.meshes).not.toContain(child);
      child.parent = null;
      handle.applyCommand({ type: "despawn", slotId: 4, actorGuid: "hero" });
      expect(view!.contributions.has("component:child:ink")).toBe(true);
      handle.applyCommand({ type: "despawn", slotId: 5, actorGuid: "child" });
      expect(view!.active).toBe(false);
    } finally { observing.mockRestore(); }
  });

  it("applies render scale to a locked Play framebuffer without replacing its authored size", () => {
    const engine = sharedEngine();
    // NullEngine hardcodes a scaling level of one; supply the browser boundary.
    let hardwareScaling = 1;
    vi.spyOn(engine, "getHardwareScalingLevel").mockImplementation(() => hardwareScaling);
    vi.spyOn(engine, "setHardwareScalingLevel").mockImplementation((level) => { hardwareScaling = level; });
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, { sharedEngine: engine, playMode: true });
    handles.push(handle);
    handle.setSize(800, 450);
    const size = vi.spyOn(engine, "setSize");
    const view = engine.views!.find((entry) => entry.target === canvas)!;
    handle.scaling.setSettingsLevel(2);
    view.customResize!(canvas);
    expect(size).toHaveBeenLastCalledWith(400, 225);
    expect([canvas.width, canvas.height]).toEqual([256, 256]);
    handle.scaling.setSettingsLevel(1);
    view.customResize!(canvas);
    expect(size).toHaveBeenLastCalledWith(800, 450);
    expect([canvas.width, canvas.height]).toEqual([256, 256]);
  });

  it("sizes the shared Play framebuffer from the overlay canvas instead of engine.resize", () => {
    const engine = sharedEngine();
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    Object.assign(canvas, {
      clientWidth: 800,
      clientHeight: 450,
      width: 300,
      height: 150,
    });
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
    });
    handles.push(handle);
    const resize = vi.spyOn(engine, "resize");
    const setSize = vi.spyOn(engine, "setSize");
    handle.resize();
    expect(resize).not.toHaveBeenCalled();
    expect(setSize).toHaveBeenCalledWith(800, 450);
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(150);
  });

  it("sizes a shared editor framebuffer from the viewport canvas instead of engine.resize", () => {
    const engine = sharedEngine();
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    Object.assign(canvas, {
      clientWidth: 640,
      clientHeight: 360,
      width: 100,
      height: 50,
    });
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      editor: true,
    });
    handles.push(handle);
    const resize = vi.spyOn(engine, "resize");
    const setSize = vi.spyOn(engine, "setSize");
    handle.resize();
    expect(resize).not.toHaveBeenCalled();
    expect(setSize).toHaveBeenCalledWith(640, 360);
  });

  it("still sizes a shared view with setSize when the canvas cannot host a 2d blit", () => {
    const engine = sharedEngine();
    const canvas = new FakeCanvas();
    canvas.getContext = () => null;
    Object.assign(canvas, {
      clientWidth: 512,
      clientHeight: 288,
      width: 64,
      height: 32,
    });
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      editor: true,
    });
    handles.push(handle);
    const resize = vi.spyOn(engine, "resize");
    const setSize = vi.spyOn(engine, "setSize");
    handle.resize();
    expect(resize).not.toHaveBeenCalled();
    expect(setSize).toHaveBeenCalledWith(512, 288);
    handle.setSize(800, 450);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(450);
  });

  it.each(["CSS", "locked"] as const)("retains the last visible Play frame through a loading %s resize and replaces it only with an admitted frame", async (sizing) => {
    const engine = sharedEngine();
    const pixels = () => {
      const surface = Object.assign(new FakeCanvas(), { pixel: 0 });
      let width = surface.width, height = surface.height;
      Object.defineProperties(surface, {
        width: { get: () => width, set: (next: number) => { width = next; surface.pixel = 0; } },
        height: { get: () => height, set: (next: number) => { height = next; surface.pixel = 0; } },
      });
      surface.getContext = () => ({ clearRect: () => { surface.pixel = 0; }, drawImage: (source: typeof surface) => { surface.pixel = source.pixel; } });
      return surface;
    };
    const source = pixels(), canvas = pixels();
    vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(source as unknown as HTMLCanvasElement);
    vi.spyOn(engine, "setSize").mockImplementation((width, height) => {
      if (source.width !== width) source.width = width;
      if (source.height !== height) source.height = height;
      return true;
    });
    vi.spyOn(engine, "getRenderWidth").mockImplementation(() => source.width);
    vi.spyOn(engine, "getRenderHeight").mockImplementation(() => source.height);
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, { sharedEngine: engine, playMode: true });
    handles.push(handle);
    let color = 0xff8040;
    handle.scene.onAfterRenderObservable.add(() => { source.pixel = color; });
    let now = performance.now();
    const time = vi.spyOn(performance, "now").mockImplementation(() => now);
    const frame = () => { now += 1000; engine.beginFrame(); renderViews(engine); engine.endFrame(); };
    try {
      frame();
      expect(canvas.pixel).toBe(color);
      handle.applyCommand({ type: "sceneLoading", sceneAssetGuid: "next", sceneLoadId: 2 });
      if (sizing === "CSS") { canvas.clientWidth = 512; canvas.clientHeight = 288; handle.resize(); }
      else handle.setSize(512, 288);
      frame();
      expect(canvas.pixel).toBe(color);
      expect([canvas.width, canvas.height]).toEqual([256, 256]);
      color = 0x40a0ff;
      await handle.prewarmSceneMaterials();
      const presented = handle.presentFirstFrame();
      frame();
      await presented;
      expect(canvas.pixel).toBe(color);
      expect([canvas.width, canvas.height]).toEqual([512, 288]);
      frame();
      expect([canvas.width, canvas.height]).toEqual([512, 288]);
    } finally { time.mockRestore(); }
  });

  it("shares depth across Play rendering groups so debug is not an underlay", () => {
    const { handle } = playHandle(sharedEngine());
    const worldClear = handle.scene.getAutoClearDepthStencilSetup(1);
    expect(worldClear.autoClear).toBe(false);
  });

  it("expires Play duration-0 debug draw when the next snapshot tick arrives", () => {
    const { handle } = playHandle(sharedEngine());
    handle.applyCommand({
      type: "debugDraw",
      kind: "line",
      duration: 0,
      color: { x: 1, y: 1, z: 1, w: 1 },
      frameId: 1,
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 0, z: 0 },
    });
    const snapshot = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(snapshot, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 0,
      scriptMs: 0,
      physicsMs: 0,
    });
    handle.pushSnapshot(snapshot);
    handle.scene.render();
    handle.scene.render();
    handle.scene.render();
    expect(
      handle.scene.meshes.some((mesh) => mesh.name.startsWith("playDebugDraw:")),
    ).toBe(true);
    writeSnapshotHeader(snapshot, {
      frameId: 2,
      tickIndex: 2,
      actorCount: 0,
      scriptMs: 0,
      physicsMs: 0,
    });
    handle.pushSnapshot(snapshot);
    expect(
      handle.scene.meshes.some((mesh) => mesh.name.startsWith("playDebugDraw:")),
    ).toBe(false);
  });

  it("keeps the Default Camera active after a perspective-to-ortho switch and refreshes ortho on setSize", () => {
    const engine = sharedEngine();
    const { handle } = playHandle(engine);
    handle.applyCommand({
      type: "assignMesh",
      slotId: 1,
      meshKind: "camera",
      meshAssetGuid: null,
      camera: {
        isDefault: true,
        projectionMode: "perspective",
        fieldOfView: 60,
        orthographicSize: 5,
      },
    });
    const camera = handle.scene.getCameraByName(
      "authoredCamera:1",
    ) as UniversalCamera;
    expect(handle.scene.activeCamera).toBe(camera);
    handle.applyCommand({
      type: "assignMesh",
      slotId: 1,
      meshKind: "camera",
      meshAssetGuid: null,
      camera: {
        isDefault: true,
        projectionMode: "orthographic",
        fieldOfView: 60,
        orthographicSize: 5,
      },
    });
    expect(handle.scene.activeCamera).toBe(camera);
    expect(camera.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
    expect(
      camera.getProjectionMatrix(true).m.every((value) => Number.isFinite(value)),
    ).toBe(true);
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(800);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(600);
    handle.setSize(800, 600);
    expect(camera.orthoLeft).toBeCloseTo(-5 * (4 / 3));
    expect(camera.orthoRight).toBeCloseTo(5 * (4 / 3));
    expect(handle.scene.activeCamera).toBe(camera);
  });

  it("emits 2DButton onClick from touch down/up and from pointercancel over the button", () => {
    const engine = sharedEngine();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(256);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(256);
    const canvas = new FakeCanvas();
    const events: Array<{ event: string; actorGuid: string }> = [];
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      playMode: true,
      onSceneLayerPointer: (event) => {
        events.push({ event: event.event, actorGuid: event.actorGuid });
      },
    });
    handles.push(handle);
    spawnOverlayButton(handle);

    canvas.emit("pointerdown", pointerAt(128, 128));
    expect(canvas.capturedPointers).toEqual([1]);
    expect(canvas.prevented).toBeGreaterThan(0);
    canvas.emit("pointerup", pointerAt(128, 128));
    expect(events).toEqual(
      expect.arrayContaining([
        { event: "onPressStart", actorGuid: "btn" },
        { event: "onClick", actorGuid: "btn" },
      ]),
    );

    events.length = 0;
    canvas.emit("pointerdown", pointerAt(128, 128, { pointerId: 2 }));
    canvas.emit("pointercancel", pointerAt(128, 128, { pointerId: 2 }));
    expect(events).toEqual(
      expect.arrayContaining([
        { event: "onPressEnd", actorGuid: "btn" },
        { event: "onClick", actorGuid: "btn" },
      ]),
    );

    const beforeTouch = canvas.prevented;
    canvas.emit("touchstart", {});
    canvas.emit("touchmove", {});
    expect(canvas.prevented).toBe(beforeTouch + 2);
  });

  it("clicks a 2DButton through the touchMinTargetPx floor without growing the mesh", () => {
    const engine = sharedEngine();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(256);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(256);
    const canvas = new FakeCanvas();
    const events: string[] = [];
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      playMode: true,
      touchMinTargetPx: 44,
      onSceneLayerPointer: (event) => {
        events.push(event.event);
      },
    });
    handles.push(handle);
    spawnOverlayButton(handle, "hud", { width: 9, height: 9 });
    const mesh = handle.sceneLayerScenes()[0]?.scene.getMeshByName("actor-1");
    mesh?.refreshBoundingInfo(false, false);
    const extent = mesh?.getBoundingInfo().boundingBox.extendSize;
    expect(extent?.x).toBeCloseTo(0.5);

    // 1×1 plane is ~14 CSS px from center; 16 px misses the visual but sits
    // inside the 44 px screen-space floor.
    canvas.emit("pointerdown", pointerAt(128 + 16, 128));
    canvas.emit("pointerup", pointerAt(128 + 16, 128));
    expect(events).toContain("onClick");
  });

  it("scopes render-path overrides to the live Play session and restores the editor preference", () => {
    const engine = sharedEngine();
    const { handle: editor } = editorHandle(engine);
    editor.setRenderPath("clusteredForward");
    const { handle: first } = playHandle(engine);
    expect(first.renderPathStatus().requested.renderPath).toBe("forward");
    first.setRenderPath("clusteredForward");
    const { handle: second } = playHandle(engine);
    expect(second.renderPathStatus().requested.renderPath).toBe("clusteredForward");
    first.dispose();
    const disposedInvalidation = vi.spyOn(first.scheduler, "invalidate");
    second.setRenderPath("forward");
    expect(disposedInvalidation).not.toHaveBeenCalled();
    second.dispose();
    expect(editor.renderPathStatus().requested.renderPath).toBe("clusteredForward");
    editor.setRenderPath(null);
    const { handle: next } = playHandle(engine);
    expect(next.renderPathStatus().requested.renderPath).toBe("forward");
    next.setRenderPath("clusteredForward");
    next.dispose();
    expect(editor.renderPathStatus().requested.renderPath).toBe("forward");
  });

  it("applies a setRenderPath command game-wide and reports the session status", () => {
    const engine = sharedEngine();
    const { handle } = playHandle(engine);
    const { handle: sibling } = playHandle(engine);
    const statuses: string[] = [];
    const withStatus = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      playMode: true,
      onRenderPathChanged: (status) => statuses.push(status.requested.renderPath),
    });
    handles.push(withStatus);
    expect(handle.renderPathStatus().requested.renderPath).toBe("forward");
    handle.applyCommand({ type: "setRenderPath", renderPath: "clusteredForward" });
    expect(handle.renderPathStatus().requested.renderPath).toBe("clusteredForward");
    expect(sibling.renderPathStatus().requested.renderPath).toBe("clusteredForward");
    expect(statuses).toContain("clusteredForward");
    sibling.setRenderPath(null);
    expect(handle.renderPathStatus().requested.renderPath).toBe("forward");
    expect(statuses.at(-1)).toBe("forward");
  });

  it("ignores setRenderPath on non-Play handles", () => {
    const engine = sharedEngine();
    const { handle } = editorHandle(engine);
    handle.applyCommand({ type: "setRenderPath", renderPath: "clusteredForward" });
    expect(handle.renderPathStatus().requested.renderPath).toBe("forward");
    // The Engine-level API still applies to shared scenes on the same Engine.
    handle.setRenderPath("clusteredForward");
    expect(handle.renderPathStatus().requested.renderPath).toBe("clusteredForward");
    handle.setRenderPath(null);
  });

  it("hides the Play cursor by default and shows it on setCursorVisible", () => {
    const canvas = new FakeCanvas();
    const handle = createEngine(canvas as unknown as HTMLCanvasElement, {
      sharedEngine: sharedEngine(),
      playMode: true,
    });
    handles.push(handle);
    expect(canvas.style.cursor).toBe("none");
    handle.applyCommand({
      type: "setCursorVisible",
      visible: true,
      frameId: 1,
    });
    expect(canvas.style.cursor).toBe("default");
    handle.applyCommand({
      type: "setCursorVisible",
      visible: false,
      frameId: 2,
    });
    expect(canvas.style.cursor).toBe("none");
  });
});
