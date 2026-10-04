import { describe, expect, it } from "vitest";
import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3, type Mesh } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@babylonslate/core";
import { createLandscapeMesh } from "./landscape-mesh";
import { createWaterMesh, updateSceneWater } from "./water-mesh";
import { createWaterRemovalMesh, sceneWaterRemovals } from "./water-removal-mesh";
import { applyAssignMesh, createSnapshotSceneBinding } from "./snapshot-apply";
import { distanceTransform, WATER_FIELD_DEPTH_RANGE, WATER_FIELD_SHORE_RANGE, WaterField } from "./water-field";

type FieldView = { data: Uint8Array; width: number; height: number; bounds: number[]; depthRange?: readonly [number, number]; fineDepthMin: number; fineDepthSpan: number };
const liveField = (mesh: Mesh) => (mesh.material as unknown as { pluginManager: { _plugins: Array<{ field?: WaterField | null }> } })
  .pluginManager._plugins.find((plugin) => plugin.field)!.field!;
const fieldOf = (mesh: Mesh) => liveField(mesh) as unknown as FieldView;
/** Decoded texel at a world X/Z. */
function texel(field: FieldView, x: number, z: number) {
  const u = Math.floor((x - field.bounds[0]!) * field.bounds[2]! * field.width), v = Math.floor((z - field.bounds[1]!) * field.bounds[3]! * field.height);
  const i = (v * field.width + u) * 4, decode = (byte: number, [min, max]: readonly [number, number]) => min + byte / 255 * (max - min);
  return {
    shore: decode(field.data[i]!, WATER_FIELD_SHORE_RANGE), depth: decode(field.data[i + 1]!, field.depthRange ?? WATER_FIELD_DEPTH_RANGE),
    fineDepth: decode(field.data[i + 2]!, [field.fineDepthMin, field.fineDepthMin + field.fineDepthSpan]), known: field.data[i + 3] === 255,
  };
}

describe("Water field", () => {
  it("computes exact Euclidean distances to marked cells", () => {
    const grid = new Float64Array(5 * 4).fill(1e20);
    grid[1 * 5 + 1] = 0;
    distanceTransform(grid, 5, 4);
    expect(grid[1 * 5 + 1]).toBe(0);
    expect(grid[3 * 5 + 4]).toBe(2 * 2 + 3 * 3);
    expect(grid[0]).toBe(2);
  });

  it("records true depth over terrain and the shoreline", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 30, -30), scene);
    try {
      // A 40 m square landscape: a raised island in the west half, a 4 m deep floor in the east.
      const side = 16, heights = Array.from({ length: (side + 1) ** 2 }, (_, i) => (i % (side + 1)) < side / 2 ? 3 : -4);
      createLandscapeMesh(scene, "land", { width: 40, depth: 40, subdivisions: side, heights });
      const water = createDefaultWaterDefinition();
      const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({}, "global"), water);
      const field = fieldOf(ocean);
      const east = texel(field, 15, -10), inland = texel(field, -12, -10);
      expect(east).toMatchObject({ known: true });
      expect(east.depth).toBeCloseTo(4, 0);
      expect(east.shore).toBeGreaterThan(8);
      expect(inland.depth).toBeLessThanOrEqual(0);
      expect(inland.shore).toBeLessThan(0);
      // A vertical-only water move changes terrain depth even when its X/Z bounds stay fixed.
      ocean.position.y = 2;
      updateSceneWater(scene);
      expect(texel(fieldOf(ocean), 15, -10).depth).toBeCloseTo(6, 0);
      const hole = createWaterRemovalMesh(scene, "hole", { shape: "sphere", width: 2 }, { editor: false });
      expect(sceneWaterRemovals(scene).map((entry) => entry.mesh)).toEqual([hole]);
      hole.dispose();
      expect(sceneWaterRemovals(scene)).toEqual([]);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("realizes a Play removal volume as an invisible cutter with its live transform", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const binding = createSnapshotSceneBinding();
    try {
      applyAssignMesh(scene, binding, {
        type: "assignMesh", slotId: 3, meshKind: "waterRemoval", meshAssetGuid: null,
        parts: [{ componentId: "hole", meshKind: "waterRemoval", meshAssetGuid: null, parentId: null, position: [0, 0, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1], waterRemoval: { enabled: true, shape: "capsule", width: 2, height: 5, length: 2 } }],
      });
      const [entry] = sceneWaterRemovals(scene);
      expect(entry?.volume).toMatchObject({ shape: "capsule", height: 5 });
      expect(entry!.mesh.getChildMeshes().filter((child) => child.isVisible && child.getTotalVertices() > 0)).toEqual([]);
      binding.meshes.get(3)!.position.x = 9;
      expect(entry!.mesh.computeWorldMatrix(true).getTranslation().asArray()).toEqual([9, 0, 2]);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("stores shallow depth finely enough that a gentle shore shades without terraces", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    let field: WaterField | undefined;
    try {
      const surface = MeshBuilder.CreateGround("water", { width: 20, height: 20 }, scene);
      surface.metadata = { slateWater: true };
      // A beach rising 0.15 m per metre across X, crossing the waterline at x = 0.
      const side = 20, heights = Array.from({ length: (side + 1) ** 2 }, (_, i) => -1.5 + (i % (side + 1)) * 0.15);
      createLandscapeMesh(scene, "beach", { width: 20, depth: 20, subdivisions: side, heights });
      field = new WaterField(scene, { mesh: surface, unbounded: false, amplitude: 0.5, contactRange: 1, surfaceY: () => 0 });
      field.update();
      const view = field as unknown as FieldView;
      // Across the shallows, depth follows the slope to within a couple of centimetres at every cell...
      const cell = 1 / (view.bounds[2]! * view.width);
      for (let x = -9; x < 6; x += 0.37) {
        const centre = view.bounds[0]! + (Math.floor((x - view.bounds[0]!) / cell) + 0.5) * cell;
        expect(Math.abs(texel(view, x, 0).fineDepth + centre * 0.15)).toBeLessThan(0.02);
      }
      // ...while dry land still reads as dry below the lowest trough.
      expect(texel(view, 9.5, 0).fineDepth).toBeLessThan(-0.5);
    } finally { field?.dispose(); scene.dispose(); engine.dispose(); }
  });

  it("keeps fine depth across every displaced waterline of storm waves on a steep shore", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    let field: WaterField | undefined;
    try {
      const surface = MeshBuilder.CreateGround("water", { width: 36, height: 8 }, scene);
      surface.metadata = { slateWater: true };
      // A coast rising 0.5 m per metre across X, crossing the rest waterline at x = 0 (rest depth -x / 2).
      const side = 40, heights = Array.from({ length: (side + 1) ** 2 }, (_, i) => -10 + (i % (side + 1)) * 0.5);
      createLandscapeMesh(scene, "coast", { width: 40, depth: 40, subdivisions: side, heights });
      // Waves reach 5 m either side of rest: a trough exposes the floor down to a rest depth of 5 m (x = -10).
      field = new WaterField(scene, { mesh: surface, unbounded: false, amplitude: 5, contactRange: 1, surfaceY: () => 0 });
      field.update();
      const view = field as unknown as FieldView;
      const cell = 1 / (view.bounds[2]! * view.width);
      // From beyond the trough shoreline to above the crest shoreline, depth resolves within a few centimetres,
      // so the shader's shoreline distance (depth over slope) never reads a clamped, flat floor.
      for (let x = -17; x < 5.5; x += 0.53) {
        const centre = view.bounds[0]! + (Math.floor((x - view.bounds[0]!) / cell) + 0.5) * cell;
        expect(Math.abs(texel(view, x, 0).fineDepth + centre * 0.5)).toBeLessThan(0.05);
      }
    } finally { field?.dispose(); scene.dispose(); engine.dispose(); }
  });

  it("retains terrain depth throughout the high-wave envelope", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    let field: WaterField | undefined;
    try {
      const surface = MeshBuilder.CreateGround("water", { width: 8, height: 8 }, scene);
      surface.metadata = { slateWater: true };
      createLandscapeMesh(scene, "deep floor", { width: 12, depth: 12, subdivisions: 4, heights: Array(25).fill(-45) });
      field = new WaterField(scene, { mesh: surface, unbounded: false, amplitude: 50, contactRange: 1, surfaceY: () => 0 });
      field.update();
      expect(texel(field as unknown as FieldView, 0, 0).depth).toBeCloseTo(45, 0);
    } finally { field?.dispose(); scene.dispose(); engine.dispose(); }
  });
});
