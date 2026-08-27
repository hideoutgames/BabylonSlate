import { afterEach, describe, expect, it, vi } from "vitest";
import { Camera, Matrix, NullEngine, PBRMaterial, UniversalCamera, Vector3 } from "@babylonjs/core";
import {
  SNAPSHOT_FLAG_OVERLAY,
  SNAPSHOT_FLAG_VISIBLE,
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
} from "@babylonslate/bridge";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  engineCommandBus,
} from "@babylonslate/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createEngine, syncEditorPlayState } from "./create-engine";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { encodeTriangleGlb } from "./model-mesh";
import { ResourceCache, resourceCacheForEngine } from "./resource-cache";
import { editorMeshName } from "./scene-loader";
import { visualMeshes } from "./visual-meshes";

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
): void {
  handle.applyCommand({
    type: "sceneLayerCreate",
    layerId,
    assetGuid: "hud-asset",
    zOrder: 0,
    ownerSceneGuid: null,
    postProcessStack: [],
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

  function sharedEngine(): NullEngine {
    const engine = new NullEngine();
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

  function editorHandle(engine: NullEngine) {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, { sharedEngine: engine });
    handles.push(handle);
    return { handle, canvas };
  }

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

  it("honors an explicit Play frame cap", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
      frameCap: 30,
    });
    handles.push(handle);
    handle.scheduler.noteRendered(0);
    expect(handle.scheduler.shouldRender(20)).toBe(false);
    expect(handle.scheduler.shouldRender(34)).toBe(true);
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

  it("snaps a live Scene canvas drawing buffer to CSS pixels on resize", () => {
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
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(360);
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
      handle.scaling.noteFrameTime(4);
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
      handle.scaling.noteFrameTime(20);
    }
    expect(handle.scaling.getLevel()).toBe(1);
  });

  it("attaches an authored post-process stack when the local gate is on", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
      postProcessingEnabled: true,
      postProcessStack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      materialDocuments: new Map([
        ["pp", createDefaultMaterialDocument("Blur", "postProcess")],
      ]),
    });
    handles.push(handle);
    expect(handle.postProcessPassCount()).toBeGreaterThan(0);
  });

  it("keeps world post-process on the world camera when a SceneLayer is created", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
      postProcessingEnabled: true,
      postProcessStack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      materialDocuments: new Map([
        ["pp", createDefaultMaterialDocument("Blur", "postProcess")],
      ]),
    });
    handles.push(handle);
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

  it("parents overlay spawn meshes into the SceneLayer scene and draws by z-order", () => {
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

    const order: string[] = [];
    const worldRender = vi.spyOn(handle.scene, "render").mockImplementation(() => {
      order.push("world");
    });
    for (const layer of handle.sceneLayerScenes()) {
      vi.spyOn(layer.scene, "render").mockImplementation(() => {
        order.push(layer.layerId);
      });
    }
    runRenderLoop.mock.calls[0]?.[0]?.();
    expect(order).toEqual(["world", "back", "front"]);
    worldRender.mockRestore();
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

  it("attaches the authored stack when postProcessingEnabled is omitted", () => {
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
    expect(handle.postProcessPassCount()).toBeGreaterThan(0);
  });

  it("skips the authored stack when the local gate is off, then restores it", () => {
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
    expect(handle.postProcessPassCount()).toBe(0);
    handle.setPostProcessingEnabled(true);
    expect(handle.postProcessPassCount()).toBeGreaterThan(0);
    handle.setPostProcessingEnabled(false);
    expect(handle.postProcessPassCount()).toBe(0);
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

  it("moves the post-process stack onto the authored Default Camera", () => {
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

    const authored = handle.scene.activeCamera;
    expect(authored?.name).toBe("authoredCamera:1");
    expect(livePassCount(authored)).toBeGreaterThan(0);
    expect(livePassCount(fallback)).toBe(0);
  });

  it("reattaches the post-process stack to the fallback camera after Default Camera despawn", () => {
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

  it("applies setRenderQuality on Play views only, not the editor viewport", () => {
    const play = playHandle(sharedEngine());
    const editor = editorHandle(sharedEngine());
    play.handle.applyCommand({ type: "setRenderQuality", level: "low" });
    editor.handle.applyCommand({ type: "setRenderQuality", level: "low" });
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
    const first = editor.resourceCache.getTexture("tex-shared", engine, bytes);
    const disposeCache = vi.spyOn(ResourceCache.prototype, "dispose");
    play.dispose();
    expect(disposeCache).not.toHaveBeenCalled();
    const second = editor.resourceCache.getTexture("tex-shared", engine, bytes);
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
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(450);
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

  it("matches the overlay drawing buffer to a locked Play setSize", () => {
    const { handle, canvas } = playHandle(sharedEngine());
    Object.assign(canvas, { width: 300, height: 150 });
    handle.setSize(1920, 1080);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
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
    spawnOverlayButton(handle);
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
