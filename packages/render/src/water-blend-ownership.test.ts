import { afterEach, describe, expect, it } from "vitest";
import { FreeCamera, type Mesh, NullEngine, Quaternion, Scene, Vector3, VertexBuffer } from "@babylonjs/core";
import {
  createDefaultWaterDefinition, createWaterBlendSample, DEFAULT_WATER_BLEND_DISTANCE, evaluateWaterBlend, normalizeWaterBody, WaterBlendIndex, type WaterBlendBody,
} from "@haptic/core";
import { blendOwnership, blendOwnershipAt } from "./water-blend-ownership";
import { createWaterMesh, settleSceneWater, updateSceneWater } from "./water-mesh";
import { waterGridOffset } from "./water-material";
import { meshWaterNodeSurface } from "./water-node-blocks";
import { builtInWaterMaterial } from "./water-template";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

function scene(): { scene: Scene; camera: FreeCamera } {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 50, -80), scene);
  scene.activeCamera = camera;
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  return { scene, camera };
}

/**
 * Whether a water mesh keeps world X/Z as its Water Cut does: inside one of its triangles, the interpolated union
 * shoreline at or above zero and the seam's margin too (the per-pixel ownership where the surface has it, else the
 * interpolated per-vertex margin plus the cut's 1.5 cm). Triangles are bucketed by 2 m cells for the lookups.
 */
function keeper(mesh: Mesh): (x: number, z: number) => { kept: boolean; margin: number } {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!, data = mesh.getVerticesData("slateWaterData")!, blend = mesh.getVerticesData("slateWaterBlend");
  const idx = mesh.getIndices()!, world = mesh.computeWorldMatrix(true), offset = waterGridOffset(mesh);
  const points: Array<[number, number, number, number]> = [];
  for (let v = 0; v < pos.length / 3; v++) {
    const p = Vector3.TransformCoordinates(Vector3.FromArray(pos, v * 3), world);
    points.push([p.x + offset[0]!, p.z + offset[2]!, data[v * 4 + 1]!, blend ? blend[v * 4 + 2]! : 1]);
  }
  const buckets = new Map<string, number[]>(), cell = 2, key = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [points[idx[t]!]!, points[idx[t + 1]!]!, points[idx[t + 2]!]!];
    const minX = Math.min(...tri.map((p) => p[0])), maxX = Math.max(...tri.map((p) => p[0]));
    const minZ = Math.min(...tri.map((p) => p[1])), maxZ = Math.max(...tri.map((p) => p[1]));
    // Only the probed region (the grids reach kilometres out).
    if (maxX < -80 || minX > 80 || maxZ < -80 || minZ > 80) continue;
    for (let bx = Math.floor(Math.max(minX, -80) / cell); bx <= Math.floor(Math.min(maxX, 80) / cell); bx++) {
      for (let bz = Math.floor(Math.max(minZ, -80) / cell); bz <= Math.floor(Math.min(maxZ, 80) / cell); bz++) {
        const list = buckets.get(`${bx},${bz}`) ?? [];
        list.push(t);
        buckets.set(`${bx},${bz}`, list);
      }
    }
  }
  const ownership = meshWaterNodeSurface(mesh)?.ownership ?? null;
  return (x, z) => {
    for (const t of buckets.get(key(x, z)) ?? []) {
      const a = points[idx[t]!]!, b = points[idx[t + 1]!]!, c = points[idx[t + 2]!]!;
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (z - c[1])) / d, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (z - c[1])) / d, l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const union = l1 * a[2] + l2 * b[2] + l3 * c[2];
      const margin = ownership ? blendOwnershipAt(ownership, x, z) : l1 * a[3] + l2 * b[3] + l3 * c[3] + 0.015;
      return { kept: Math.min(union, margin) >= 0, margin };
    }
    return { kept: false, margin: -1 };
  };
}

/** FT_World's sea and Ocean: Global Water at y = −6 and a 40 × 80 Ocean east of the island. */
function sea(s: Scene) {
  const global = createWaterMesh(s, "global", normalizeWaterBody({}, "global"), undefined, builtInWaterMaterial(s));
  global.position.set(0, -6, 0);
  const ocean = createWaterMesh(s, "ocean", normalizeWaterBody({ width: 40, length: 80 }, "ocean"), undefined, builtInWaterMaterial(s));
  ocean.position.set(36, -6, 0);
  return { global, ocean };
}

/** From FT_World's own camera out to where the Global grid's cells are wider than the Ocean. */
const CAMERAS = [[-4, 52, -82], [0, 100, -160], [0, 150, -250], [0, 300, -600], [-200, 400, -900]] as const;

describe("blend seams", () => {
  it.each(CAMERAS)("leave no gap and no overlap between Global Water and an Ocean, with the camera at (%i, %i, %i)", (cx, cy, cz) => {
    const { scene: s, camera } = scene();
    const { global, ocean } = sea(s);
    camera.position.set(cx, cy, cz);
    camera.setTarget(new Vector3(4, 0, 6));
    for (let i = 0; i < 8; i++) { settleSceneWater(s, true); updateSceneWater(s); }
    const g = keeper(global), o = keeper(ocean);
    let gaps = 0, overlaps = 0;
    for (let z = -48; z <= 48; z += 0.5) for (let x = 8; x <= 64; x += 0.5) {
      const a = g(x, z), b = o(x, z);
      if (!a.kept && !b.kept) gaps++;
      // Exactly on the seam both may keep.
      if (a.kept && b.kept && Math.abs(a.margin) > 1e-4 && Math.abs(b.margin) > 1e-4) overlaps++;
    }
    expect({ gaps, overlaps }).toEqual({ gaps: 0, overlaps: 0 });
  });

  it.each(CAMERAS.slice(0, 3))("leave no gap where a river runs into a lake, with the camera at (%i, %i, %i)", (cx, cy, cz) => {
    const { scene: s, camera } = scene();
    const lake = createWaterMesh(s, "lake", normalizeWaterBody({ width: 30, length: 20 }, "lake"), undefined, builtInWaterMaterial(s));
    const river = createWaterMesh(s, "river", normalizeWaterBody({ width: 6, points: [[-40, 0, 0], [-25, 0, 1], [-12, 0, 0]] }, "river"), undefined, builtInWaterMaterial(s));
    camera.position.set(cx, cy, cz);
    camera.setTarget(new Vector3(-15, 0, 0));
    for (let i = 0; i < 8; i++) { settleSceneWater(s, true); updateSceneWater(s); }
    // Neither qualifies for the per-pixel seam (a river takes part): both keep the per-vertex margin.
    expect([meshWaterNodeSurface(lake)!.ownership ?? null, meshWaterNodeSurface(river)!.ownership ?? null]).toEqual([null, null]);
    const l = keeper(lake), r = keeper(river);
    let gaps = 0;
    // Along the river's middle, from its reach into the lake: water of the union everywhere.
    for (let x = -30; x <= -6; x += 0.25) for (let z = -1.5; z <= 1.5; z += 0.5) if (!l(x, z).kept && !r(x, z).kept) gaps++;
    expect(gaps).toBe(0);
  });
});

describe("blendOwnership", () => {
  it("evaluates the blend kernel's ownership per pixel, for boxes, ellipses and open water, turned and scaled", () => {
    const water = createDefaultWaterDefinition();
    const body = (kind: "global" | "ocean" | "lake" | "puddle", x: number, z: number, width: number, length: number, yaw = 0, scale = 1): WaterBlendBody => {
      const q = Quaternion.RotationYawPitchRoll(yaw, 0, 0);
      return {
        definition: water, body: normalizeWaterBody({ width, length }, kind),
        transform: { position: { x, y: 0, z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w }, scale: { x: scale, y: 1, z: scale * 1.3 } },
      };
    };
    const index = new WaterBlendIndex();
    index.update([body("global", 0, 0, 1, 1), body("ocean", 20, 0, 30, 40, 0.4), body("lake", -10, 5, 16, 10, -0.7, 1.2), body("puddle", -4, -6, 4, 3, 0.2)], DEFAULT_WATER_BLEND_DISTANCE);
    const sample = createWaterBlendSample();
    let compared = 0;
    for (let self = 0; self < 4; self++) {
      const data = blendOwnership(index, self, null);
      expect(data).not.toBeNull();
      for (let x = -30; x <= 40; x += 0.7) for (let z = -30; z <= 30; z += 0.7) {
        const kernel = evaluateWaterBlend(index, self, x, 0, z, sample, true) ? sample.margin : -1;
        const pixel = blendOwnershipAt(data!, x, z);
        if (Math.abs(kernel) < 1e-6) continue;
        expect(pixel, `${self} at ${x}, ${z}`).toBeCloseTo(kernel, 5);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(10000);
  });

  it("does not take a river, a body turned out of level, or more neighbours than it has room for", () => {
    const water = createDefaultWaterDefinition();
    const at = (kind: "global" | "lake" | "river", x: number, extra: Record<string, unknown> = {}, pitch = 0): WaterBlendBody => {
      const q = Quaternion.RotationYawPitchRoll(0, pitch, 0);
      return { definition: water, body: normalizeWaterBody({ width: 10, length: 10, ...extra }, kind), transform: { position: { x, y: 0, z: 0 }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w }, scale: { x: 1, y: 1, z: 1 } } };
    };
    const qualifies = (bodies: WaterBlendBody[]) => {
      const index = new WaterBlendIndex();
      index.update(bodies, DEFAULT_WATER_BLEND_DISTANCE);
      return blendOwnership(index, 0, null) !== null;
    };
    expect(qualifies([at("global", 0), at("lake", 0)])).toBe(true);
    expect(qualifies([at("global", 0), at("river", 0, { points: [[-10, 0, 0], [10, 0, 0]] })])).toBe(false);
    expect(qualifies([at("global", 0), at("lake", 0, {}, 0.2)])).toBe(false);
    expect(qualifies([at("global", 0), at("lake", -20), at("lake", -7), at("lake", 7), at("lake", 20)])).toBe(false);
  });
});
