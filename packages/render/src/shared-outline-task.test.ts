import { afterEach, expect, it, vi } from "vitest";
import { Constants } from "@babylonjs/core/Engines/constants";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { managedRenderReservations } from "./managed-render-resources";
import { SharedOutlineOwner } from "./shared-outline";
import { FrameGraphSharedOutlineTask } from "./shared-outline-task";
import { setOutlineContribution } from "./test-support/shared-outline-contributions";

const disposers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

/** A 16 × 8 graph holding only a shared outline task, outlining one box; `sceneDepth`: a scene depth texture of that size for it to read. */
async function outlineGraph(sceneDepth?: { width: number; height: number }) {
  const engine = adaptNullEngineFrameGraph(new NullEngine());
  Object.assign(engine.getCaps(), { maxDrawBuffers: 4, drawBuffersExtension: true, textureFloatRender: true, textureHalfFloatRender: true, blendFloat: true });
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  scene.activeCamera = camera;
  const member = MeshBuilder.CreateBox("member", {}, scene);
  const graph = new FrameGraph(scene);
  const view = SharedOutlineOwner.forScene(scene).createView("test");
  disposers.push(() => { view.dispose(); graph.dispose(); scene.dispose(); engine.dispose(); });
  setOutlineContribution(view, "component", { kind: "component", color: [1, 0, 0], width: 2, targets: [{ key: "member", meshes: [member] }] });
  expect(view.groupActive("strict")).toBe(true);
  const task = new FrameGraphSharedOutlineTask("Outlines", graph, view);
  task.camera = camera;
  task.targetTexture = graph.textureManager.createRenderTargetTexture("scene color", {
    size: { width: 16, height: 8 }, sizeIsPercentage: false,
    options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_UNSIGNED_BYTE], formats: [Constants.TEXTUREFORMAT_RGBA], useSRGBBuffers: [false] },
  });
  if (sceneDepth) task.sceneDepthTexture = graph.textureManager.createRenderTargetTexture("scene depth", {
    size: sceneDepth, sizeIsPercentage: false,
    options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_FLOAT], formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT], useSRGBBuffers: [false] },
  });
  graph.addTask(task);
  await graph.buildAsync(false);
  return { engine, scene, camera, view, task };
}

it("gives the through and selection masks one depth target, since the compose samples only the strict group's", async () => {
  const { engine, task } = await outlineGraph();
  task.reconcileResources();
  // Two DEPTH32F targets of 16 × 8 texels for the three groups: the strict group's and one the other two draw into in turn.
  expect(managedRenderReservations(engine).categoryBytes.depth).toBe(2 * 16 * 8 * 4);
});

it("draws every strict occluder in a frame without view culling, and only those that can affect it otherwise", async () => {
  const { scene, view, task } = await outlineGraph();
  const narrowed = vi.spyOn(view, "strictOccludersFor");
  // A steady frame narrows the strict occluders to those near a member on screen.
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(narrowed).toHaveBeenCalledTimes(1);
  // Play's starting-state draw (`skipFrustumClipping`) draws the full list, so each occluder's program draws there.
  scene.skipFrustumClipping = true;
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(narrowed).toHaveBeenCalledTimes(1);
});

it("seeds the strict mask from a scene depth of its own size: one depth copy, and only the meshes that depth lacks", async () => {
  const own = await outlineGraph();
  // The compose and the strict mask; a clear and a draw per mask.
  expect([own.task.drawingPassCount, own.task.renderRecordCount]).toEqual([2, 3]);
  const { scene, camera, view, task } = await outlineGraph({ width: 16, height: 8 });
  expect([task.drawingPassCount, task.renderRecordCount]).toEqual([3, 4]);
  const narrowed = vi.spyOn(view, "strictOccludersFor"), listed = vi.spyOn(view, "meshesForGroup");
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(narrowed).toHaveBeenLastCalledWith(camera, 16, 8, true);
  // The frame without view culling, and readiness, take the whole list the same way.
  scene.skipFrustumClipping = true;
  listed.mockClear();
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(listed).toHaveBeenCalledWith("strict", true);
  // With no strict outline left there is nothing to seed.
  setOutlineContribution(view, "component", { kind: "component", color: [1, 0, 0], width: 2, targets: [] });
  expect([task.drawingPassCount, task.renderRecordCount]).toEqual([0, 0]);
});

it("keeps drawing its own occluders when the scene depth is not the mask's pixels", async () => {
  // An authored chain at half resolution: its depth is another size than the outline's target.
  const { camera, view, task } = await outlineGraph({ width: 8, height: 4 });
  expect([task.drawingPassCount, task.renderRecordCount]).toEqual([2, 3]);
  const narrowed = vi.spyOn(view, "strictOccludersFor");
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(narrowed).toHaveBeenLastCalledWith(camera, 16, 8, false);
});

it("waits for the depth copy's program only where the strict mask is seeded", async () => {
  const pending = (task: FrameGraphSharedOutlineTask) =>
    vi.spyOn((task as unknown as { seed: { isReady(): boolean } }).seed, "isReady").mockReturnValue(false);
  const seeded = await outlineGraph({ width: 16, height: 8 });
  expect(seeded.task.isReady()).toBe(true);
  const compiling = pending(seeded.task);
  expect(seeded.task.isReady()).toBe(false);
  compiling.mockRestore();
  expect(seeded.task.isReady()).toBe(true);
  // A mask that draws its own occluders never draws the copy.
  const own = await outlineGraph();
  pending(own.task);
  expect(own.task.isReady()).toBe(true);
});

