import {
  FreeCamera,
  NullEngine,
  PointLight,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  Vector3,
} from "@babylonjs/core";
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

it("falls back before replacing managed shadows or a shared-view target", async () => {
  const { scene, camera } = host();
  const graph = new ForwardSceneFrameGraph(scene);
  await graph.prepare(camera);
  const light = new PointLight("managed", Vector3.Up(), scene);
  const shadow = new ShadowGenerator(32, light);
  const texture = shadow.getShadowMap();
  expect(graph.render(camera)).toMatchObject({
    path: "classic",
    reason: expect.stringContaining("Managed shadows"),
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
