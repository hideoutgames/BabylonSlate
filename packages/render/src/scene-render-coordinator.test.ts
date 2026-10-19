import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { limitManagedRenderBytes, managedRenderReservations } from "./managed-render-resources";
import { MaterialLibrary } from "./material-library";
import { Color3, DirectionalLight, Effect, FreeCamera, HemisphericLight, MeshBuilder, NullEngine, NullEngineOptions, PointLight, RawTexture, RenderTargetTexture, Scene, SpotLight, StandardMaterial, Vector3, VertexBuffer } from "@babylonjs/core";
import { SceneOutlineHost } from "./scene-outline-host";
import { createSceneStreamAdmission, isSceneStreamSlotPending } from "./scene-stream-admission";
import { createSnapshotSceneBinding, retirePlaySlot } from "./snapshot-apply";
import { createDefaultAudioPayload, createDefaultSoundAttenuationPayload } from "@babylonslate/assets";
import { createActor, createDefaultScene, fogVolumeBindings, normalizeRenderingQuality, normalizeShadowSettings, outlineBindings } from "@babylonslate/core";
import { EditorDebugOverlay } from "./editor-debug-overlay";
import { sceneShadowController } from "./shadow-controller";
import { setSceneRenderSettings } from "./scene-render-mode";
import { sceneRenderingSettings, updateSceneRenderingSettings } from "./render-settings";
import { hasFogVolumes, selectFogVolumes, upsertFogVolumes } from "./fog-volumes";
import { markSceneReadinessDirty } from "./scene-perf";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphTextureManager } from "@babylonjs/core/FrameGraph/frameGraphTextureManager";
import { PreparationTimedOut, SceneRenderCoordinator } from "./scene-render-coordinator";
import {
  SCENE_DRIVER_COMPILE_TIMEOUT_MS, SCENE_PREPARATION_CEILING_MS, SCENE_THREAD_HELD_BUDGET_MS, SCENE_THREAD_HELD_MS,
} from "./stall-deadline";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { SharedOutlineOwner } from "./shared-outline";
import { createGizmoHost } from "./gizmo-host";
import { applyCableFrame, createCableMesh } from "./cable-mesh";
import { beginPipelineDeferral, PIPELINE_DEFERRAL_HOLD_CAP_MS } from "./webgpu-pipeline-deferral";
import { ForwardSceneFrameGraph } from "./framegraph-forward-scene";

// NullEngine is not WebGPU, so the deferral itself never engages; its scopes are the seam here.
vi.mock("./webgpu-pipeline-deferral", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webgpu-pipeline-deferral")>();
  return { ...actual, beginPipelineDeferral: vi.fn(actual.beginPipelineDeferral) };
});
const { beginPipelineDeferral: actualBeginPipelineDeferral } =
  await vi.importActual<typeof import("./webgpu-pipeline-deferral")>("./webgpu-pipeline-deferral");

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(beginPipelineDeferral).mockImplementation(actualBeginPipelineDeferral);
  for (const engine of engines.splice(0)) engine.dispose();
});

function host(deferPipelines = false) {
  const options = new NullEngineOptions();
  options.renderWidth = 80;
  options.renderHeight = 64;
  const engine = adaptNullEngineFrameGraph(new NullEngine(options));
  engines.push(engine);
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  scene.activeCamera = camera;
  const renderer = new SceneRenderCoordinator(scene, { deferPipelines });
  return { options, engine, scene, camera, renderer };
}

describe("deferred WebGPU pipelines", () => {
  /** Every scope the view opens from now on skips `skipped` draws and waits while `waiting` says so. */
  const scopes = (skipped: () => number, waiting: () => boolean) =>
    vi.mocked(beginPipelineDeferral).mockImplementation(() => ({ close: skipped, waiting }));

  it("holds the last image, drawing nothing more, until the pipelines a frame skipped exist", async () => {
    const { scene, renderer } = host(true);
    await renderer.prepare();
    const draws = vi.spyOn(scene, "render");
    let waiting = true;
    scopes(() => 2, () => waiting);
    expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false, reason: "Render pipelines are compiling." });
    expect(renderer.holdingForPipelines).toBe(true);
    expect(renderer.render().rendered).toBe(false);
    expect(draws).toHaveBeenCalledTimes(1);
    waiting = false;
    scopes(() => 0, () => false);
    expect(renderer.render()).toMatchObject({ rendered: true, readyForPresentation: true });
    expect(renderer.holdingForPipelines).toBe(false);
    expect(draws).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it("starts no new deferrals once a hold outlasts its cap, until a frame draws or needs preparation", async () => {
    const { renderer } = host(true);
    await renderer.prepare();
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let skipped = 1;
    const begin = scopes(() => skipped, () => false);
    const starts = () => (begin.mock.calls.at(-1)?.[2] as { startsDeferrals?: boolean } | undefined)?.startsDeferrals;
    renderer.render();
    expect(starts()).toBe(true);
    now += PIPELINE_DEFERRAL_HOLD_CAP_MS;
    renderer.render();
    expect(starts()).toBe(false);
    // A drawn frame ends the run of held frames.
    skipped = 0;
    expect(renderer.render().rendered).toBe(true);
    skipped = 1;
    renderer.render();
    expect(starts()).toBe(true);
    // So does a frame that skipped nothing because the graph needed preparation.
    now += PIPELINE_DEFERRAL_HOLD_CAP_MS;
    skipped = 0;
    vi.spyOn(ForwardSceneFrameGraph.prototype, "render")
      .mockReturnValueOnce({ path: "frameGraph", reason: "FrameGraph preparation is required.", rendered: false });
    expect(renderer.render()).toMatchObject({ rendered: false, reason: "FrameGraph preparation is required." });
    expect(starts()).toBe(false);
    expect(renderer.holdingForPipelines).toBe(false);
    skipped = 1;
    renderer.render();
    expect(starts()).toBe(true);
    renderer.dispose();
  });

  it("ends a hold on invalidation: a switched scene's first frame neither waits for the old pipelines nor inherits an expired cap", async () => {
    const { renderer } = host(true);
    await renderer.prepare();
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const begin = scopes(() => 1, () => true);
    const starts = () => (begin.mock.calls.at(-1)?.[2] as { startsDeferrals?: boolean } | undefined)?.startsDeferrals;
    renderer.render();
    expect(renderer.holdingForPipelines).toBe(true);
    now += PIPELINE_DEFERRAL_HOLD_CAP_MS;
    renderer.invalidate();
    expect(renderer.holdingForPipelines).toBe(false);
    await renderer.prepare();
    // The old scene's pipelines are still pending, yet the new scene's first frame opens its own scope.
    const frames = begin.mock.calls.length;
    scopes(() => 0, () => false);
    expect(renderer.render()).toMatchObject({ rendered: true });
    expect(begin).toHaveBeenCalledTimes(frames + 1);
    expect(starts()).toBe(true);
    renderer.dispose();
  });
});

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
  // Babylon 9.29 cube image loads register a bare GUID string per face.
  const cubeImage = "cube-image-token";
  scene.addPendingData(cubeImage);
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
  vi.spyOn(texture, "isReady").mockReturnValue(false);
  admission.receive({ type: "sceneStreamRemoved", actorGuid: "cancelled", streamLoadId: 1 });
  admission.sync();
  expect(renderer.render().rendered).toBe(true);
  // Named scene-level work, such as a water reflection's irradiance, is the
  // parent's own and still holds it while the stream scope exists.
  const parentWork = new (class ParentSceneWork {})();
  scene.addPendingData(parentWork);
  markSceneReadinessDirty(scene);
  expect(renderer.render().rendered).toBe(false);
  scene.removePendingData(parentWork);
  markSceneReadinessDirty(scene);
  expect(renderer.render().rendered).toBe(true);
  scene.removePendingData(nativeImport);
  scene.removePendingData(cubeImage);
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

/**
 * A virtual `performance.now()` that moves only when a test advances it from
 * inside a readiness probe, so the real speed of the runner never changes what a
 * gap between checkpoints looks like. A probe that advances by `POLL_MS` models
 * one poll of the preparation loop; one that advances by seconds models a
 * synchronous call that held the thread.
 */
function virtualClock() {
  // A whole millisecond, so sums of whole-millisecond advances stay exact: from a
  // fractional start, "now + bound" and the elapsed difference round apart.
  const start = Math.floor(performance.now());
  let now = start;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return { advance: (ms: number) => { now += ms; }, elapsed: () => now - start };
}
/** The longest gap that still counts as polling. */
const POLL_MS = SCENE_THREAD_HELD_MS - 100;

it("rejects the loading owner at the preparation deadline instead of accepting a timeout as readiness", async () => {
  const { scene, renderer } = host();
  const clock = virtualClock();
  scene.addIsReadyCheck({ isReady: () => { clock.advance(POLL_MS); return false; } });
  await expect(renderer.prepare()).rejects.toThrow("timed out");
  expect(scene.objectRenderers).toHaveLength(0);
  renderer.dispose();
});

// Without KHR_parallel_shader_compile (SwiftShader) the probe links every effect
// before it returns, and on a cold runner that held the thread for 13 to 15 s.
describe("preparation while a synchronous probe holds the thread", () => {
  it("finishes when one probe outlasts the preparation deadline and the next finds the scene ready", async () => {
    const { scene, renderer } = host();
    const clock = virtualClock();
    let probes = 0;
    scene.addIsReadyCheck({ isReady: () => { probes += 1; if (probes === 1) clock.advance(15_000); return probes > 1; } });
    await expect(renderer.prepare()).resolves.toEqual({ path: "frameGraph" });
    renderer.dispose();
  });

  it("finishes when the probe that held the thread is the one that finds the scene ready", async () => {
    const { scene, renderer } = host();
    const clock = virtualClock();
    scene.addIsReadyCheck({ isReady: () => { clock.advance(15_000); return true; } });
    await expect(renderer.prepare()).resolves.toEqual({ path: "frameGraph" });
    renderer.dispose();
  });

  it("still rejects a scene that never becomes ready after the thread was held", async () => {
    const { scene, renderer } = host();
    const clock = virtualClock();
    let probes = 0;
    scene.addIsReadyCheck({ isReady: () => { probes += 1; clock.advance(probes === 1 ? 15_000 : POLL_MS); return false; } });
    await expect(renderer.prepare()).rejects.toThrow("timed out");
    renderer.dispose();
  });

  // Nothing above the coordinator bounds a preparation, so a credit without a ceiling could hold a scene that
  // never becomes ready (a texture that never arrives, on a host where every probe is slow) forever.
  it("rejects a scene that stays unready while every probe holds the thread, once the credit budget is spent", async () => {
    const { scene, renderer } = host();
    const clock = virtualClock();
    scene.addIsReadyCheck({ isReady: () => { clock.advance(SCENE_THREAD_HELD_MS * 1.5); return false; } });
    await expect(renderer.prepare()).rejects.toThrow("timed out");
    // The 60 s total bound, extended by at most the credit budget (plus the probe that crossed it).
    expect(clock.elapsed()).toBeGreaterThan(SCENE_THREAD_HELD_BUDGET_MS);
    expect(clock.elapsed()).toBeLessThanOrEqual(2 * SCENE_THREAD_HELD_BUDGET_MS + 2 * SCENE_THREAD_HELD_MS);
    renderer.dispose();
  });

  // Every probe finds the scene ready, so the graph's own readiness loop exits at once and only the coordinator
  // still bounds the preparation: each probe also invalidates the graph, the way an asset arriving mid-load does,
  // and the coordinator starts over.
  it("bounds a preparation that every probe invalidates while holding the thread, once the coordinator's credit budget is spent", async () => {
    const { scene, renderer } = host();
    const clock = virtualClock();
    const held = 5_000;
    scene.addIsReadyCheck({ isReady: () => { clock.advance(held); renderer.invalidate(); return true; } });
    await expect(renderer.prepare()).rejects.toThrow("timed out");
    expect(clock.elapsed()).toBeGreaterThan(SCENE_THREAD_HELD_BUDGET_MS);
    // The 60 s total bound and the credit budget, plus one 60 s renewal for the effects the first build compiled:
    // every rebuild compiles the same variants again, which is no progress.
    expect(clock.elapsed()).toBeLessThanOrEqual(3 * SCENE_THREAD_HELD_BUDGET_MS + 2 * held);
    renderer.dispose();
  }, 20_000);
});

describe("preparation while the driver compiles", () => {
  /** A scene that is not ready while one effect compiles on a parallel-compile driver. */
  function compilingHost() {
    const made = host();
    made.engine.getCaps().parallelShaderCompile = { COMPLETION_STATUS_KHR: 0x91b1 };
    let compiled = false;
    (made.engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects["water"] =
      { isReady: () => compiled, getCompilationError: () => "" };
    // Each poll of the readiness loop is one probe, and the clock follows the polls.
    const clock = virtualClock();
    let polls = 0;
    made.scene.addIsReadyCheck({ isReady: () => { polls += 1; clock.advance(POLL_MS); return compiled; } });
    const settled: { value: unknown } = { value: undefined };
    const done = made.renderer.prepare().then(() => { settled.value = "ready"; }, (error: unknown) => { settled.value = error; });
    const pollsPast = (ms: number) => vi.waitFor(() => expect(polls * POLL_MS).toBeGreaterThan(ms), { timeout: 20_000 });
    return { ...made, settled, done, finishCompile: () => { compiled = true; }, pollsPast, polledMs: () => polls * POLL_MS };
  }

  it("outlasts the preparation deadline and finishes when the compile completes", async () => {
    const { renderer, settled, done, finishCompile, pollsPast } = compilingHost();
    await pollsPast(10_001);
    expect(settled.value).toBeUndefined();
    finishCompile();
    await done;
    expect(settled.value).toBe("ready");
    renderer.dispose();
  });

  it("rejects once the same compile has been pending for the driver bound", async () => {
    const { renderer, settled, done, pollsPast, polledMs } = compilingHost();
    await pollsPast(10_001);
    expect(settled.value).toBeUndefined();
    await done;
    expect(settled.value).toEqual(expect.objectContaining({ message: expect.stringContaining("timed out") }));
    expect(polledMs()).toBeGreaterThan(SCENE_DRIVER_COMPILE_TIMEOUT_MS);
    renderer.dispose();
  });
});

// SwiftShader has no parallel compile, so each probe links its variants before it returns and nothing is ever pending
// on the driver; with the extension exposed, a program already complete at its first check looks the same.
// Links shorter than SCENE_THREAD_HELD_MS are polling to the held-thread credit; finished variants are progress.
describe.each([false, true])("preparation while synchronous links finish one after another (parallel compile exposed: %s)", (exposed) => {
  /** Each probe advances the virtual clock by `ms`; while `linking()` it also finishes one more shader variant. */
  function linkingHost(ms: number, linking: (probe: number) => boolean, ready: (probe: number) => boolean) {
    const made = host();
    if (exposed) made.engine.getCaps().parallelShaderCompile = { COMPLETION_STATUS_KHR: 0x91b1 };
    const effects = (made.engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects;
    const clock = virtualClock();
    let probes = 0;
    let lastLink = 0;
    made.scene.addIsReadyCheck({ isReady: () => {
      probes += 1;
      clock.advance(ms);
      if (linking(probes)) {
        effects[`linked-${probes}`] = { isReady: () => true, getCompilationError: () => "" };
        lastLink = clock.elapsed();
      }
      return ready(probes);
    } });
    return { ...made, clock, lastLink: () => lastLink };
  }

  // Past the coordinator's 10 s and 60 s bounds, and the graph loop's 10 s bound plus its probe credit.
  it("finishes a cold load whose short links together outlast every preparation bound", async () => {
    const { renderer, clock } = linkingHost(500, () => true, (probe) => probe > 160);
    await expect(renderer.prepare()).resolves.toEqual({ path: "frameGraph" });
    expect(clock.elapsed()).toBeGreaterThan(SCENE_THREAD_HELD_BUDGET_MS + 20_000);
    renderer.dispose();
  });

  it("fails once links stop finishing, a whole bound after the last one, and reports the shaders compiled", async () => {
    const { renderer, clock, lastLink } = linkingHost(500, (probe) => probe <= 40, () => false);
    const error = await renderer.prepare().then(() => null, (failure: unknown) => failure as Error);
    expect(error).toBeInstanceOf(PreparationTimedOut);
    expect(error?.message).toContain("timed out after 10 s without progress");
    // The 40 links, and the graph's own effects.
    expect(Number(/Shaders: (\d+) compiled while waiting/.exec(error?.message ?? "")?.[1])).toBeGreaterThanOrEqual(40);
    expect(lastLink()).toBeCloseTo(20_000);
    expect(clock.elapsed() - lastLink()).toBeGreaterThanOrEqual(10_000);
    expect(clock.elapsed() - lastLink()).toBeLessThanOrEqual(20_000 + 500);
    renderer.dispose();
  });

  // Every probe holds the thread for seconds, so the held-thread credit applies too until its budget is spent; neither
  // it nor the progress extends the ceiling.
  it("ends a preparation that keeps linking but never becomes ready at the ceiling", async () => {
    const held = 5_000;
    const { renderer, clock } = linkingHost(held, () => true, () => false);
    const error = await renderer.prepare().then(() => null, (failure: unknown) => failure as Error);
    expect(error).toBeInstanceOf(PreparationTimedOut);
    expect(error?.message).toContain(`timed out after its ${SCENE_PREPARATION_CEILING_MS / 1000} s limit`);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(SCENE_PREPARATION_CEILING_MS);
    expect(clock.elapsed()).toBeLessThanOrEqual(SCENE_PREPARATION_CEILING_MS + held);
    renderer.dispose();
  });
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

it("keeps strict readiness cached across in-place light value edits, and re-probes when a light stops illuminating", async () => {
  const { scene, renderer } = host();
  MeshBuilder.CreateBox("box", {}, scene);
  const point = new PointLight("point", new Vector3(0, 2, -3), scene);
  const spot = new SpotLight("spot", new Vector3(0, 2, 3), new Vector3(0, -1, 0), 1, 2, scene);
  const sky = new HemisphericLight("sky", Vector3.Up(), scene);
  await renderer.prepare();
  // The lights' shader variants may compile asynchronously before the scene is admitted.
  await vi.waitFor(() => { expect(renderer.render()).toMatchObject({ rendered: true, readyForPresentation: true }); });
  const checks = renderer.strictReadinessChecks;
  for (let edit = 1; edit <= 5; edit += 1) {
    point.range = 4 + edit;
    point.intensity = 1 + edit;
    point.diffuse = new Color3(edit / 5, 0.5, 0.25);
    spot.angle = 0.5 + edit / 10;
    spot.innerAngle = 0.2 + edit / 10;
    sky.groundColor = new Color3(0, edit / 10, 0);
    expect(renderer.render()).toMatchObject({ rendered: true, readyForPresentation: true });
  }
  expect(renderer.strictReadinessChecks).toBe(checks);
  point.setEnabled(false);
  renderer.render();
  expect(renderer.strictReadinessChecks).toBeGreaterThan(checks);
  renderer.dispose();
});

it("is settled only while no preparation is running", async () => {
  const { renderer } = host();
  expect(renderer.settled).toBe(true);
  const preparing = renderer.prepare();
  expect(renderer.settled).toBe(false);
  await preparing;
  expect(renderer.settled).toBe(true);
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

describe("selection outline changes", () => {
  function outlinedScene(strictOutline = true) {
    const setup = host();
    const { scene, renderer } = setup;
    const meshes = ["a", "b", "c"].map((name, index) => {
      const mesh = MeshBuilder.CreateBox(name, {}, scene);
      mesh.position.x = index - 1;
      return mesh;
    });
    const instance = MeshBuilder.CreateBox("source", {}, scene).createInstance("instance");
    const outlines = new SceneOutlineHost(scene, renderer, () => {});
    // "c" carries an authored outline, so the strict occluder group is active too.
    const ink = strictOutline
      ? outlineBindings("c", [{ id: "ink", classId: "OutlineComponent", properties: { color: [1, 0, 0], width: 2 } }]) : [];
    outlines.replaceActors([...meshes, instance].map((mesh) => ({ id: mesh.name, meshes: [mesh], bindings: mesh.name === "c" ? ink : [] })));
    return { ...setup, outlines };
  }

  it("holds frames for the newly selected meshes alone, without a scene probe or graph rebuild", async () => {
    const { renderer, outlines } = outlinedScene();
    outlines.setSelection(["a"]);
    await renderer.prepare();
    expect(renderer.render()).toMatchObject({ rendered: true, readyForPresentation: true });
    expect(renderer.taskNames()).toContain("Shared outlines");
    const { graphBuilds } = renderer.diagnostics();
    const strict = renderer.strictReadinessChecks;
    const outline = renderer.outlineReadinessChecks;
    // The new selection's mask program is still compiling: no frame may present before it is ready.
    let compiled = false;
    const isReady = Effect.prototype.isReady;
    vi.spyOn(Effect.prototype, "isReady").mockImplementation(function (this: Effect) {
      return (this.name === "babylonSlateSharedOutlineMask" ? compiled : true) && isReady.call(this);
    });
    outlines.setSelection(["b"]);
    for (let frame = 0; frame < 3; frame += 1)
      expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false });
    compiled = true;
    expect(renderer.render()).toMatchObject({ rendered: true, readyForPresentation: true });
    expect(renderer.strictReadinessChecks).toBe(strict);
    expect(renderer.diagnostics().graphBuilds).toBe(graphBuilds);
    expect(renderer.outlineReadinessChecks).toBeGreaterThan(outline);
    // Admitted again: steady frames add no probe of any kind.
    const settled = renderer.outlineReadinessChecks;
    expect(renderer.render()).toMatchObject({ rendered: true, readyForPresentation: true });
    expect(renderer.outlineReadinessChecks).toBe(settled);
    expect(renderer.strictReadinessChecks).toBe(strict);
    renderer.dispose();
  });

  it("probes the scene again when a selection gives an instance source its identity stream", async () => {
    const { renderer, outlines } = outlinedScene(false);
    outlines.setSelection(["a"]);
    await renderer.prepare();
    expect(renderer.render()).toMatchObject({ rendered: true, readyForPresentation: true });
    const strict = renderer.strictReadinessChecks;
    outlines.setSelection(["instance"]);
    expect(renderer.render()).toMatchObject({ rendered: true, readyForPresentation: true });
    expect(renderer.strictReadinessChecks).toBeGreaterThan(strict);
    renderer.dispose();
  });
});

describe("editor selection guides", () => {
  it("shows, edits and hides light, camera and audio guides without a scene probe or graph rebuild", async () => {
    const { scene, renderer } = host();
    MeshBuilder.CreateBox("world", {}, scene);
    // The editor builds its overlay before content loads, so the guides join the first probe.
    const overlay = new EditorDebugOverlay(scene, { now: () => 0 });
    const document = (range: number) => ({
      ...createDefaultScene(),
      actors: [
        createActor("spot", "Spot", {
          components: [{ id: "light", classId: "LightComponent", properties: { lightKind: "spot", range, outerAngle: 40 } }],
        }),
        createActor("cam", "Camera", {
          components: [{ id: "camera", classId: "CameraComponent", properties: { fieldOfView: 60 } }],
        }),
        createActor("speaker", "Speaker", {
          components: [{ id: "audio", classId: "AudioComponent", properties: { audioAssetGuid: "sound" } }],
        }),
      ],
    });
    const audioLibrary = {
      audio: new Map([["sound", { ...createDefaultAudioPayload(), soundAttenuationGuid: "near" }]]),
      attenuations: new Map([["near", { ...createDefaultSoundAttenuationPayload(), innerRadius: 2, maxRadius: 20 }]]),
    };
    await renderer.prepare();
    expect(renderer.render()).toMatchObject({ rendered: true, readyForPresentation: true });
    const strict = renderer.strictReadinessChecks;
    const { graphBuilds } = renderer.diagnostics();
    // Select a light, drag its range, switch to the camera and an emitter, select all, then clear.
    for (const [range, selectedActorIds] of [[10, ["spot"]], [14, ["spot"]], [14, ["cam"]], [14, ["speaker"]], [14, ["spot", "cam", "speaker"]], [14, []]] as const) {
      overlay.sync({ sceneData: document(range), selectedActorIds, audioLibrary });
      expect(renderer.render()).toMatchObject({ rendered: true, readyForPresentation: true });
    }
    expect(renderer.strictReadinessChecks).toBe(strict);
    expect(renderer.diagnostics().graphBuilds).toBe(graphBuilds);
    overlay.dispose();
    renderer.dispose();
  });
});
