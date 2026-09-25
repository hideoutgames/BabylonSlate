import { afterEach, expect, it, vi } from "vitest";
import { ArcRotateCamera, Matrix, Vector3, VertexBuffer } from "@babylonjs/core";
import { createActor, createDefaultScene, parseLandscapeProperties, type SerializedScene } from "@babylonslate/core";
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

function fixture(mode: "landscape" | "foliage" = "landscape") {
  const { scene, engine } = createTestEngine();
  const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 4, 35, Vector3.Zero(), scene);
  scene.activeCamera = camera;
  const sync = new EditorSceneSync(scene);
  const initial: SerializedScene = { ...createDefaultScene(), actors: [createActor("land", "Land", { components: [{ id: "surface", classId: "LandscapeComponent", properties: { ...parseLandscapeProperties({ width: 32, depth: 32, subdivisions: 32 }) } }] })] };
  sync.apply(initial); scene.render();
  const canvas = new Canvas(); const windowTarget = new EventTarget(); vi.stubGlobal("window", windowTarget);
  const state: SceneBrushState = {
    scene: initial, mode, enabled: true, landscapeSelection: "land/surface", landscapeTool: "raise",
    landscapeBrush: { tool: "raise", radius: 4, strength: 1, falloff: 0.5, height: 0, layer: 0 },
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
  return { initial, state, committed, sync, canvas, windowTarget, pointer, centerHeight };
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
