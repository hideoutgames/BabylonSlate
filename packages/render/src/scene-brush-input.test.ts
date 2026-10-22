import { afterEach, expect, it, vi } from "vitest";
import { ArcRotateCamera, Matrix, Vector3, VertexBuffer } from "@babylonjs/core";
import { createActor, createDefaultScene, parseLandscapeProperties, type SerializedScene, type SerializedTransform } from "@haptic/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { attachSceneBrushInput, type SceneBrushState } from "./scene-brush-input";
import type { EngineHandle } from "./create-engine";
import { RenderScheduler } from "./render-scheduler";

class Canvas extends EventTarget {
  captures = new Set<number>();
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) { this.captures.delete(id); }
  pointer(type: string, x: number, y: number, pointerType = "mouse", pointerId = 1) {
    this.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, pointerType, pointerId, button: 0 }));
  }
}
const dispose: Array<() => void> = [];
afterEach(() => { while (dispose.length) dispose.pop()!(); vi.unstubAllGlobals(); });

function fixture(mode: "landscape" | "foliage" = "landscape", options: { transform?: SerializedTransform; strength?: number; heights?: number[] } = {}) {
  const { scene, engine } = createTestEngine();
  const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 4, 35, Vector3.Zero(), scene);
  scene.activeCamera = camera;
  const sync = new EditorSceneSync(scene);
  const initial: SerializedScene = { ...createDefaultScene(), actors: [createActor("land", "Land", { ...(options.transform ? { transform: options.transform } : {}), components: [{ id: "surface", classId: "LandscapeComponent", properties: { ...parseLandscapeProperties({ width: 32, depth: 32, subdivisions: 32, heights: options.heights }) } }] })] };
  sync.apply(initial); scene.render();
  const canvas = new Canvas(); const windowTarget = new EventTarget(); vi.stubGlobal("window", windowTarget);
  const state: SceneBrushState = {
    scene: initial, mode, enabled: true, landscapeSelection: "land/surface", landscapeTool: "raise",
    landscapeBrush: { tool: "raise", radius: 4, strength: options.strength ?? 1, falloff: 0.5, height: 0, layer: 0 },
    foliageTool: "paint", foliageBrush: { radius: 3, density: 1, spacing: 0.5, maxSlope: 60, alignToNormal: true, randomYaw: true },
    group: { id: "trees", name: "Trees", models: ["oak", "pine"].map((modelGuid) => ({ modelGuid, materialGuid: null, weight: 1, minScale: 1, maxScale: 1 })) },
  };
  const committed: SerializedScene[] = [];
  let seed = 1;
  const detach = attachSceneBrushInput({ scene, editor: { sync }, scheduler: new RenderScheduler() } as unknown as EngineHandle, canvas as unknown as HTMLCanvasElement, {
    getState: () => state,
    commit: async (next) => { committed.push(next); state.scene = next; sync.apply(next); return true; },
    random: () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 0x100000000),
  });
  dispose.push(() => { detach(); sync.dispose(); scene.dispose(); engine.dispose(); });
  const pointer = (type: string, x = 0, z = 0, pointerType = "mouse", id = 1) => {
    const p = Vector3.Project(new Vector3(x, 0, z), Matrix.Identity(), scene.getTransformMatrix(), camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()));
    canvas.pointer(type, p.x, p.y, pointerType, id);
  };
  const centerHeight = () => sync.meshForComponent("land", "surface")!.getChildMeshes()[0]!.getVerticesData(VertexBuffer.PositionKind)![(16 * 33 + 16) * 3 + 1];
  return { scene, initial, state, committed, sync, canvas, windowTarget, pointer, centerHeight };
}

it.each(["mouse", "touch", "pen"])("commits one undoable landscape stroke for %s, preserving the document until release", async (pointerType) => {
  const f = fixture();
  f.pointer("pointerdown", 0, 0, pointerType);
  f.pointer("pointermove", 2, 0, pointerType);
  expect(f.state.scene).toBe(f.initial);
  expect(f.centerHeight()).toBeGreaterThan(0);
  f.pointer("pointerup", 2, 0, pointerType);
  await Promise.resolve();
  expect(f.committed).toHaveLength(1);
  expect(parseLandscapeProperties(f.committed[0]!.actors[0]!.components[0]!.properties).heights.some((height) => height > 0)).toBe(true);
  f.sync.apply(f.initial);
  expect(f.centerHeight()).toBe(0);
  expect(f.canvas.captures.size).toBe(0);
});

it("applies the scene once per pointer event however many dabs a drag interpolates, and commits the scene it showed", async () => {
  const f = fixture();
  const apply = vi.spyOn(f.sync, "apply");
  f.pointer("pointerdown", -6, 0);
  expect(apply).toHaveBeenCalledTimes(1);
  apply.mockClear();
  f.pointer("pointermove", 6, 0); // 12 units at a 0.8 spacing interpolates 15 dabs
  expect(apply).toHaveBeenCalledTimes(1);
  const shown = apply.mock.calls[0]![0];
  expect(f.centerHeight()).toBeGreaterThan(0);
  f.pointer("pointerup", 6, 0);
  await Promise.resolve();
  expect(f.committed).toHaveLength(1);
  expect(f.committed[0]).toBe(shown);
});

it("shows a footprint ring of the brush radius that follows the surface under the pointer", () => {
  // Flat ground with a 2-unit plateau from x = 1; the ring around (-2, 0) reaches onto it.
  const f = fixture("landscape", { heights: Array.from({ length: 33 * 33 }, (_, i) => i % 33 >= 17 ? 2 : 0) });
  f.pointer("pointermove", -2, 0);
  const positions = f.scene.getMeshByName("sceneBrushPreview")!.getVerticesData(VertexBuffer.PositionKind)!;
  const outer = Array.from({ length: 49 }, (_, i) => ({ x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! }));
  expect(outer.every(({ x, z }) => Math.abs(Math.hypot(x + 2, z) - 4) < 0.02)).toBe(true);
  const ground = outer.filter(({ x }) => x < -0.5);
  const plateau = outer.filter(({ x }) => x > 1.5);
  expect(ground.length).toBeGreaterThan(20);
  expect(plateau.length).toBeGreaterThan(4);
  expect(ground.every(({ y }) => Math.abs(y - 0.03) < 0.02)).toBe(true);
  expect(plateau.every(({ y }) => Math.abs(y - 2.03) < 0.02)).toBe(true);
});

/** The 33 x 33 vertex grid of the fixture landscape, one local unit apart, under an actor moved to (6, -3) and scaled 2x on X/Z. */
const SCALED: SerializedTransform = { position: [6, 0, -3], rotation: [0, 0, 0, 1], scale: [2, 1, 2] };
const worldOfVertex = (index: number) => ({ x: 6 + 2 * (index % 33 - 16), z: -3 + 2 * (Math.floor(index / 33) - 16) });
const heightsOf = (scene: SerializedScene) => parseLandscapeProperties(scene.actors[0]!.components[0]!.properties).heights;

it("sculpts a moved and scaled landscape under the pointer, with the brush radius in world units", async () => {
  const f = fixture("landscape", { transform: SCALED });
  f.pointer("pointerdown", 10, 0); f.pointer("pointerup", 10, 0);
  await Promise.resolve();
  const raised = heightsOf(f.committed[0]!).flatMap((height, index) => height > 0 ? [index] : []);
  // Radius 4 around the world point (10, 0); no vertex sits near the edge of that disc.
  const inside = Array.from({ length: 33 * 33 }, (_, index) => index).filter((index) => {
    const { x, z } = worldOfVertex(index);
    return Math.hypot(x - 10, z) < 4;
  });
  expect(inside.length).toBeGreaterThan(3);
  expect(raised).toEqual(inside);
});

it("sculpts the whole path of a drag across a moved and scaled landscape", async () => {
  const f = fixture("landscape", { transform: SCALED, strength: 0.01 });
  f.pointer("pointerdown", -2, 2); f.pointer("pointermove", 14, 2); f.pointer("pointerup", 14, 2);
  await Promise.resolve();
  const heights = heightsOf(f.committed[0]!);
  const toPath = (index: number) => { const { x, z } = worldOfVertex(index); return Math.hypot(x - Math.min(14, Math.max(-2, x)), z - 2); };
  const indices = heights.map((_, index) => index);
  const near = indices.filter((index) => toPath(index) < 3.6);
  const far = indices.filter((index) => toPath(index) > 4.25);
  expect(near.length).toBeGreaterThan(30);
  expect(near.every((index) => heights[index]! > 0)).toBe(true);
  expect(far.every((index) => heights[index] === 0)).toBe(true);
});

it.each(["pointercancel", "second-touch", "escape"])("restores the landscape without a history entry on %s", (reason) => {
  const f = fixture();
  f.pointer("pointerdown", 0, 0, "touch");
  expect(f.centerHeight()).toBeGreaterThan(0);
  if (reason === "second-touch") f.pointer("pointerdown", 1, 0, "touch", 2);
  else if (reason === "escape") f.windowTarget.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
  else f.pointer("pointercancel", 0, 0, "touch");
  expect(f.committed).toEqual([]);
  expect(f.centerHeight()).toBe(0);
});

it("paints mixed Models as one component per stroke and erases them together with undo", async () => {
  const f = fixture("foliage");
  f.pointer("pointerdown"); f.pointer("pointermove", 3); f.pointer("pointerup", 3);
  await Promise.resolve();
  const painted = f.state.scene!;
  expect(painted.actors).toHaveLength(2);
  const components = painted.actors[1]!.components;
  expect(components).toHaveLength(1);
  expect(components[0]!.classId).toBe("FoliageComponent");
  expect((components[0]!.properties.batches as Array<{ modelGuid: string }>).map((batch) => batch.modelGuid).sort()).toEqual(["oak", "pine"]);
  await Promise.resolve(); await Promise.resolve();
  f.state.foliageTool = "erase"; f.state.foliageBrush.radius = 10;
  f.pointer("pointerdown"); f.pointer("pointerup");
  await Promise.resolve();
  expect(f.committed).toHaveLength(2);
  expect(f.state.scene!.actors).toHaveLength(1);
  f.state.scene = painted; f.sync.apply(painted);
  expect(f.sync.meshForComponent(painted.actors[1]!.id, components[0]!.id)).not.toBeNull();
});

type Instance = { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] };
const instanceAt = (x: number, z: number): Instance => ({ position: [x, 0, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const foliageActor = (id: string, parentId: string | null, batches: Array<{ modelGuid: string; transforms: Instance[] }>) => createActor(id, id, {
  parentId, components: [{ id: `${id}-foliage`, classId: "FoliageComponent", properties: { groupId: "trees", batches: batches.map((batch) => ({ ...batch, materialGuid: null })) } }],
});
/** Replaces the fixture scene with the landscape plus these actors, as an applied, committed document. */
function populate(f: ReturnType<typeof fixture>, actors: ReturnType<typeof foliageActor>[]) {
  const scene = { ...f.initial, actors: [...f.initial.actors, ...actors] };
  f.state.scene = scene; f.sync.apply(scene);
  for (const actor of actors) expect(f.sync.meshForComponent(actor.id, actor.components[0]!.id)).not.toBeNull();
  return scene;
}

it("erases the instances along a drag, keeping the rest of each batch and dropping emptied batches", async () => {
  const f = fixture("foliage");
  const oak = Array.from({ length: 25 * 13 }, (_, i) => instanceAt(-6 + (i % 25) * 0.5, -3 + Math.floor(i / 25) * 0.5));
  // Every pine stands within the swept corridor, so its whole batch goes.
  const pine = [instanceAt(1, 0.25), instanceAt(0.5, -0.5), instanceAt(-2, 0.5), instanceAt(2.5, 0.25), instanceAt(0, 1)];
  populate(f, [foliageActor("grove", null, [{ modelGuid: "oak", transforms: oak }, { modelGuid: "pine", transforms: pine }])]);
  f.state.foliageTool = "erase"; f.state.foliageBrush.radius = 2;
  // 6.2 units at a 0.4 spacing: dabs at -3, -2.6 ... 3 (15 interpolated), the last 0.2 short of the pointer.
  f.pointer("pointerdown", -3, 0); f.pointer("pointermove", 3.2, 0); f.pointer("pointerup", 3.2, 0);
  await Promise.resolve();
  expect(f.committed).toHaveLength(1);
  const erased = f.committed[0]!;
  expect(erased.actors.map((actor) => actor.id)).toEqual(["land", "grove"]);
  const properties = erased.actors[1]!.components[0]!.properties as { groupId: string; batches: Array<{ modelGuid: string; materialGuid: null; transforms: Instance[] }> };
  expect(properties.groupId).toBe("trees");
  expect(properties.batches.map((batch) => batch.modelGuid)).toEqual(["oak"]);
  // Distance to the swept segment from (-3, 0) to (3, 0), where dabs of radius 2 fall every 0.4.
  const toPath = ([x, , z]: Instance["position"]) => Math.hypot(x - Math.min(3, Math.max(-3, x)), z);
  const survivors = properties.batches[0]!.transforms;
  const kept = new Set(survivors.map((instance) => instance.position.join()));
  expect(oak.filter((instance) => toPath(instance.position) > 2.01).every((instance) => kept.has(instance.position.join()))).toBe(true);
  expect(survivors.every((instance) => toPath(instance.position) > 1.8)).toBe(true);
  expect(survivors.length).toBeGreaterThan(100);
  expect(survivors.length).toBeLessThan(oak.length);
  const order = survivors.map((instance) => oak.findIndex((original) => original.position.join() === instance.position.join()));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(survivors.every((instance, i) => JSON.stringify(instance) === JSON.stringify(oak[order[i]!]))).toBe(true);
});

it("removes an emptied parent only once its own children are gone, keeping it while a child still existed", async () => {
  const f = fixture("foliage");
  // Child at -4 is emptied by the stroke's first dab, the parent at +4 by a later one: by then the child is gone, so the parent goes too.
  populate(f, [foliageActor("parent", null, [{ modelGuid: "oak", transforms: [instanceAt(4, 0), instanceAt(4.5, 0.5)] }]),
    foliageActor("child", "parent", [{ modelGuid: "oak", transforms: [instanceAt(-4, 0), instanceAt(-4.5, -0.5)] }])]);
  f.state.foliageTool = "erase"; f.state.foliageBrush.radius = 1.5;
  f.pointer("pointerdown", -4, 0); f.pointer("pointermove", 4.5, 0); f.pointer("pointerup", 4.5, 0);
  await Promise.resolve();
  expect(f.committed).toHaveLength(1);
  expect(f.committed[0]!.actors.map((actor) => actor.id)).toEqual(["land"]);
});

it("keeps an emptied parent as an empty actor when its child was emptied in the same dab", async () => {
  const f = fixture("foliage");
  populate(f, [foliageActor("parent", null, [{ modelGuid: "oak", transforms: [instanceAt(0, 0), instanceAt(0.5, 0)] }]),
    foliageActor("child", "parent", [{ modelGuid: "oak", transforms: [instanceAt(0, 0.5), instanceAt(-0.5, 0)] }])]);
  f.state.foliageTool = "erase"; f.state.foliageBrush.radius = 1.5;
  f.pointer("pointerdown", 0, 0); f.pointer("pointermove", 0.5, 0); f.pointer("pointerup", 0.5, 0);
  await Promise.resolve();
  const [result] = f.committed;
  expect(f.committed).toHaveLength(1);
  expect(result!.actors.map((actor) => actor.id)).toEqual(["land", "parent"]);
  expect(result!.actors[1]!.components).toEqual([]);
});
