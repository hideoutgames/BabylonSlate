import { afterEach, expect, it, vi } from "vitest";
import { Constants, FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { SharedOutlineOwner } from "./shared-outline";
import { FrameGraphSharedOutlineTask } from "./shared-outline-task";

const disposers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

it("draws every strict occluder in a frame without view culling, and only those that can affect it otherwise", async () => {
  const engine = adaptNullEngineFrameGraph(new NullEngine());
  Object.assign(engine.getCaps(), { maxDrawBuffers: 4, drawBuffersExtension: true, textureFloatRender: true, textureHalfFloatRender: true, blendFloat: true });
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  scene.activeCamera = camera;
  const member = MeshBuilder.CreateBox("member", {}, scene);
  const graph = new FrameGraph(scene);
  const view = SharedOutlineOwner.forScene(scene).createView("test");
  disposers.push(() => { view.dispose(); graph.dispose(); scene.dispose(); engine.dispose(); });
  view.setContribution("component", { kind: "component", color: [1, 0, 0], width: 2, targets: [{ key: "member", meshes: [member] }] });
  expect(view.groupActive("strict")).toBe(true);
  const task = new FrameGraphSharedOutlineTask("Outlines", graph, view);
  task.camera = camera;
  task.targetTexture = graph.textureManager.createRenderTargetTexture("scene color", {
    size: { width: 16, height: 8 }, sizeIsPercentage: false,
    options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_UNSIGNED_BYTE], formats: [Constants.TEXTUREFORMAT_RGBA], useSRGBBuffers: [false] },
  });
  graph.addTask(task);
  await graph.buildAsync(false);
  const narrowed = vi.spyOn(view, "strictOccludersFor");
  // A steady frame narrows the strict occluders to those near a member on screen.
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(narrowed).toHaveBeenCalledTimes(1);
  // Play's starting-state draw (`skipFrustumClipping`) draws the full list, so each occluder's program draws there.
  scene.skipFrustumClipping = true;
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(narrowed).toHaveBeenCalledTimes(1);
});
