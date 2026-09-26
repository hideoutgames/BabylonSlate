import { describe, expect, it } from "vitest";
import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3, type Mesh } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@babylonslate/core";
import { createLandscapeMesh } from "./landscape-mesh";
import { createWaterMesh } from "./water-mesh";
import { createWaterRemovalMesh, sceneWaterRemovals } from "./water-removal-mesh";
import { distanceTransform, isWaterContactMesh, WATER_FIELD_DEPTH_RANGE, WATER_FIELD_SHORE_RANGE, type WaterField } from "./water-field";

type FieldView = { data: Uint8Array; width: number; height: number; bounds: number[] };
const liveField = (mesh: Mesh) => (mesh.material as unknown as { pluginManager: { _plugins: Array<{ field?: WaterField | null }> } })
  .pluginManager._plugins.find((plugin) => plugin.field)!.field!;
const fieldOf = (mesh: Mesh) => liveField(mesh) as unknown as FieldView;
/** Decoded texel at a world X/Z. */
function texel(field: FieldView, x: number, z: number) {
  const u = Math.floor((x - field.bounds[0]!) * field.bounds[2]! * field.width), v = Math.floor((z - field.bounds[1]!) * field.bounds[3]! * field.height);
  const i = (v * field.width + u) * 4, decode = (byte: number, [min, max]: readonly [number, number]) => min + byte / 255 * (max - min);
  return { shore: decode(field.data[i]!, WATER_FIELD_SHORE_RANGE), depth: decode(field.data[i + 1]!, WATER_FIELD_DEPTH_RANGE), object: field.data[i + 2]! / 255, known: field.data[i + 3] === 255 };
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

  it("records true depth over terrain, the shoreline and contact distance to objects crossing the surface", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 30, -30), scene);
    try {
      // A 40 m square landscape: a raised island in the west half, a 4 m deep floor in the east.
      const side = 16, heights = Array.from({ length: (side + 1) ** 2 }, (_, i) => (i % (side + 1)) < side / 2 ? 3 : -4);
      createLandscapeMesh(scene, "land", { width: 40, depth: 40, subdivisions: side, heights });
      const post = MeshBuilder.CreateBox("post", { width: 1, height: 6, depth: 1 }, scene);
      post.position.set(12, 0, 0);
      const high = MeshBuilder.CreateBox("high", { size: 1 }, scene);
      high.position.set(12, 20, 10);
      expect(isWaterContactMesh(post)).toBe(true);
      const water = createDefaultWaterDefinition();
      const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({}, "global"), water);
      const field = fieldOf(ocean);
      const east = texel(field, 15, -10), inland = texel(field, -12, -10);
      expect(east).toMatchObject({ known: true });
      expect(east.depth).toBeCloseTo(4, 0);
      expect(east.shore).toBeGreaterThan(8);
      expect(inland.depth).toBeLessThanOrEqual(0);
      expect(inland.shore).toBeLessThan(0);
      // The post's waterline outline is foam-distance zero; a box above the water leaves none.
      expect(texel(field, 12.5, 0).object).toBeLessThan(0.05);
      expect(texel(field, 12, 10).object).toBe(1);
      // Moving the post moves its contact ring.
      post.position.set(16, 0, -14);
      liveField(ocean).update(performance.now() + 1000);
      const moved = fieldOf(ocean);
      expect(texel(moved, 12.5, 0).object).toBe(1);
      expect(texel(moved, 16.5, -14).object).toBeLessThan(0.05);
      const hole = createWaterRemovalMesh(scene, "hole", { shape: "sphere", width: 2 }, { editor: false });
      expect(sceneWaterRemovals(scene).map((entry) => entry.mesh)).toEqual([hole]);
      hole.dispose();
      expect(sceneWaterRemovals(scene)).toEqual([]);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
