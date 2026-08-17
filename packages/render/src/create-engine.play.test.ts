import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core";
import {
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
} from "@babylonslate/bridge";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
} from "@babylonslate/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createEngine, syncEditorPlayState } from "./create-engine";
import { editorMeshName } from "./scene-loader";

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
  readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 256, height: 256 };
  }
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

  it("does not seed the default Cube into a Play scene", () => {
    const { handle } = playHandle(sharedEngine());
    const actorMeshes = handle.scene.meshes.filter((mesh) =>
      mesh.name.startsWith("editorActor:"),
    );
    expect(actorMeshes).toHaveLength(0);
    expect(handle.scene.getMeshByName(editorMeshName("actor-1"))).toBeNull();
  });

  it("still seeds the default Cube into a non-Play view", () => {
    const { handle } = editorHandle(sharedEngine());
    expect(handle.scene.getMeshByName(editorMeshName("actor-1"))).not.toBeNull();
  });

  it("registerView clears the overlay canvas before copying", () => {
    const engine = sharedEngine();
    const registerView = vi.spyOn(engine, "registerView");
    const { canvas } = playHandle(engine);
    expect(registerView).toHaveBeenCalledWith(canvas, undefined, true);
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
      }),
      expect.objectContaining({
        slotId: 1,
        name: "actor-1",
        visible: true,
        position: [3, 1, 0],
      }),
    ]);
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
});
