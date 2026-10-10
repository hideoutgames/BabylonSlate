import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { limitManagedRenderBytes, managedRenderReservations } from "./managed-render-resources";
import { MaterialLibrary } from "./material-library";
import { DirectionalLight, FreeCamera, MeshBuilder, NullEngine, NullEngineOptions, PointLight, RawTexture, RenderTargetTexture, Scene, StandardMaterial, Vector3, VertexBuffer } from "@babylonjs/core";
import { createSceneStreamAdmission, isSceneStreamSlotPending } from "./scene-stream-admission";
import { createSnapshotSceneBinding, retirePlaySlot } from "./snapshot-apply";
import { fogVolumeBindings, normalizeRenderingQuality, normalizeShadowSettings } from "@babylonslate/core";
import { sceneShadowController } from "./shadow-controller";
import { setSceneRenderSettings } from "./scene-render-mode";
import { sceneRenderingSettings, updateSceneRenderingSettings } from "./render-settings";
import { hasFogVolumes, selectFogVolumes, upsertFogVolumes } from "./fog-volumes";
import { markSceneReadinessDirty } from "./scene-perf";
import { afterEach, expect, it, vi } from "vitest";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphTextureManager } from "@babylonjs/core/FrameGraph/frameGraphTextureManager";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { SharedOutlineOwner } from "./shared-outline";
import { createGizmoHost } from "./gizmo-host";
import { applyCableFrame, createCableMesh } from "./cable-mesh";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

function host() {
  const options = new NullEngineOptions();
  options.renderWidth = 80;
  options.renderHeight = 64;
  const engine = adaptNullEngineFrameGraph(new NullEngine(options));
  engines.push(engine);
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  scene.activeCamera = camera;
  const renderer = new SceneRenderCoordinator(scene);
  return { options, engine, scene, camera, renderer };
}

function holdGraphInitialization() {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const initialize = FrameGraph.prototype._whenAsynchronousInitializationDoneAsync;
  vi.spyOn(FrameGraph.prototype, "_whenAsynchronousInitializationDoneAsync").mockImplementationOnce(async function (this: FrameGraph) {
    await initialize.call(this);
    entered();
    await gate;
  });
  return { started, release };
}

it("coalesces cable uploads at render admission and preserves held frames during preparation", async () => {
  const { scene, renderer } = host();
  const cable = createCableMesh(scene, "cable", { numSegments: 2, numSides: 4, cableWidth: 0.4 }, 1);
  const upload = vi.spyOn(cable, "updateVerticesData");
  let ready = false;
  scene.addIsReadyCheck({ isReady: () => ready });
  applyCableFrame(scene, new Float32Array([1, 3, -1, -1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0]), 1);
  expect(renderer.render().rendered).toBe(false);
  expect(upload).not.toHaveBeenCalled();
  ready = true;
  await renderer.prepare();
  expect(upload).not.toHaveBeenCalled();
  applyCableFrame(scene, new Float32Array([1, 3, -1, -1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 2, 0, 2, 2, 0]), 2);
  expect(renderer.render().rendered).toBe(true);
  expect(cable.getBoundingInfo().boundingBox.minimumWorld.y).toBeCloseTo(1.8);
  expect(upload.mock.calls.filter(([kind]) => kind === VertexBuffer.PositionKind)).toHaveLength(1);
  expect(renderer.render().rendered).toBe(true);
  expect(upload.mock.calls.filter(([kind]) => kind === VertexBuffer.PositionKind)).toHaveLength(1);
  renderer.dispose();
});

it("keeps parent graph frames rendering while streamed resources and fog wait for publication", async () => {
  const { scene, camera, renderer } = host();
  const binding = createSnapshotSceneBinding();
  const parent = MeshBuilder.CreateBox("parent", {}, scene);
  binding.meshes.set(1, parent);
  await renderer.prepare();
  const admission = createSceneStreamAdmission(scene, binding);
  const identity = { actorGuid: "stream", streamLoadId: 1 };
  admission.receive({ type: "sceneStreamLoading", ...identity });
  admission.receive({ type: "spawn", actorGuid: "child", classId: "Actor", slotId: 2,
    sceneStreamActorGuid: identity.actorGuid, streamLoadId: identity.streamLoadId });
  const child = MeshBuilder.CreateBox("child", {}, scene);
  const childMaterial = new StandardMaterial("stream-material", scene);
  child.material = childMaterial;
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
  childMaterial.diffuseTexture = texture;
  const textureReady = vi.spyOn(texture, "isReady").mockReturnValue(false);
  binding.meshes.set(2, child);
  const fog = fogVolumeBindings([{ id: "fog", classId: "FogVolumeComponent", properties: {} }]);
  binding.onVisualChanged = (slot) => {
    if (slot === 2) upsertFogVolumes(scene, "child", child, fog, !isSceneStreamSlotPending(scene, slot));
  };
  binding.onVisualChanged(2);
  admission.sync();
  expect(child.isEnabled()).toBe(false);
  expect(hasFogVolumes(scene)).toBe(false);
  expect(sceneRenderingSettings(scene).effectsPlan).toBeNull();
  expect(selectFogVolumes(scene, camera, 50)).toHaveLength(0);
  expect(renderer.render().rendered).toBe(true);
  // A normal parent-world spawn remains admitted while the stream is pending.
  const ordinary = MeshBuilder.CreateBox("normal-spawn", {}, scene);
  binding.meshes.set(3, ordinary);
  admission.sync();
  expect(ordinary.isEnabled()).toBe(true);
  expect(renderer.render().rendered).toBe(true);
  textureReady.mockReturnValue(true);
  admission.publish([2], identity);
  expect(child.isEnabled()).toBe(true);
  expect(selectFogVolumes(scene, camera, 50)).toHaveLength(1);
  await renderer.prepare();
  expect(renderer.render().rendered).toBe(true);
  retirePlaySlot(binding, 2);
  expect(hasFogVolumes(scene)).toBe(false);
  expect(sceneRenderingSettings(scene).effectsPlan).toBeNull();
  admission.clear(); renderer.dispose();
});

it("retains parent readiness failures and separates sibling publication including empty streams", async () => {
  const { scene, renderer } = host();
  const binding = createSnapshotSceneBinding();
  const parent = MeshBuilder.CreateBox("parent", {}, scene);
  const parentMaterial = new StandardMaterial("parent-material", scene);
  parent.material = parentMaterial;
  binding.meshes.set(1, parent);
  await renderer.prepare();
  const admission = createSceneStreamAdmission(scene, binding);
  admission.receive({ type: "sceneStreamLoading", actorGuid: "left", streamLoadId: 1 });
  admission.receive({ type: "sceneStreamLoading", actorGuid: "right", streamLoadId: 2 });
  admission.receive({ type: "spawn", actorGuid: "child", classId: "Actor", slotId: 2,
    sceneStreamActorGuid: "right", streamLoadId: 2 });
  const right = MeshBuilder.CreateBox("right", {}, scene);
  binding.meshes.set(2, right);
  admission.sync();
  admission.publish([], { actorGuid: "left", streamLoadId: 1 });
  expect(right.isEnabled()).toBe(false);
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
  const textureReady = vi.spyOn(texture, "isReady").mockReturnValue(false);
  parentMaterial.diffuseTexture = texture;
  markSceneReadinessDirty(scene);
  expect(renderer.render().rendered).toBe(false);
  textureReady.mockReturnValue(true);
  expect(renderer.render().rendered).toBe(true);
  admission.publish([2], { actorGuid: "right", streamLoadId: 1 });
  expect(right.isEnabled()).toBe(false);
  admission.publish([2], { actorGuid: "right", streamLoadId: 2 });
  expect(right.isEnabled()).toBe(true);
  admission.clear(); renderer.dispose();
});

it("keeps the parent drawing after cancel while native import and detached texture work retire", async () => {
  const { scene, renderer } = host();
  const binding = createSnapshotSceneBinding();
  const parent = MeshBuilder.CreateBox("parent", {}, scene);
  const parentMaterial = new StandardMaterial("parent", scene);
  parent.material = parentMaterial;
  binding.meshes.set(1, parent);
  await renderer.prepare();
  const admission = createSceneStreamAdmission(scene, binding);
  admission.receive({ type: "sceneStreamLoading", actorGuid: "cancelled", streamLoadId: 1 });
  // Native GLB loading owns Scene pending data independently of the slot's
  // abortable promise. Texture GPU work can outlive that pending-data record.
  const nativeImport = {};
  scene.addPendingData(nativeImport);
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
  vi.spyOn(texture, "isReady").mockReturnValue(false);
  admission.receive({ type: "sceneStreamRemoved", actorGuid: "cancelled", streamLoadId: 1 });
  admission.sync();
  expect(renderer.render().rendered).toBe(true);
  scene.removePendingData(nativeImport);
  admission.sync();
  expect(renderer.render().rendered).toBe(true);
  // Sharing that same pending resource with a live parent must still block it.
  parentMaterial.diffuseTexture = texture;
  markSceneReadinessDirty(scene);
  expect(renderer.render().rendered).toBe(false);
  parentMaterial.diffuseTexture = null;
  markSceneReadinessDirty(scene);
  expect(renderer.render().rendered).toBe(true);
  texture.dispose();
  admission.sync();
  expect(renderer.render().rendered).toBe(true);
  admission.clear(); renderer.dispose();
});

it("keeps canceled roots staged between Removed and Despawn and rejects obsolete publication after slot reuse", async () => {
  const { scene, renderer } = host();
  const binding = createSnapshotSceneBinding();
  binding.meshes.set(1, MeshBuilder.CreateBox("parent", {}, scene));
  await renderer.prepare();
  const admission = createSceneStreamAdmission(scene, binding);
  admission.receive({ type: "sceneStreamLoading", actorGuid: "stream", streamLoadId: 1 });
  admission.receive({ type: "spawn", actorGuid: "old-child", classId: "Actor", slotId: 2,
    sceneStreamActorGuid: "stream", streamLoadId: 1 });
  const child = MeshBuilder.CreateBox("canceled-child", {}, scene);
  const childMaterial = new StandardMaterial("child-material", scene);
  child.material = childMaterial;
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
  childMaterial.diffuseTexture = texture;
  const textureReady = vi.spyOn(texture, "isReady").mockReturnValue(false);
  binding.meshes.set(2, child);
  admission.sync();
  admission.receive({ type: "sceneStreamRemoved", actorGuid: "stream", streamLoadId: 1 });
  admission.sync();
  expect(child.isEnabled()).toBe(false);
  expect(renderer.render().rendered).toBe(true);
  admission.receive({ type: "despawn", actorGuid: "old-child", slotId: 2 });
  retirePlaySlot(binding, 2);
  admission.sync();
  expect(renderer.render().rendered).toBe(true);

  admission.receive({ type: "sceneStreamLoading", actorGuid: "stream", streamLoadId: 2 });
  admission.receive({ type: "spawn", actorGuid: "new-child", classId: "Actor", slotId: 2,
    sceneStreamActorGuid: "stream", streamLoadId: 2 });
  const replacement = MeshBuilder.CreateBox("replacement", {}, scene);
  const replacementMaterial = new StandardMaterial("replacement-material", scene);
  replacement.material = replacementMaterial;
  replacementMaterial.diffuseTexture = texture;
  binding.meshes.set(2, replacement);
  admission.sync();
  admission.receive({ type: "despawn", actorGuid: "old-child", slotId: 2 });
  admission.publish([2], { actorGuid: "stream", streamLoadId: 1 });
  admission.sync();
  expect(replacement.isEnabled()).toBe(false);
  expect(renderer.render().rendered).toBe(true);
  textureReady.mockReturnValue(true);
  admission.publish([2], { actorGuid: "stream", streamLoadId: 2 });
  expect(replacement.isEnabled()).toBe(true);
  admission.clear(); renderer.dispose();
});

it("draws editor gizmos once after each graph frame, never during preparation or skipped frames", async () => {
  const { scene, camera, renderer } = host();
  const box = MeshBuilder.CreateBox("selected", {}, scene);
  const gizmos = createGizmoHost(scene, {
    registerOverlay: (draw) => renderer.attachEditorOverlay(draw),
  });
  gizmos.attachTo(box);
  const layer = gizmos.positionGizmo.gizmoLayer.utilityLayerScene;
  let frames = 0;
  layer.onAfterRenderObservable.add(() => { frames += 1; });
  let ready = false;
  scene.addIsReadyCheck({ isReady: () => ready });
  expect(renderer.render().rendered).toBe(false);
  expect(frames).toBe(0);
  ready = true;
  await renderer.prepare();
  expect(frames).toBe(0);
  expect(renderer.render().path).toBe("frameGraph");
  expect(frames).toBe(1);
  expect(camera.getScene()).toBe(scene);

  // A new camera uses the same layer.
  const replacement = new FreeCamera("replacement", new Vector3(0, 0, -8), scene);
  scene.activeCamera = replacement;
  await renderer.prepare();
  expect(renderer.render()).toMatchObject({ path: "frameGraph", rendered: true });
  expect(layer.activeCamera).toBe(replacement);
  expect(replacement.getScene()).toBe(scene);
  expect(frames).toBe(2);
  gizmos.dispose();
  renderer.render();
  expect(frames).toBe(2);
  renderer.dispose();
});

it("restores a borrowed camera after an editor overlay fails and leaves sibling scenes usable", async () => {
  const { scene, camera, engine, renderer } = host();
  const gizmos = createGizmoHost(scene, {
    registerOverlay: (draw) => renderer.attachEditorOverlay(draw),
  });
  const layer = gizmos.positionGizmo.gizmoLayer.utilityLayerScene;
  await renderer.prepare();
  const failure = layer.onBeforeRenderObservable.add(() => { throw new Error("overlay draw failed"); });
  expect(() => renderer.render()).toThrow("overlay draw failed");
  expect(camera.getScene()).toBe(scene);
  expect(scene.activeCamera).toBe(camera);
  expect(engine._currentRenderTarget).toBeNull();
  layer.onBeforeRenderObservable.remove(failure);
  const sibling = new Scene(engine);
  sibling.activeCamera = new FreeCamera("sibling", Vector3.Zero(), sibling);
  expect(() => sibling.render()).not.toThrow();
  expect(renderer.render().readyForPresentation).toBe(true);
  gizmos.dispose();
  renderer.dispose();
  sibling.dispose();
});

it("never presents an unready scene or draws before its graph is prepared", async () => {
  const { scene, renderer } = host();
  let assetsReady = false;
  scene.addIsReadyCheck({ isReady: () => assetsReady });
  const frame = vi.fn();
  scene.onAfterRenderObservable.add(frame);
  expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false });
  expect(frame).not.toHaveBeenCalled();
  assetsReady = true;
  expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false });
  expect(frame).not.toHaveBeenCalled();
  await renderer.prepare();
  expect(frame).not.toHaveBeenCalled();
  expect(renderer.isReady()).toBe(true);
  expect(renderer.render()).toEqual({ path: "frameGraph", rendered: true, readyForPresentation: true });
  expect(frame).toHaveBeenCalledTimes(1);
  renderer.dispose();
});

it("restarts camera and resized-output preparation without drawing or releasing a stale first-frame permit", async () => {
  const { options, scene, renderer } = host();
  let assetsReady = false;
  scene.addIsReadyCheck({ isReady: () => assetsReady });
  const frame = vi.fn();
  scene.onBeforeRenderObservable.add(frame);
  const preparing = renderer.prepare();
  await vi.waitFor(() => expect(scene.objectRenderers).toHaveLength(1));
  const replacement = new FreeCamera("replacement", new Vector3(0, 0, -8), scene);
  scene.activeCamera = replacement;
  options.renderWidth = 96;
  options.renderHeight = 72;
  expect(renderer.isReady()).toBe(false);
  assetsReady = true;
  expect(await preparing).toEqual({ path: "frameGraph" });
  expect(frame).not.toHaveBeenCalled();
  expect(scene.activeCamera).toBe(replacement);
  expect(renderer.render()).toMatchObject({ path: "frameGraph", readyForPresentation: true });
  expect(scene.activeCamera).toBe(replacement);
  expect(scene.objectRenderers).toHaveLength(1);
  renderer.dispose();
});

it("rejects a superseded owner while allowing its replacement to finish preparation", async () => {
  const { scene, renderer } = host();
  let assetsReady = false;
  let current = true;
  scene.addIsReadyCheck({ isReady: () => assetsReady });
  const first = expect(renderer.prepare(() => { if (!current) throw new Error("old owner cancelled"); })).rejects.toThrow("old owner cancelled");
  await vi.waitFor(() => expect(scene.objectRenderers).toHaveLength(1));
  current = false;
  renderer.invalidate();
  const replacement = renderer.prepare();
  assetsReady = true;
  await first;
  expect(await replacement).toEqual({ path: "frameGraph" });
  expect(scene.objectRenderers).toHaveLength(1);
  expect(renderer.render()).toMatchObject({ path: "frameGraph", readyForPresentation: true });
  renderer.dispose();
});

// Play loads invalidate the graph as assets arrive (for example an Area Light's emission texture).
it("finishes a current owner's preparation when the graph is invalidated during it", async () => {
  const { scene, renderer } = host();
  let assetsReady = false;
  scene.addIsReadyCheck({ isReady: () => assetsReady });
  const preparing = renderer.prepare();
  await vi.waitFor(() => expect(scene.objectRenderers).toHaveLength(1));
  renderer.invalidate();
  assetsReady = true;
  expect(await preparing).toEqual({ path: "frameGraph" });
  expect(renderer.render()).toMatchObject({ path: "frameGraph", readyForPresentation: true });
  renderer.dispose();
});

it("disposes a pending graph without stranding readiness or touching a sibling scene", async () => {
  const { engine, scene, renderer } = host();
  scene.addIsReadyCheck({ isReady: () => false });
  const pending = expect(renderer.prepare()).rejects.toThrow("disposed");
  await vi.waitFor(() => expect(scene.objectRenderers).toHaveLength(1));
  renderer.dispose();
  await pending;
  expect(scene.objectRenderers).toHaveLength(0);
  const sibling = new Scene(engine);
  sibling.activeCamera = new FreeCamera("sibling", Vector3.Zero(), sibling);
  expect(() => sibling.render()).not.toThrow();
  expect(engine.isDisposed).toBe(false);
});

it("does not resume native task allocation after disposal during asynchronous initialization", async () => {
  const { scene, renderer } = host();
  const { started, release } = holdGraphInitialization();
  const allocate = vi.spyOn(FrameGraphTextureManager.prototype, "_allocateTextures");
  const pending = expect(renderer.prepare()).rejects.toThrow("disposed");
  await started;
  renderer.dispose();
  release();
  await pending;
  expect(allocate).not.toHaveBeenCalled();
  expect(scene.objectRenderers).toHaveLength(0);
});

it("rejects a changed output the graph cannot draw without drawing a frame", async () => {
  const { scene, camera, renderer } = host();
  const { started, release } = holdGraphInitialization();
  const pending = renderer.prepare();
  const settled = pending.then(() => undefined, (error: unknown) => error);
  await started;
  const target = new RenderTargetTexture("color-only target", 32, scene);
  camera.outputRenderTarget = target;
  const frame = vi.fn();
  scene.onAfterRenderObservable.add(frame);
  try {
    expect(renderer.isReady()).toBe(false);
    expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false });
  } finally {
    release();
  }
  expect(String(await settled)).toContain("color/depth");
  expect(frame).not.toHaveBeenCalled();
  expect(camera.outputRenderTarget).toBe(target);
  renderer.dispose();
  expect(target.getInternalTexture()).not.toBeNull();
});

it("rejects the loading owner at the preparation deadline instead of accepting a timeout as readiness", async () => {
  const { scene, renderer } = host();
  scene.addIsReadyCheck({ isReady: () => false });
  const pending = expect(renderer.prepare()).rejects.toThrow("timed out");
  await vi.waitFor(() => expect(scene.objectRenderers).toHaveLength(1));
  const now = performance.now();
  vi.spyOn(performance, "now").mockReturnValue(now + 10_001);
  await pending;
  expect(scene.objectRenderers).toHaveLength(0);
  renderer.dispose();
});

it("rejects a frozen active-mesh queue instead of drawing it", async () => {
  const { scene, renderer } = host();
  const mesh = MeshBuilder.CreateBox("box", {}, scene);
  await new Promise<void>((resolve) => scene.freezeActiveMeshes(false, resolve));
  const drawn = vi.spyOn(mesh, "render");
  await expect(renderer.prepare()).rejects.toThrow("Frozen");
  expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false });
  expect(drawn).not.toHaveBeenCalled();
  renderer.dispose();
});


it("retires pending allocation before the host releases a borrowed target", async () => {
  const { scene, camera, renderer } = host();
  const target = new RenderTargetTexture("borrowed output", 32, scene);
  // NullEngine has no depth-texture driver; this cancellation case never builds
  // or draws attachments. Supply the supported-target boundary only.
  vi.spyOn(target, "depthStencilTexture", "get").mockReturnValue(target.getInternalTexture());
  camera.outputRenderTarget = target;
  const borrowedRenderers = [...scene.objectRenderers];
  const { started, release } = holdGraphInitialization();
  const pending = expect(renderer.prepare()).rejects.toThrow("disposed");
  await started;
  let retired = false;
  const retirement = renderer.retire().then(() => { retired = true; });
  await Promise.resolve();
  expect(retired).toBe(false);
  expect(target.getInternalTexture()).not.toBeNull();
  release();
  await pending;
  await retirement;
  expect(scene.objectRenderers).toEqual(borrowedRenderers);
  expect(target.getInternalTexture()).not.toBeNull();
  target.dispose();
});


it("rejects retirement when owned task cleanup fails instead of permitting target destruction", async () => {
  const { scene, renderer } = host();
  await renderer.prepare();
  const taskRenderer = scene.objectRenderers[0]!;
  const dispose = vi.spyOn(taskRenderer, "dispose").mockImplementationOnce(() => { throw new Error("native cleanup failed"); });
  await expect(renderer.retire()).rejects.toThrow("native cleanup failed");
  dispose.mockRestore();
});


it("reports asynchronous retirement cleanup failure without permitting the borrowed owner to release", async () => {
  const { scene, renderer } = host();
  const { started, release } = holdGraphInitialization();
  const preparing = expect(renderer.prepare()).rejects.toThrow();
  await started;
  const taskRenderer = scene.objectRenderers[0]!;
  const dispose = vi.spyOn(taskRenderer, "dispose").mockImplementation(() => { throw new Error("pending cleanup failed"); });
  const retirement = expect(renderer.retire()).rejects.toThrow("pending cleanup failed");
  release();
  await preparing;
  await retirement;
  dispose.mockRestore();
});


it("releases replaced stack tasks without a frame and rejects stale facade disposal", async () => {
  const { scene, camera, renderer } = host();
  const library = new MaterialLibrary();
  try {
    const first = renderer.attachPostProcess({ scene, camera, library, stack: [], documentFor: () => null });
    await renderer.prepare();
    const old = scene.objectRenderers[0]!;
    const second = renderer.attachPostProcess({ scene, camera, library, stack: [], documentFor: () => null });
    expect(scene.objectRenderers).not.toContain(old);
    await renderer.prepare();
    const current = scene.objectRenderers[0]!;
    first.dispose();
    expect(scene.objectRenderers).toContain(current);
    second.dispose();
    expect(scene.objectRenderers).not.toContain(current);
  } finally { await renderer.retire(); library.dispose(); }
});


it("reports refused graph allocation for an authored stack without attaching camera passes", async () => {
  const { scene, camera, engine, renderer } = host();
  engine.getCaps().depthTextureExtension = true;
  limitManagedRenderBytes(engine, 1);
  const library = new MaterialLibrary();
  const document = createDefaultMaterialDocument("Scene Color", "postProcess");
  try {
    renderer.attachPostProcess({ scene, camera, library, documentFor: () => document,
      stack: [{ id: "pass", materialGuid: "color", enabled: true, order: 0 }] });
    await expect(renderer.prepare()).rejects.toThrow("reservation");
    expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false });
    expect(camera._postProcesses.filter(Boolean)).toHaveLength(0);
  } finally { await renderer.retire(); library.dispose(); }
});

it("caches strict readiness on unchanged frames and re-probes once after a scene change", async () => {
  const { scene, renderer } = host();
  MeshBuilder.CreateBox("box", {}, scene);
  await renderer.prepare();
  expect(renderer.isReady()).toBe(true);
  expect(renderer.render()).toEqual({
    path: "frameGraph",
    rendered: true,
    readyForPresentation: true,
  });
  const checks = renderer.strictReadinessChecks;
  for (let frame = 0; frame < 10; frame += 1) {
    expect(renderer.isReady()).toBe(true);
    expect(renderer.render()).toMatchObject({
      path: "frameGraph",
      rendered: true,
      readyForPresentation: true,
    });
  }
  expect(renderer.strictReadinessChecks).toBe(checks);
  MeshBuilder.CreateBox("added", {}, scene);
  expect(renderer.isReady()).toBe(true);
  expect(renderer.strictReadinessChecks).toBe(checks + 1);
  renderer.dispose();
});

it("draws unvalidated frames without acknowledging them and re-probes a scene change once", async () => {
  const { scene, renderer } = host();
  MeshBuilder.CreateBox("box", {}, scene);
  await renderer.prepare();
  const frame = vi.fn();
  scene.onAfterRenderObservable.add(frame);
  expect(renderer.render(false)).toEqual({ path: "frameGraph", rendered: true, readyForPresentation: false });
  expect(frame).toHaveBeenCalledTimes(1);
  const checks = renderer.strictReadinessChecks;
  MeshBuilder.CreateBox("added", {}, scene);
  expect(renderer.render(false)).toEqual({ path: "frameGraph", rendered: true, readyForPresentation: false });
  expect(renderer.render()).toEqual({ path: "frameGraph", rendered: true, readyForPresentation: true });
  expect(frame).toHaveBeenCalledTimes(3);
  expect(renderer.strictReadinessChecks).toBe(checks + 1);
  renderer.dispose();
});

it.each(["isReady", "render"] as const)("applies a new shadow profile while %s is waiting for shaders", async (probe) => {
  const { scene, engine, renderer } = host();
  Object.assign(engine.getCaps(), { maxTextureSize: 4096, textureHalfFloatRender: true, textureHalfFloatLinearFiltering: true });
  const sun = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
  const controller = sceneShadowController(scene);
  controller.register(sun, true);
  setSceneRenderSettings(scene, { shadows: normalizeShadowSettings({ profile: "medium", cascades: 1 }) });
  controller.sync();
  expect(controller.generator(sun)?.getShadowMap()?.getSize().width).toBe(2048);
  await renderer.prepare();
  let shadersReady = false;
  scene.addIsReadyCheck({ isReady: () => shadersReady });
  markSceneReadinessDirty(scene);
  setSceneRenderSettings(scene, { shadows: normalizeShadowSettings({ profile: "low", cascades: 1 }) });
  if (probe === "isReady") expect(renderer.isReady()).toBe(false);
  else expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false });
  expect(controller.generator(sun)?.getShadowMap()?.getSize().width).toBe(1024);
  shadersReady = true;
  await renderer.prepare();
  expect(renderer.isReady()).toBe(true);
  renderer.dispose();
});

it("holds frames when light admission invalidates its cached shader readiness", async () => {
  const { scene, renderer } = host();
  const quality = normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 1 } });
  updateSceneRenderingSettings(scene, { quality });
  const first = new PointLight("first", new Vector3(0, 0, -3), scene);
  const second = new PointLight("second", new Vector3(100, 0, -3), scene);
  let secondReady = false;
  scene.addIsReadyCheck({ isReady: () => !second.isEnabled() || secondReady });
  await renderer.prepare();
  expect(renderer.render()).toMatchObject({ path: "frameGraph", rendered: true });
  const draws = vi.fn();
  scene.onAfterRenderObservable.add(draws);
  first.position.x = 100;
  second.position.x = 0;
  expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false });
  expect(second.isEnabled()).toBe(true);
  expect(draws).not.toHaveBeenCalled();
  secondReady = true;
  await renderer.prepare();
  expect(draws).not.toHaveBeenCalled();
  expect(renderer.render()).toMatchObject({ rendered: true });
  expect(draws).toHaveBeenCalledOnce();
  renderer.dispose();
});

it("holds a frame invalidated during its render callbacks", async () => {
  const { scene, renderer } = host();
  const path = "frameGraph";
  await renderer.prepare();
  let ready = true;
  scene.addIsReadyCheck({ isReady: () => ready });
  expect(renderer.render()).toMatchObject({ path, rendered: true });
  scene.onBeforeRenderObservable.addOnce(() => { ready = false; markSceneReadinessDirty(scene); });
  expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false });
  expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false });
  ready = true;
  expect(renderer.render()).toMatchObject({ path, rendered: true, readyForPresentation: true });
  renderer.dispose();
});

it("attaches an inactive outline view without allocating or replacing the admitted graph and prevents cross-view reuse", async () => {
  const { scene, engine, renderer } = host();
  await renderer.prepare();
  const objectRenderer = scene.objectRenderers[0];
  const reservations = managedRenderReservations(engine);
  const view = SharedOutlineOwner.forScene(scene).createView("editor");
  const detach = renderer.attachSharedOutline(view);
  const sibling = new SceneRenderCoordinator(scene);
  expect(() => sibling.attachSharedOutline(view)).toThrow("already attached");
  expect(renderer.render()).toMatchObject({ path: "frameGraph", readyForPresentation: true });
  expect(scene.objectRenderers[0]).toBe(objectRenderer);
  expect(renderer.taskNames().some((name) => name.includes("Shared outlines"))).toBe(false);
  expect(managedRenderReservations(engine)).toEqual(reservations);
  detach();
  expect(renderer.render()).toMatchObject({ path: "frameGraph", readyForPresentation: true });
  expect(scene.objectRenderers[0]).toBe(objectRenderer);
  const detachSibling = sibling.attachSharedOutline(view);
  detachSibling();
  const foreign = new Scene(engine);
  expect(() => renderer.attachSharedOutline(SharedOutlineOwner.forScene(foreign).createView("foreign"))).toThrow("another Scene");
  sibling.dispose();
  renderer.dispose();
  view.dispose();
  foreign.dispose();
});

it("rejects an outlined view on a scene the graph cannot draw without drawing it", async () => {
  const { scene, renderer } = host();
  const box = MeshBuilder.CreateBox("outlined", {}, scene);
  const view = SharedOutlineOwner.forScene(scene).createView("editor");
  view.setContribution("selection", {
    kind: "selection", targets: [{ key: "actor", meshes: [box] }],
    color: [1, 0, 0], width: 1, throughMeshes: true,
  });
  const detach = renderer.attachSharedOutline(view);
  const nativeDraw = vi.fn();
  scene.customRenderFunction = nativeDraw;
  await expect(renderer.prepare()).rejects.toThrow("render owner");
  expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false });
  expect(nativeDraw).not.toHaveBeenCalled();
  detach();
  renderer.dispose();
  view.dispose();
});
