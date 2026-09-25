import { describe, expect, it } from "vitest";
import { identityTransform } from "./math-rng";
import { eulerDegreesToQuaternion } from "./euler";
import { landscapeCollisionMesh, parseLandscapeProperties } from "./landscape";
import { landscapeHeightAt, landscapeWorldHeightAt, normalizeWaterRemoval, waterCutAt, waterRemovalDistance } from "./water-removal";

describe("Water removal and terrain cut-outs", () => {
  it("contains points inside each primitive and measures distance outside it", () => {
    const at = (shape: string, p: [number, number, number]) =>
      waterRemovalDistance(normalizeWaterRemoval({ shape, width: 2, height: 4, length: 6 }), { x: p[0], y: p[1], z: p[2] });
    expect(at("box", [0.9, 1.9, 2.9])).toBeLessThan(0);
    expect(at("box", [2, 0, 0])).toBeCloseTo(1);
    expect(at("sphere", [0, 0.9, 0])).toBeLessThan(0);
    expect(at("sphere", [0, 1.9, 0])).toBeCloseTo(0.9);
    // Cylinder and capsule stand along Y with total Height 4; only the capsule has rounded ends.
    expect(at("cylinder", [0.9, 1.95, 0])).toBeLessThan(0);
    expect(at("capsule", [0.9, 1.95, 0])).toBeGreaterThan(0);
    expect(at("capsule", [0, 1.95, 0])).toBeLessThan(0);
    expect(normalizeWaterRemoval({ shape: "cone", width: -1 })).toMatchObject({ shape: "box", width: 0.01, enabled: true });
  });

  it("samples terrain exactly on its collision triangles", () => {
    const heights = Array.from({ length: 25 }, (_, i) => (i * 7919) % 13 - 6);
    const data = parseLandscapeProperties({ width: 8, depth: 8, subdivisions: 4, heights });
    const mesh = landscapeCollisionMesh({ ...data, collisionsEnabled: true })!;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => mesh.vertices[mesh.indices[t + k]!]!);
      // Centroid of every rendered/collision triangle.
      const x = (a!.x + b!.x + c!.x) / 3, z = (a!.z + b!.z + c!.z) / 3;
      expect(landscapeHeightAt(data, x, z)).toBeCloseTo((a!.y + b!.y + c!.y) / 3, 9);
    }
    expect(landscapeHeightAt(data, 4.01, 0)).toBeNull();
  });

  it("cuts water inside transformed removal volumes and under raised terrain", () => {
    const [x, y, z, w] = eulerDegreesToQuaternion([0, 45, 0]);
    const removal = { volume: normalizeWaterRemoval({ width: 2, height: 2, length: 10 }), transform: { position: { x: 10, y: 0, z: 0 }, rotation: { x, y, z, w }, scale: { x: 1, y: 1, z: 1 } } };
    const island = parseLandscapeProperties({ width: 20, depth: 20, subdivisions: 4, heights: Array.from({ length: 25 }, (_, i) => i === 12 ? 6 : -2) });
    const land = { data: island, transform: { ...identityTransform(), position: { x: -30, y: 0, z: 0 } } };
    const cutters = { removals: [removal], landscapes: [land] };
    // The rotated box runs diagonally, so a point 3 m along its diagonal is removed but 3 m along X is not.
    expect(waterCutAt(cutters, { x: 10 + 3 / Math.SQRT2, y: 0, z: 3 / Math.SQRT2 })).toBe(true);
    expect(waterCutAt(cutters, { x: 13, y: 0, z: 0 })).toBe(false);
    expect(landscapeWorldHeightAt(island, land.transform, -30, 0)).toBeCloseTo(6);
    expect(waterCutAt(cutters, { x: -30, y: 0, z: 0 })).toBe(true);
    expect(waterCutAt(cutters, { x: -38, y: 0, z: 0 })).toBe(false);
    expect(waterCutAt({ removals: [{ ...removal, volume: { ...removal.volume, enabled: false } }], landscapes: [] }, { x: 10, y: 0, z: 0 })).toBe(false);
  });
});
