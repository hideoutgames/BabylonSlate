import { describe, expect, it, vi } from "vitest";
import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3, type Mesh } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@babylonslate/core";
import { createLandscapeMesh } from "./landscape-mesh";
import { createWaterMesh, setSceneWaterTime, updateSceneWater } from "./water-mesh";
import { createWaterRemovalMesh, sceneWaterRemovals } from "./water-removal-mesh";
import { applyAssignMesh, createSnapshotSceneBinding } from "./snapshot-apply";
import {
  distanceTransform, WATER_FIELD_DEPTH_RANGE, WATER_FIELD_EDGE_RAMP, WATER_FIELD_MOVE_MS, WATER_FIELD_SHORE_RANGE, WATER_FIELD_TERRAIN_ALPHA, WaterField,
} from "./water-field";

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
    alpha: field.data[i + 3]!,
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

  it("finishes only a requested region, exactly up to its cap, as contact rebuilds read it", () => {
    const width = 41, height = 33, seeds = new Float32Array(width * height).fill(1e20);
    // Scattered seeds, some with a vertical offset, around and outside the region.
    for (let i = 0; i < 40; i++) seeds[(i * 7919) % seeds.length] = (i % 3) * 0.7;
    const full = distanceTransform(seeds.slice(), width, height);
    const region = { x0: 9, z0: 6, x1: 30, z1: 21, cap: 36 };
    const part = distanceTransform(seeds.slice(), width, height, region);
    for (let z = region.z0; z < region.z1; z++) for (let x = region.x0; x < region.x1; x++) {
      const i = z * width + x;
      if (full[i]! <= region.cap) expect(part[i]).toBe(full[i]);
      else expect(part[i]).toBeGreaterThan(region.cap);
    }
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
      // A vertical-only water move changes terrain depth even when its X/Z bounds stay fixed (once the refill interval
      // after the field's last fill has passed).
      const clock = performance.now() + WATER_FIELD_MOVE_MS;
      vi.spyOn(performance, "now").mockReturnValue(clock);
      ocean.position.y = 2;
      updateSceneWater(scene);
      expect(texel(fieldOf(ocean), 15, -10).depth).toBeCloseTo(6, 0);
      const hole = createWaterRemovalMesh(scene, "hole", { shape: "sphere", width: 2 }, { editor: false });
      expect(sceneWaterRemovals(scene).map((entry) => entry.mesh)).toEqual([hole]);
      hole.dispose();
      expect(sceneWaterRemovals(scene)).toEqual([]);
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
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

  it("samples a varying rest height sparsely but keeps depth within a few centimetres, and knows where the water ends", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    let field: WaterField | undefined;
    try {
      const surface = MeshBuilder.CreateGround("water", { width: 20, height: 20 }, scene);
      surface.metadata = { slateWater: true };
      createLandscapeMesh(scene, "floor", { width: 30, depth: 30, subdivisions: 4, heights: Array(25).fill(-3) });
      // A rest height bending over metres (as a blend between bodies does), with no water beyond 8 m of the centre.
      let calls = 0;
      const level = (x: number, z: number) => 0.4 * Math.sin(x / 3) * Math.cos(z / 4);
      const surfaceY = (x: number, z: number) => { calls++; return Math.hypot(x, z) < 8 ? level(x, z) : null; };
      field = new WaterField(scene, { mesh: surface, unbounded: false, amplitude: 0.5, contactRange: 1, surfaceY });
      field.update();
      const view = field as unknown as FieldView, cells = view.width * view.height;
      // Far fewer rest-height evaluations than cells...
      expect(calls).toBeLessThan(cells / 4);
      // ...and the stored fine depth (3 m of floor below the rest height) still follows it within a step or so.
      for (let x = -7; x <= 7; x += 0.9) for (let z = -5; z <= 5; z += 1.3) {
        if (Math.hypot(x, z) > 7.5) continue;
        const cell = 1 / (view.bounds[2]! * view.width);
        const cx = view.bounds[0]! + (Math.floor((x - view.bounds[0]!) / cell) + 0.5) * cell, cz = view.bounds[1]! + (Math.floor((z - view.bounds[1]!) / cell) + 0.5) * cell;
        expect(Math.abs(texel(view, x, z).fineDepth - (level(cx, cz) + 3))).toBeLessThan(0.03);
      }
      // Beyond the water's edge nothing is known.
      expect(texel(view, 9.5, 0).known).toBe(false);
    } finally { field?.dispose(); scene.dispose(); engine.dispose(); }
  });

  it("keeps a bounded body's rim clear of the border cells where the shader hands the field over to open water", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    let field: WaterField | undefined;
    try {
      // A river-sized body over a wide landscape: its cells are well over a metre, so a fixed 1 m margin would leave the
      // rim of the water inside the field's last three cells (where terrain depth fades out, drawing the rim as pale water).
      const surface = MeshBuilder.CreateGround("water", { width: 700, height: 60 }, scene);
      surface.metadata = { slateWater: true };
      createLandscapeMesh(scene, "floor", { width: 800, depth: 200, subdivisions: 4, heights: Array(25).fill(-3) });
      field = new WaterField(scene, { mesh: surface, unbounded: false, amplitude: 0.5, contactRange: 1, surfaceY: () => 0 });
      field.update();
      const view = field as unknown as FieldView;
      const cell = 1 / (view.bounds[2]! * view.width);
      expect(cell).toBeGreaterThan(1);
      const box = surface.getBoundingInfo().boundingBox;
      expect(box.minimumWorld.x - view.bounds[0]!).toBeGreaterThanOrEqual(3 * cell);
      expect(view.bounds[0]! + view.width * cell - box.maximumWorld.x).toBeGreaterThanOrEqual(3 * cell);
      expect(box.minimumWorld.z - view.bounds[1]!).toBeGreaterThanOrEqual(3 * cell);
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

  it("carries an underwater landscape edge's depth past it with fading alpha, so the edge reads as no slope and no shore", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    let field: WaterField | undefined;
    try {
      // A 40 m floor 4 m under a 100 m body: the field covers the body, so most of it lies beyond the landscape.
      const surface = MeshBuilder.CreateGround("water", { width: 100, height: 100 }, scene);
      surface.metadata = { slateWater: true };
      createLandscapeMesh(scene, "floor", { width: 40, depth: 40, subdivisions: 4, heights: Array(25).fill(-4) });
      field = new WaterField(scene, { mesh: surface, unbounded: false, amplitude: 0.5, contactRange: 1, surfaceY: () => 0 });
      field.update();
      const view = field as unknown as FieldView, cell = 1 / (view.bounds[2]! * view.width);
      const inside = texel(view, 20 - cell * 0.5, 0);
      expect(inside).toMatchObject({ known: true, alpha: 255 });
      // Cells beyond the edge keep the edge depth (both channels), so central differences across it find a flat
      // floor, while alpha falls cell by cell over the ramp and the terrain depth hands over to the shelving
      // estimate gradually. Every extended cell stays below the alpha at which the shader treats terrain as real
      // (removing water and measuring the shore from depth over slope).
      expect(texel(view, 20 + cell * 0.5, 0).alpha / 255).toBeLessThan(WATER_FIELD_TERRAIN_ALPHA - 0.01);
      let previous = 255;
      for (let x = 20 + cell * 0.5; x < 20 + WATER_FIELD_EDGE_RAMP - cell; x += cell) {
        const extended = texel(view, x, 0);
        expect(extended.depth).toBeCloseTo(inside.depth, 1);
        expect(extended.fineDepth).toBeCloseTo(inside.fineDepth, 1);
        expect(extended.alpha).toBeLessThan(previous);
        expect(extended.alpha).toBeGreaterThan(0);
        previous = extended.alpha;
      }
      expect(texel(view, 20 + WATER_FIELD_EDGE_RAMP + 2 * cell, 0).alpha).toBe(0);
    } finally { field?.dispose(); scene.dispose(); engine.dispose(); }
  });

  it("leaves water past a landscape edge above the water unknown, measuring its shore from the real land", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    let field: WaterField | undefined;
    try {
      // A 40 m tile in a 100 m body: dry (1 m up) along its west edge, 4 m under water along its east edge.
      const surface = MeshBuilder.CreateGround("water", { width: 100, height: 100 }, scene);
      surface.metadata = { slateWater: true };
      const side = 9, heights = Array.from({ length: side * side }, (_, i) => [1, 1, 1, 1, -1.5, -4, -4, -4, -4][i % side]!);
      createLandscapeMesh(scene, "coast", { width: 40, depth: 40, subdivisions: side - 1, heights });
      field = new WaterField(scene, { mesh: surface, unbounded: false, amplitude: 0.5, contactRange: 1, surfaceY: () => 0 });
      field.update();
      const view = field as unknown as FieldView, cell = 1 / (view.bounds[2]! * view.width);
      expect(texel(view, -20 + cell * 0.5, 0)).toMatchObject({ known: true, alpha: 255 });
      // Past the dry edge there is no terrain under the water: those cells are not terrain at all (never removed and
      // no shoreline from a dry depth with no slope), and their shore distance grows from the land as usual...
      for (const gap of [0.5, 2, 5, 8, 12]) {
        const open = texel(view, -20 - gap, 0);
        expect(open.alpha).toBe(0);
        expect(open.shore).toBeGreaterThan(gap - 2 * cell);
        expect(open.shore).toBeLessThan(gap + 2 * cell);
      }
      // ...while the underwater edge still extends its depth.
      const east = texel(view, 20 + 2, 0);
      expect(east.alpha).toBeGreaterThan(0);
      expect(east.depth).toBeCloseTo(4, 0);
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

  it("follows landscapes added, moved, hidden and removed after the water, and refills nothing on unchanged frames", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 30, -30), scene).setTarget(Vector3.Zero());
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    // A frame some time after the last edit (fields refill at most every WATER_FIELD_MOVE_MS while edits keep coming).
    const later = () => { clock += WATER_FIELD_MOVE_MS; updateSceneWater(scene); };
    try {
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 30, length: 30 }), createDefaultWaterDefinition());
      const field = liveField(lake);
      expect(field.texture).toBeNull();
      const floor = createLandscapeMesh(scene, "floor", { width: 40, depth: 40, subdivisions: 4, heights: Array(25).fill(-3) });
      later();
      expect(texel(fieldOf(lake), 0, 0).depth).toBeCloseTo(3, 0);
      floor.position.y = -2; floor.computeWorldMatrix(true); later();
      expect(texel(fieldOf(lake), 0, 0).depth).toBeCloseTo(5, 0);
      const uploads = [vi.spyOn(engine, "updateRawTexture"), vi.spyOn(engine, "createRawTexture")];
      for (let frame = 0; frame < 3; frame++) later();
      for (const upload of uploads) expect(upload).not.toHaveBeenCalled();
      // A landscape moving every frame refills the field at most every WATER_FIELD_MOVE_MS, and its last pose lands.
      for (let frame = 0; frame < 9; frame++) { floor.position.y -= 0.1; floor.computeWorldMatrix(true); clock += 1000 / 60; updateSceneWater(scene); }
      expect(uploads[0]!.mock.calls.length).toBe(1);
      later();
      expect(texel(fieldOf(lake), 0, 0).depth).toBeCloseTo(5.9, 0);
      floor.setEnabled(false); later();
      expect(field.texture).toBeNull();
      floor.setEnabled(true); later();
      expect(texel(fieldOf(lake), 0, 0).depth).toBeCloseTo(5.9, 0);
      floor.dispose(); later();
      expect(field.texture).toBeNull();
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });

  it("keeps a finite body's terrain field while Gerstner waves sway its edges", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 30, -30), scene);
    try {
      createLandscapeMesh(scene, "floor", { width: 40, depth: 40, subdivisions: 4, heights: Array(25).fill(-3) });
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 30, length: 30, waveScale: 1 }), createDefaultWaterDefinition());
      expect(texel(fieldOf(lake), 0, 0).depth).toBeCloseTo(3, 0);
      // The field is keyed on the surface bounds, so they must not follow the moving edges frame by frame.
      const uploads = [vi.spyOn(engine, "updateRawTexture"), vi.spyOn(engine, "createRawTexture")];
      for (let step = 1; step <= 5; step++) { setSceneWaterTime(scene, step * 0.37); updateSceneWater(scene); }
      for (const upload of uploads) expect(upload).not.toHaveBeenCalled();
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });
});
