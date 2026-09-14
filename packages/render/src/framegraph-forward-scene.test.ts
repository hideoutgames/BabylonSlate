import {
  FreeCamera,
  MeshBuilder,
  NullEngine,
  NullEngineOptions,
  PointLight,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  Vector3,
  Viewport,
} from "@babylonjs/core";
import { FloatingOriginCurrentScene } from "@babylonjs/core/Materials/floatingOriginMatrixOverrides";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { afterEach, expect, it, vi } from "vitest";
import { ForwardSceneFrameGraph } from "./framegraph-forward-scene";

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
    reason: expect.stringContaining("Render-target views"),
  });
  camera.outputRenderTarget = null;
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  await new Promise<void>((resolve) =>
    scene.freezeActiveMeshes(false, resolve),
  );
  expect(await graph.prepare(camera)).toMatchObject({
    path: "classic",
    reason: expect.stringContaining("Frozen active-mesh lists"),
  });
  scene.unfreezeActiveMeshes();
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
