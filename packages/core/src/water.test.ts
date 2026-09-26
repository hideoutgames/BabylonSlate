import { describe, expect, it } from "vitest";
import { identityTransform } from "./math-rng";
import { eulerDegreesToQuaternion, quatRotateVector } from "./euler";
import { createDefaultWaterDefinition, normalizeWaterBody, normalizeWaterDefinition, sampleWaterSurface, sampleWaterWaves } from "./water";

describe("Water surfaces", () => {
  const flat = { ...createDefaultWaterDefinition(), waveHeight: 0 };
  it("bounds Ocean independently of the camera and reserves infinite coverage for Global Water Volume", () => {
    const ocean = normalizeWaterBody({ width: 20, length: 10 }, "ocean");
    expect(sampleWaterSurface(flat, ocean, { x: 9, y: -1, z: 4 }, 0)).toMatchObject({ found: true, edgeDistance: 1 });
    expect(sampleWaterSurface(flat, ocean, { x: 11, y: 0, z: 0 }, 0).found).toBe(false);
    expect(sampleWaterSurface(flat, normalizeWaterBody({}, "global"), { x: 100000, y: -1, z: -100000 }, 0)).toMatchObject({ found: true, height: 0 });
  });
  it("keeps wave height, wavelength, normals and current speed in world units when a volume moves or stretches", () => {
    const water = createDefaultWaterDefinition(), body = normalizeWaterBody({ width: 80, length: 80, flowSpeed: 2 }, "ocean");
    const moved = { ...identityTransform(), position: { x: 7, y: 0, z: -4 }, scale: { x: 8, y: -3, z: 0.5 } };
    for (const point of [{ x: 2, y: -1, z: 3 }, { x: 5, y: -1, z: -2 }]) {
      const before = sampleWaterSurface(water, body, point, 1.7);
      const after = sampleWaterSurface(water, body, point, 1.7, moved);
      expect(after.height).toBeCloseTo(before.height, 6);
      expect(after.normal.x).toBeCloseTo(before.normal.x, 6);
      expect(after.velocity).toEqual(before.velocity);
    }
  });
  it("keeps a scaled, translated lake bounded and reports signed immersion", () => {
    const body = normalizeWaterBody({ width: 10, length: 4 });
    const transform = { ...identityTransform(), position: { x: 20, y: 3, z: 10 }, scale: { x: 2, y: 1, z: 1 } };
    expect(sampleWaterSurface(flat, body, { x: 20, y: 2, z: 10 }, 0, transform)).toMatchObject({ found: true, height: 3, depth: 1 });
    expect(sampleWaterSurface(flat, body, { x: 20, y: 4, z: 10 }, 0, transform).depth).toBe(-1);
    expect(sampleWaterSurface(flat, body, { x: 29, y: 3, z: 11.5 }, 0, transform).found).toBe(false);
    expect(sampleWaterSurface(flat, { ...body, enabled: false }, { x: 20, y: 2, z: 10 }, 0, transform).found).toBe(false);
  });
  it("follows a river's centreline elevation and directed current without filling its bounding rectangle", () => {
    const body = normalizeWaterBody({ width: 2, flowSpeed: 3, points: [[0, 4, 0], [0, 2, 10], [10, 0, 10]] }, "river");
    expect(sampleWaterSurface(flat, body, { x: 0, y: 0, z: 5 }, 0)).toMatchObject({ found: true, height: 3, velocity: { x: 0, z: 3 } });
    expect(sampleWaterSurface(flat, body, { x: 5, y: 0, z: 10 }, 0)).toMatchObject({ found: true, height: 1, velocity: { x: 3, z: 0 } });
    expect(sampleWaterSurface(flat, body, { x: 5, y: 0, z: 5 }, 0).found).toBe(false);
  });
  it("reports normals and vertical velocity matching the moving surface", () => {
    const water = createDefaultWaterDefinition();
    const p = sampleWaterWaves(water, 2, 3, 1);
    const h = 0.0001;
    const dx = (sampleWaterWaves(water, 2 + h, 3, 1).height - sampleWaterWaves(water, 2 - h, 3, 1).height) / (2 * h);
    const dt = (sampleWaterWaves(water, 2, 3, 1 + h).height - sampleWaterWaves(water, 2, 3, 1 - h).height) / (2 * h);
    expect(-p.normal.x / p.normal.y).toBeCloseTo(dx, 5);
    expect(p.velocity).toBeCloseTo(dt, 5);
    expect(sampleWaterWaves(water, 2, 3, 1, 0)).toMatchObject({ height: 0, velocity: 0, normal: { y: 1 } });
  });
  it("intersects a tilted, mirrored river at the same world position as its rendered surface", () => {
    const body = normalizeWaterBody({ width: 4, points: [[0, 2, -10], [0, -2, 10]] }, "river");
    const [x, y, z, w] = eulerDegreesToQuaternion([12, 35, -8]);
    const transform = { position: { x: 20, y: 6, z: 10 }, rotation: { x, y, z, w }, scale: { x: -2, y: 1.5, z: 3 } };
    const local = { x: 0.5, y: -0.8, z: 4 };
    const rotated = quatRotateVector(transform.rotation, { x: local.x * -2, y: local.y * 1.5, z: local.z * 3 });
    const point = { x: rotated.x + 20, y: rotated.y + 6, z: rotated.z + 10 };
    const sample = sampleWaterSurface(flat, body, { ...point, y: point.y - 3 }, 0, transform);
    expect(sample.found).toBe(true);
    expect(sample.height).toBeCloseTo(point.y, 5);
    expect(sample.depth).toBeCloseTo(3, 5);
    const next = sampleWaterSurface(flat, body, { ...point, x: point.x + 0.001 }, 0, transform);
    expect(-sample.normal.x / sample.normal.y).toBeCloseTo((next.height - sample.height) / 0.001, 4);
  });
  it("bounds malformed asset inputs before they reach sampling and rendering", () => {
    const water = normalizeWaterDefinition({ style: "stylized", waveLength: 0, waveHeight: NaN, shallowColor: [-1, 4, 0.2], density: -20 });
    expect(water).toMatchObject({ style: "stylized", shallowColor: [0, 1, 0.2], density: 1 });
    expect(water.waveLength).toBeGreaterThan(0);
    expect(Number.isFinite(sampleWaterWaves(water, 1, 2, 3).height)).toBe(true);
  });
});
