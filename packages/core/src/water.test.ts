import { describe, expect, it } from "vitest";
import { identityTransform } from "./math-rng";
import { createDefaultWaterDefinition, normalizeWaterBody, normalizeWaterDefinition, sampleWaterSurface, sampleWaterWaves } from "./water";

describe("Water surfaces", () => {
  const flat = { ...createDefaultWaterDefinition(), waveHeight: 0 };
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
  it("bounds malformed asset inputs before they reach sampling and rendering", () => {
    const water = normalizeWaterDefinition({ style: "stylized", waveLength: 0, waveHeight: NaN, shallowColor: [-1, 4, 0.2], density: -20 });
    expect(water).toMatchObject({ style: "stylized", shallowColor: [0, 1, 0.2], density: 1 });
    expect(water.waveLength).toBeGreaterThan(0);
    expect(Number.isFinite(sampleWaterWaves(water, 1, 2, 3).height)).toBe(true);
  });
});
