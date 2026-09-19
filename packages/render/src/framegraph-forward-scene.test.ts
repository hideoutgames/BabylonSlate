import {
  FreeCamera,
  MeshBuilder,
  NullEngine,
  NullEngineOptions,
  PointLight,
  RenderTargetTexture,
  RawTexture,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
  Viewport,
} from "@babylonjs/core";
import { FloatingOriginCurrentScene } from "@babylonjs/core/Materials/floatingOriginMatrixOverrides";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { afterEach, expect, it, vi } from "vitest";
import { ForwardSceneFrameGraph } from "./framegraph-forward-scene";
import { setSceneRenderSettings } from "./scene-render-mode";
import { configureCutoutSorting } from "./sorting";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

function host(engine = new NullEngine()) {
  if (!engines.includes(engine)) engines.push(engine);
  // Pinned MRT extension installs WebGL calls on ThinEngine without NullEngine
  // overrides. Supply only that absent GPU boundary; graph/tasks remain real.
  vi.spyOn(engine, "buildTextureLayout").mockImplementation(
    (enabled, backbuffer) =>
      backbuffer
        ? [0x0405]
        : enabled.map((value, index) => (value ? 0x8ce0 + index : 0)),
  );
  vi.spyOn(engine, "bindAttachments").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachment").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachmentForRenderTarget").mockImplementation(
    () => {},
  );
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  scene.activeCamera = camera;
  return { engine, scene, camera };
}

it("probes without rendering and preserves the chosen camera through one scene frame", async () => {
  const { scene, camera } = host();
  const other = new FreeCamera("other", Vector3.Zero(), scene);
  const before = vi.fn(() => expect(scene.activeCamera).toBe(camera));
  const after = vi.fn(() => expect(scene.activeCamera).toBe(camera));
  scene.onBeforeRenderObservable.add(before);
  scene.onAfterRenderObservable.add(after);
  const update = vi.spyOn(camera, "update");
  const otherUpdate = vi.spyOn(other, "update");
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(scene.activeCamera).toBe(camera);
  expect(before).not.toHaveBeenCalled();
  expect(after).not.toHaveBeenCalled();
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  expect(update).toHaveBeenCalledTimes(1);
  expect(otherUpdate).not.toHaveBeenCalled();
  expect(before).toHaveBeenCalledTimes(1);
  expect(after).toHaveBeenCalledTimes(1);
  expect(scene.activeCamera).toBe(camera);
  expect(scene.frameGraph).toBeNull();
  expect(scene.customRenderFunction).toBeUndefined();
  graph.dispose();
});

it("preserves native infinite-far sky projection during the main object draw", async () => {
  const { scene, camera } = host();
  camera.maxZ = 100;
  const sky = MeshBuilder.CreateBox("sky", { size: 1000 }, scene);
  sky.ignoreCameraMaxZ = true;
  sky.material = new StandardMaterial("sky", scene);
  sky.material.backFaceCulling = false;
  const projections: number[] = [];
  sky.onBeforeBindObservable.add(() => projections.push(camera.maxZ));
  const graph = new ForwardSceneFrameGraph(scene);
  await graph.prepare(camera);
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  expect(projections).toEqual([0]);
  expect(camera.maxZ).toBe(100);
  expect(scene._intermediateRendering).toBe(false);
  graph.dispose();
});

it("keeps the authored cutout draw order when a FrameGraph owns the rendering manager", async () => {
  const { scene, camera } = host();
  configureCutoutSorting(scene);
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
  texture.hasAlpha = true;
  texture.getInternalTexture()!.isReady = true;
  const material = new StandardMaterial("cutout", scene);
  material.diffuseTexture = texture;
  material.transparencyMode = 1;
  const order: string[] = [];
  for (const [name, index] of [["front", 20], ["back", 10]] as const) {
    const mesh = MeshBuilder.CreatePlane(name, {}, scene);
    mesh.material = material;
    mesh.renderingGroupId = 1;
    mesh.alphaIndex = index;
    mesh.onBeforeBindObservable.add(() => order.push(name));
    await material.forceCompilationAsync(mesh);
  }
  scene.render();
  expect(order).toEqual(["back", "front"]);
  order.length = 0;
  const graph = new ForwardSceneFrameGraph(scene);
  await graph.prepare(camera);
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  expect(order).toEqual(["back", "front"]);
  graph.dispose();
});

it("restores classic ownership after a callback throws and leaves a shared Engine scene usable", async () => {
  const first = host();
  const second = host(first.engine);
  const graph = new ForwardSceneFrameGraph(first.scene);
  await graph.prepare(first.camera);
  const observer = first.scene.onBeforeRenderObservable.add(() => {
    throw new Error("owned callback failed");
  });
  expect(() => graph.render(first.camera)).toThrow("owned callback failed");
  expect(first.scene.activeCamera).toBe(first.camera);
  expect(first.scene.frameGraph).toBeNull();
  first.scene.onBeforeRenderObservable.remove(observer);
  graph.dispose();
  graph.dispose();
  expect(first.scene.frameGraphs).toHaveLength(0);
  expect(() => second.scene.render()).not.toThrow();
  expect(second.scene.activeCamera).toBe(second.camera);
  expect(first.engine.isDisposed).toBe(false);
});

it("rejects foreign and disposed cameras without changing or rendering either scene", async () => {
  const first = host();
  const second = host(first.engine);
  const graph = new ForwardSceneFrameGraph(first.scene);
  await graph.prepare(first.camera);
  const firstFrame = vi.fn();
  const secondFrame = vi.fn();
  first.scene.onBeforeRenderObservable.add(firstFrame);
  second.scene.onBeforeRenderObservable.add(secondFrame);
  const disposed = new FreeCamera("disposed", Vector3.Zero(), first.scene);
  disposed.dispose();
  for (const invalid of [second.camera, disposed]) {
    expect(graph.render(invalid)).toMatchObject({
      path: "classic",
      reason: expect.stringContaining("Camera"),
    });
    expect(await graph.prepare(invalid)).toMatchObject({
      path: "classic",
      reason: expect.stringContaining("Camera"),
    });
  }
  expect(first.scene.activeCamera).toBe(first.camera);
  expect(second.scene.activeCamera).toBe(second.camera);
  expect(firstFrame).not.toHaveBeenCalled();
  expect(secondFrame).not.toHaveBeenCalled();
  graph.dispose();
});

it("restores floating-origin matrices, viewport and shadow flags when object readiness throws", async () => {
  const engine = new NullEngine();
  vi.spyOn(engine, "supportsUniformBuffers", "get").mockReturnValue(true);
  vi.spyOn(engine, "getCreationOptions").mockReturnValue({
    useLargeWorldRendering: true,
  });
  const { scene, camera } = host(engine);
  camera.position.x = 2000;
  scene.render();
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  const ubo = scene.getSceneUniformBuffer();
  const view = Array.from(scene.getViewMatrix().asArray());
  const projection = Array.from(scene.getProjectionMatrix().asArray());
  MeshBuilder.CreateBox("new candidate", {}, scene);
  const light = new PointLight("light", Vector3.Up(), scene);
  scene.objectRenderers[0]!.customIsReadyFunction = () => {
    expect(FloatingOriginCurrentScene.getScene()).toBe(scene);
    expect(scene.getSceneUniformBuffer()).not.toBe(ubo);
    throw new Error("object readiness failed");
  };
  const sibling = host(engine);
  const previousScene = FloatingOriginCurrentScene.getScene;
  FloatingOriginCurrentScene.eyeAtCamera = false;
  const viewport = new Viewport(0.2, 0.1, 0.5, 0.7);
  engine.setViewport(viewport);
  engine.currentRenderPassId = 42;
  expect(await graph.prepare(camera)).toEqual({
    path: "classic",
    reason: "object readiness failed",
  });
  expect(scene.activeCamera).toBe(camera);
  expect(scene.getSceneUniformBuffer()).toBe(ubo);
  expect(Array.from(scene.getViewMatrix().asArray())).toEqual(view);
  expect(Array.from(scene.getProjectionMatrix().asArray())).toEqual(projection);
  expect(engine.currentViewport).toEqual(viewport);
  expect(engine.currentRenderPassId).toBe(42);
  expect(FloatingOriginCurrentScene.getScene).toBe(previousScene);
  expect(FloatingOriginCurrentScene.eyeAtCamera).toBe(false);
  expect(light.shadowEnabled).toBe(true);
  expect(scene.objectRenderers).toHaveLength(0);
  expect(() => sibling.scene.render()).not.toThrow();
  graph.dispose();
});

it("falls back before replacing unmanaged shadows or a shared-view target", async () => {
  const { scene, camera } = host();
  const graph = new ForwardSceneFrameGraph(scene);
  await graph.prepare(camera);
  const light = new PointLight("managed", Vector3.Up(), scene);
  const shadow = new ShadowGenerator(32, light);
  const texture = shadow.getShadowMap();
  expect(graph.render(camera)).toMatchObject({
    path: "classic",
    reason: expect.stringContaining("Unmanaged shadow allocations"),
  });
  expect(light.getShadowGenerator()).toBe(shadow);
  expect(shadow.getShadowMap()).toBe(texture);
  shadow.dispose();
  const target = new RenderTargetTexture("shared view", 32, scene);
  camera.outputRenderTarget = target;
  expect(await graph.prepare(camera)).toMatchObject({
    path: "classic",
    reason: expect.stringContaining("color/depth texture"),
  });
  camera.outputRenderTarget = null;
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  await new Promise<void>((resolve) =>
    scene.freezeActiveMeshes(false, resolve),
  );
  expect(await graph.prepare(camera)).toMatchObject({ path: "classic", reason: expect.stringContaining("Frozen active-mesh queues") });
  expect(graph.render(camera)).toMatchObject({ path: "classic" });
  scene.unfreezeActiveMeshes();
  await new Promise<void>((resolve) =>
    scene.freezeActiveMeshes(false, resolve, undefined, true, true),
  );
  expect(await graph.prepare(camera)).toMatchObject({
    path: "classic",
    reason: expect.stringContaining("Frozen active-mesh queues"),
  });
  scene.unfreezeActiveMeshes();
  graph.dispose();
});

it("preserves the native frozen queue across camera-mask changes before returning to graph culling", async () => {
  const { scene, camera } = host();
  const visible = MeshBuilder.CreateBox("visible", {}, scene);
  visible.layerMask = camera.layerMask = 1;
  const hidden = MeshBuilder.CreateBox("outside frustum", {}, scene);
  hidden.layerMask = 1;
  hidden.position.x = 1000;
  await new Promise<void>((resolve) => scene.freezeActiveMeshes(false, resolve));
  const otherCamera = new FreeCamera("different mask", camera.position.clone(), scene);
  otherCamera.layerMask = 2;
  scene.activeCamera = otherCamera;
  const visibleDraw = vi.spyOn(visible, "render");
  const hiddenDraw = vi.spyOn(hidden, "render");
  scene.render(false);
  expect(visibleDraw).toHaveBeenCalledTimes(1);
  expect(hiddenDraw).not.toHaveBeenCalled();
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(otherCamera)).toMatchObject({ path: "classic" });
  expect(graph.render(otherCamera, false)).toMatchObject({ path: "classic" });
  expect(visibleDraw).toHaveBeenCalledTimes(2);
  expect(hiddenDraw).not.toHaveBeenCalled();
  scene.unfreezeActiveMeshes();
  hidden.position.x = 0;
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.render(camera, false)).toEqual({ path: "frameGraph" });
  expect(hiddenDraw).toHaveBeenCalledTimes(1);
  graph.dispose();
});

it("applies unfreeze from a before-render observer in that same frame", async () => {
  const { scene, camera } = host();
  MeshBuilder.CreateBox("visible", {}, scene);
  const hidden = MeshBuilder.CreateBox("outside frustum", {}, scene);
  hidden.position.x = 1000;
  const graph = new ForwardSceneFrameGraph(scene);
  await graph.prepare(camera);
  await new Promise<void>((resolve) => scene.freezeActiveMeshes(false, resolve));
  const hiddenDraw = vi.spyOn(hidden, "render");
  scene.onBeforeRenderObservable.addOnce(() => {
    scene.unfreezeActiveMeshes();
    hidden.position.x = 0;
  });
  // This frame retains native scene ownership so its observer can rebuild the
  // active queue immediately. The following frame can use graph culling again.
  expect(graph.render(camera, false)).toMatchObject({ path: "classic" });
  expect(hiddenDraw).toHaveBeenCalledTimes(1);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.render(camera, false)).toEqual({ path: "frameGraph" });
  expect(hiddenDraw).toHaveBeenCalledTimes(2);
  graph.dispose();
});

it("disposes task resources after a build failure and can prepare a new graph", async () => {
  const { scene, camera } = host();
  const graph = new ForwardSceneFrameGraph(scene);
  const release = vi.spyOn(FrameGraphObjectRendererTask.prototype, "dispose");
  const record = vi
    .spyOn(FrameGraphObjectRendererTask.prototype, "record")
    .mockImplementationOnce(() => {
      throw new Error("build boundary failure");
    });
  expect(await graph.prepare(camera)).toEqual({
    path: "classic",
    reason: "build boundary failure",
  });
  expect(release).toHaveBeenCalledTimes(1);
  expect(scene.frameGraphs).toHaveLength(0);
  expect(scene.activeCamera).toBe(camera);
  record.mockRestore();
  graph.invalidate();
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  graph.dispose();
  expect(release).toHaveBeenCalledTimes(2);
});

it("settles a pending readiness wait when the scene is disposed", async () => {
  const { scene, camera } = host();
  const graph = new ForwardSceneFrameGraph(scene);
  vi.spyOn(FrameGraphObjectRendererTask.prototype, "isReady").mockReturnValue(
    false,
  );
  const prepare = graph.prepare(camera);
  scene.dispose();
  expect(await prepare).toMatchObject({
    path: "classic",
    reason: expect.stringContaining("disposed"),
  });
  expect(scene.frameGraphs).toHaveLength(0);
});

it("refreshes the resized backbuffer dimensions while retaining the object renderer", async () => {
  const options = new NullEngineOptions();
  options.renderWidth = 80;
  options.renderHeight = 64;
  const { scene, camera } = host(new NullEngine(options));
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  const renderer = scene.objectRenderers[0]!;
  const probe = vi.spyOn(renderer, "isReadyForRendering");
  // NullEngine owns no canvas; its options are the actual backbuffer boundary.
  options.renderWidth = 96;
  options.renderHeight = 72;
  expect(graph.render(camera)).toMatchObject({
    path: "classic",
    reason: expect.stringContaining("preparation"),
  });
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(probe).toHaveBeenLastCalledWith(96, 72);
  expect(scene.objectRenderers).toEqual([renderer]);
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  graph.dispose();
});

it("skips strict readiness probes on unchanged frames after admission", async () => {
  const { scene, camera } = host();
  MeshBuilder.CreateBox("box", {}, scene);
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  const checks = graph.strictReadinessChecks;
  for (let frame = 0; frame < 20; frame += 1)
    expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  expect(graph.strictReadinessChecks).toBe(checks);
  graph.dispose();
});

it("skips strict readiness probes on unchanged frames in CEL mode", async () => {
  const { scene, camera } = host();
  const mesh = MeshBuilder.CreateBox("box", {}, scene);
  mesh.material = new StandardMaterial("pbr", scene);
  setSceneRenderSettings(scene, { mode: "cel" });
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  // The CEL-wrapped material may need an asynchronous first compile before
  // the strict probe admits the scene and caches.
  await vi.waitFor(() => {
    expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  });
  const checks = graph.strictReadinessChecks;
  for (let frame = 0; frame < 20; frame += 1)
    expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  expect(graph.strictReadinessChecks).toBe(checks);
  graph.dispose();
});

it("re-probes strict readiness exactly once after each invalidating change", async () => {
  const { scene, camera } = host();
  const mesh = MeshBuilder.CreateBox("box", {}, scene);
  const light = new PointLight("light", Vector3.Up(), scene);
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  const expectOneCheck = async (mutate: () => void) => {
    const before = graph.strictReadinessChecks;
    mutate();
    // A changed material/light variant may compile asynchronously. While the
    // strict probe reports unready each render runs exactly one probe and
    // falls back; the first ready frame re-admits and caches again.
    let frames = 0;
    let probes = 0;
    await vi.waitFor(() => {
      const checks = graph.strictReadinessChecks;
      expect(graph.render(camera)).toEqual({ path: "frameGraph" });
      probes += graph.strictReadinessChecks - checks;
      frames += 1;
    });
    expect(probes).toBe(frames);
    expect(probes).toBeGreaterThan(0);
    expect(graph.strictReadinessChecks).toBeGreaterThan(before);
    const admitted = graph.strictReadinessChecks;
    expect(graph.render(camera)).toEqual({ path: "frameGraph" });
    expect(graph.strictReadinessChecks).toBe(admitted);
  };
  await expectOneCheck(() => {
    MeshBuilder.CreateBox("added", {}, scene);
  });
  await expectOneCheck(() => {
    mesh.material = new StandardMaterial("replacement", scene);
  });
  await expectOneCheck(() => light.setEnabled(false));
  await expectOneCheck(() => graph.invalidate());
  graph.dispose();
});

it("keeps probing every frame while unready, then caches once admitted", async () => {
  const { scene, camera } = host();
  const mesh = MeshBuilder.CreateBox("box", {}, scene);
  const material = new StandardMaterial("stubbed", scene);
  mesh.material = material;
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  const probe = vi.spyOn(material, "isReadyForSubMesh").mockReturnValue(false);
  graph.invalidate();
  const before = graph.strictReadinessChecks;
  for (let frame = 0; frame < 3; frame += 1)
    expect(graph.render(camera)).toMatchObject({ path: "classic" });
  expect(graph.strictReadinessChecks).toBe(before + 3);
  probe.mockRestore();
  // The restored probe may compile asynchronously; fall back until it passes.
  await vi.waitFor(() => {
    expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  });
  const admitted = graph.strictReadinessChecks;
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  expect(graph.strictReadinessChecks).toBe(admitted);
  graph.dispose();
});
