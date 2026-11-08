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

/** A 16 × 8 graph holding only a shared outline task, outlining one box. */
async function outlineGraph() {
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
  graph.addTask(task);
  await graph.buildAsync(false);
  return { engine, scene, view, task };
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
