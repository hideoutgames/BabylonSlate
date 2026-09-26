import { describe, expect, it } from "vitest";
import { FreeCamera, Mesh, MeshBuilder, NullEngine, Scene, Vector3, VertexData } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@babylonslate/core";
import { createLandscapeMesh } from "./landscape-mesh";
import { createWaterMesh, updateSceneWater } from "./water-mesh";
import { createWaterRemovalMesh, sceneWaterRemovals } from "./water-removal-mesh";
import { applyAssignMesh, createSnapshotSceneBinding } from "./snapshot-apply";
import { distanceTransform, isWaterContactMesh, WATER_FIELD_DEPTH_RANGE, WATER_FIELD_SHORE_RANGE, WaterField } from "./water-field";

type FieldView = { data: Uint8Array; width: number; height: number; bounds: number[]; depthRange?: readonly [number, number] };
const liveField = (mesh: Mesh) => (mesh.material as unknown as { pluginManager: { _plugins: Array<{ field?: WaterField | null }> } })
  .pluginManager._plugins.find((plugin) => plugin.field)!.field!;
const fieldOf = (mesh: Mesh) => liveField(mesh) as unknown as FieldView;
/** Decoded texel at a world X/Z. */
function texel(field: FieldView, x: number, z: number) {
  const u = Math.floor((x - field.bounds[0]!) * field.bounds[2]! * field.width), v = Math.floor((z - field.bounds[1]!) * field.bounds[3]! * field.height);
  const i = (v * field.width + u) * 4, decode = (byte: number, [min, max]: readonly [number, number]) => min + byte / 255 * (max - min);
  return { shore: decode(field.data[i]!, WATER_FIELD_SHORE_RANGE), depth: decode(field.data[i + 1]!, field.depthRange ?? WATER_FIELD_DEPTH_RANGE), object: field.data[i + 2]! / 255, known: field.data[i + 3] === 255 };
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

  it("keeps oblique contacts and edges exactly on the waterline without outlining submerged faces", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const contact = new Mesh("contact", scene), triangles = new VertexData();
      triangles.positions = [
        // Crosses the water between (-5, -4) and (-4, -5) in world X/Z.
        -6, -2, -6, -4, 2, -2, -2, 2, -4,
        // An edge on the waterline must retain its contact from (3, -3) to (7, 1).
        3, 0, -3, 7, 0, 1, 5, 2, 5,
        // A submerged triangle in the same mesh must not contribute an outline.
        -6, -2, 4, -2, -2, 4, -4, -2, 8,
      ];
      triangles.indices = [0, 1, 2, 3, 4, 5, 6, 7, 8];
      triangles.applyToMesh(contact);
      const water = { ...createDefaultWaterDefinition(), waveHeight: 0 };
      const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({ width: 24, length: 24, resolution: 8 }, "ocean"), water);
      const field = fieldOf(ocean);
      expect(texel(field, -4.5, -4.5).object).toBeLessThan(0.1);
      expect(texel(field, 5, -1).object).toBeLessThan(0.1);
      expect(texel(field, 3, -3).object).toBeLessThan(0.1);
      expect(texel(field, -4, 5).object).toBe(1);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("moves tapered contacts with wave height while retaining the throttle and paused field", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    let field: WaterField | undefined;
    try {
      const surface = MeshBuilder.CreateGround("water", { width: 12, height: 12 }, scene);
      surface.metadata = { slateWater: true };
      MeshBuilder.CreateCylinder("tapered post", { height: 8, diameterBottom: 8, diameterTop: 0, tessellation: 32 }, scene);
      let phase = 0;
      field = new WaterField(scene, {
        mesh: surface, unbounded: false, amplitude: 3, contactRange: 1,
        surfaceY: () => 0, contactY: () => phase === 0 ? 2 : -2, contactRevision: () => phase,
      });
      expect(field.update(0)).toBe(true);
      let view = field as unknown as FieldView;
      expect(texel(view, 1, 0).object).toBeLessThan(0.25);
      expect(texel(view, 3, 0).object).toBe(1);
      phase = 1;
      expect(field.update(50)).toBe(false);
      expect(field.update(100)).toBe(true);
      view = field as unknown as FieldView;
      expect(texel(view, 1, 0).object).toBe(1);
      expect(texel(view, 3, 0).object).toBeLessThan(0.25);
      expect(field.update(200)).toBe(false);
    } finally { field?.dispose(); scene.dispose(); engine.dispose(); }
  });

  it.each(["x", "z"] as const)("finds %s-wave contacts inside coarse faces even when every corner is below the water", (axis) => {
    const engine = new NullEngine(), scene = new Scene(engine);
    let field: WaterField | undefined;
    try {
      const surface = MeshBuilder.CreateGround("water", { width: 12, height: 12 }, scene);
      surface.metadata = { slateWater: true };
      const face = MeshBuilder.CreateGround("wide horizontal face", { width: 8, height: 8, subdivisions: 1 }, scene);
      face.position.y = 1;
      face.computeWorldMatrix(true);
      field = new WaterField(scene, {
        mesh: surface, unbounded: false, amplitude: 2, contactRange: 1,
        surfaceY: () => 0, contactY: (x, z) => 2 * Math.cos(Math.PI * (axis === "x" ? x : z) / 2), contactRevision: () => 0,
      });
      field.update(0);
      const view = field as unknown as FieldView;
      // The face at Y=1 meets this wave at +/-2/3 on either axis; its corners are under Y=2.
      const [near, opposite, far] = axis === "x"
        ? [[2 / 3, 0], [-2 / 3, 0], [2, 0]] as const
        : [[0, 2 / 3], [0, -2 / 3], [0, 2]] as const;
      expect(texel(view, ...near).object).toBeLessThan(0.25);
      expect(texel(view, ...opposite).object).toBeLessThan(0.25);
      expect(texel(view, ...far).object).toBe(1);
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
      field.update(0);
      expect(texel(field as unknown as FieldView, 0, 0).depth).toBeCloseTo(45, 0);
    } finally { field?.dispose(); scene.dispose(); engine.dispose(); }
  });

  it("keeps continuous wave contact across constant-Z box walls", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    let field: WaterField | undefined;
    try {
      const surface = MeshBuilder.CreateGround("water", { width: 12, height: 12 }, scene);
      surface.metadata = { slateWater: true };
      const post = MeshBuilder.CreateBox("wide post", { width: 8, height: 8, depth: 2 }, scene);
      field = new WaterField(scene, {
        mesh: surface, unbounded: false, amplitude: 2, contactRange: 1,
        surfaceY: () => 0, contactY: (x) => 2 * Math.cos(Math.PI * x / 2), contactRevision: () => 0,
      });
      field.update(0);
      const view = field as unknown as FieldView;
      expect(texel(view, 0, -1).object).toBeLessThan(0.25);
      expect(texel(view, 0, 1).object).toBeLessThan(0.25);
      expect(texel(view, 4, 0).object).toBeLessThan(0.25);
      // A slight heading change must not turn a continuous wall outline into sparse Z-row dots.
      post.rotation.y = 0.1;
      post.computeWorldMatrix(true);
      field.update(100);
      expect(texel(view, -Math.sin(0.1), -Math.cos(0.1)).object).toBeLessThan(0.25);
    } finally { field?.dispose(); scene.dispose(); engine.dispose(); }
  });

  it("keeps interior wave contours continuous across a pitched and yawed wall", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    let field: WaterField | undefined;
    try {
      const surface = MeshBuilder.CreateGround("water", { width: 12, height: 12 }, scene);
      surface.metadata = { slateWater: true };
      const wall = new Mesh("sloped wall", scene), face = new VertexData();
      // A steep wall with height Y = 0.2X + 4Z + 1, tilted about both horizontal axes.
      face.positions = [-4, -3.8, -1, 4, -2.2, -1, 4, 5.8, 1, -4, 4.2, 1];
      face.indices = [0, 1, 2, 0, 2, 3];
      face.applyToMesh(wall);
      field = new WaterField(scene, {
        mesh: surface, unbounded: false, amplitude: 7, contactRange: 1,
        surfaceY: () => 0, contactY: (x, z) => 0.2 * x + 4 * z + 2 * Math.cos(Math.PI * z * 2), contactRevision: () => 0,
      });
      field.update(0);
      const view = field as unknown as FieldView;
      // The crest meets the wall along Z=1/6, including points far from its edges and diagonal.
      expect(texel(view, -2, 1 / 6).object).toBeLessThan(0.25);
      expect(texel(view, 2, 1 / 6).object).toBeLessThan(0.25);
    } finally { field?.dispose(); scene.dispose(); engine.dispose(); }
  });
});
