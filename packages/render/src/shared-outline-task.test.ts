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
import { SHARED_OUTLINE_COMPOSE_SHADER } from "./shared-outline-shaders";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { removeOutlineContribution, setOutlineContribution } from "./test-support/shared-outline-contributions";

const disposers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

/**
 * A 16 × 8 graph holding only a shared outline task, outlining one box with an Outline component; `sceneDepth`: a scene
 * depth texture of that size for it to read; `others`: the through and selection groups also outline a box each as
 * the task is built; `externalCompose`: another pass composites the stroke.
 */
async function outlineGraph(sceneDepth?: { width: number; height: number }, others = false, externalCompose = false) {
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
  if (others) {
    setOutlineContribution(view, "through", { kind: "component", color: [0, 1, 0], width: 2, throughMeshes: true,
      targets: [{ key: "through", meshes: [MeshBuilder.CreateBox("through", {}, scene)] }] });
    setOutlineContribution(view, "selection", { kind: "selection", color: [1, 1, 0], width: 2,
      targets: [{ key: "selected", meshes: [MeshBuilder.CreateBox("selected", {}, scene)] }] });
  }
  const task = new FrameGraphSharedOutlineTask("Outlines", graph, view, { externalCompose });
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
  const { engine, task } = await outlineGraph(undefined, true);
  // Reserved: an RGBA8 mask and a DEPTH32F target of 16 × 8 texels for each of the three groups, at most.
  expect(managedRenderReservations(engine).pendingBytes).toBe(3 * 16 * 8 * 8);
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

it("creates targets and passes only for the groups active as it is built, and reports a group activated later", async () => {
  // A game's view: an Outline component's strict group only, never a selection.
  const { engine, scene, view, task } = await outlineGraph();
  expect(task.groups).toEqual(["strict"]);
  expect(managedRenderReservations(engine).pendingBytes).toBe(16 * 8 * 8);
  task.reconcileResources();
  // One RGBA8 mask and one DEPTH32F target of 16 × 8 texels.
  expect(managedRenderReservations(engine).categoryBytes.depth).toBe(16 * 8 * 4);
  expect(task.coversActiveGroups()).toBe(true);
  // A selection the task has no targets for: the graph must be built again, and until then the compose reads it as inactive.
  setOutlineContribution(view, "selection", { kind: "selection", color: [1, 1, 0], width: 2, targets: [{ key: "member", meshes: [scene.getMeshByName("member")!] }] });
  expect(view.groupActive("selection")).toBe(true);
  expect(task.coversActiveGroups()).toBe(false);
  expect([task.drawingPassCount, task.renderRecordCount]).toEqual([2, 3]);
  // A group that deactivates keeps its targets until the next build, so toggling it costs no rebuild.
  removeOutlineContribution(view, "selection");
  expect(task.coversActiveGroups()).toBe(true);
  const both = await outlineGraph(undefined, true);
  removeOutlineContribution(both.view, "selection");
  expect(both.task.groups).toEqual(["strict", "through", "selection"]);
  expect(both.task.coversActiveGroups()).toBe(true);
  expect([both.task.drawingPassCount, both.task.renderRecordCount]).toEqual([3, 5]);
});

it("draws a through group's members that can show in a steady frame, and all of them in a frame without view culling", async () => {
  const { scene, view, task } = await outlineGraph(undefined, true);
  const through = scene.getMeshByName("through")!;
  expect(view.groupActive("through")).toBe(true);
  const list = () => (task as unknown as { masks: { group: string; objects: { objectList: { meshes: unknown[] } } }[] }).masks
    .find((record) => record.group === "through")!.objects.objectList.meshes.length;
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(list()).toBe(1);
  // Far beside the view: nothing of it, or of its stroke, can show.
  through.position.x = 100; through.computeWorldMatrix(true);
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(list()).toBe(0);
  // Readiness and the frame without view culling keep the whole group, so its program is ready and drawn ahead.
  expect(view.meshesForGroup("through")).toHaveLength(1);
  scene.skipFrustumClipping = true;
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(list()).toBe(1);
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

it("draws none of its passes in a frame where no outlined member can show, and all of them otherwise", async () => {
  const { scene, task } = await outlineGraph({ width: 16, height: 8 });
  const internals = task as unknown as {
    masks: { group: string; clearPass?: { disabled: boolean }; seedPass?: { disabled: boolean }; drawPass?: { disabled: boolean } }[];
    composePass?: { disabled: boolean };
  };
  /** Which passes run: the strict group's clear, depth copy and mask, then the compose. */
  const running = () => {
    const strict = internals.masks.find((record) => record.group === "strict")!;
    return [strict.clearPass, strict.seedPass, strict.drawPass, internals.composePass].map((pass) => !pass!.disabled);
  };
  const member = scene.getMeshByName("member")!;
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(running()).toEqual([true, true, true, true]);
  // Far beside the view: no mask would hold an identity, so the compose would blend nothing.
  member.position.x = 100; member.computeWorldMatrix(true);
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(running()).toEqual([false, false, false, false]);
  // The frame without view culling draws everything, and so does a frame with the member back in view.
  scene.skipFrustumClipping = true;
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(running()).toEqual([true, true, true, true]);
  scene.skipFrustumClipping = false;
  member.position.x = 0; member.computeWorldMatrix(true);
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(running()).toEqual([true, true, true, true]);
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


it("composed externally, records only the masks and binds the stroke for the composing pass, idle where no stroke can show", async () => {
  const createEffect = vi.spyOn(NullEngine.prototype, "createEffect");
  const { scene, task } = await outlineGraph({ width: 16, height: 8 }, false, true);
  // The strict group's clear, depth copy and mask: no composition pass and no composition program.
  expect(task.passes.map((pass) => pass.name)).toEqual(["Outlines strict Clear", "Outlines strict Depth Seed", "Outlines strict Mask"]);
  expect(createEffect.mock.calls.map(([path]) => (path as { fragment?: string }).fragment)).not.toContain(SHARED_OUTLINE_COMPOSE_SHADER);
  expect([task.drawingPassCount, task.renderRecordCount]).toEqual([2, 3]);
  expect(task.isReady()).toBe(true);
  // What the composing pass declares and samples: the mask and the strict depth.
  expect(task.strokeTextures).toHaveLength(2);
  const sampling: number[] = [];
  const bound: string[] = [];
  const context = {
    setTextureSamplingMode: (_: unknown, mode: number) => sampling.push(mode),
    bindTextureHandle: (_: unknown, name: string) => bound.push(name),
  } as unknown as FrameGraphRenderContext;
  task.setStrokeSampling(context);
  expect(sampling).toEqual([Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURE_NEAREST_SAMPLINGMODE]);
  const groups: number[][] = [];
  const textures: string[] = [];
  const effect = {
    setFloat: () => {}, setFloat2: () => {}, setMatrix: () => {},
    setFloat3: (name: string, ...values: number[]) => { if (name === "activeGroups") groups.push(values); },
    setTexture: (name: string) => textures.push(name),
  } as unknown as Effect;
  const member = scene.getMeshByName("member")!;
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(task.strokesShow).toBe(true);
  task.bindStroke(context, effect);
  // The strict group reads its own mask and depth; the groups without targets read their style tables, never a target.
  expect(groups.at(-1)).toEqual([1, 0, 0]);
  expect(bound).toEqual(["strictMask", "strictDepth"]);
  expect(textures).toEqual(["strictStyle", "throughMask", "throughStyle", "selectionMask", "selectionStyle"]);
  // Far beside the view: the masks are not drawn, and the pass reads none of them (every group inactive).
  member.position.x = 100; member.computeWorldMatrix(true);
  task.onBeforeTaskExecute.notifyObservers(task);
  expect(task.strokesShow).toBe(false);
  expect(task.passes.every((pass) => pass.disabled)).toBe(true);
  task.bindStroke(context, effect);
  expect(groups.at(-1)).toEqual([0, 0, 0]);
  // Back in view, with no rebuild and no new program.
  member.position.x = 0; member.computeWorldMatrix(true);
  task.onBeforeTaskExecute.notifyObservers(task);
  task.bindStroke(context, effect);
  expect(groups.at(-1)).toEqual([1, 0, 0]);
  expect(createEffect.mock.calls.map(([path]) => (path as { fragment?: string }).fragment)).not.toContain(SHARED_OUTLINE_COMPOSE_SHADER);
});
