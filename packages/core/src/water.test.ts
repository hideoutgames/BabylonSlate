import { describe, expect, it } from "vitest";
import { identityTransform } from "./math-rng";
import { eulerDegreesToQuaternion, quatRotateVector } from "./euler";
import {
  WATER_CREST_MEAN, WATER_CREST_RANGE, WATER_JACOBIAN_FLOOR, WATER_WAVE_SHADER_STRIDE, createDefaultWaterDefinition, createWaterWaveOutput,
  evaluateWaterWaves, invertWaterWaves, normalizeWaterBody, normalizeWaterDefinition, sampleWaterSurface, sampleWaterWaves,
  waterHorizontalEnvelope, waterRiverCentreline, waterWaveComponents, waterWaveDrift, waterWaveEnvelope, waterWaveQ, waterWaveSet,
  waterWaveShaderConstants, type WaterDefinition,
} from "./water";

/** The vertical-only kernel as it was before Gerstner waves: the Steepness 0 reference. */
function legacyWaves(water: WaterDefinition, x: number, z: number, time: number, scale = 1, spacing = 0) {
  const angle = water.waveDirection * Math.PI / 180;
  let height = 0, dx = 0, dz = 0, velocity = 0;
  for (const [turn, frequency, amplitude, phase] of waterWaveComponents) {
    const k = 2 * Math.PI * frequency / water.waveLength;
    const heading = angle + turn * water.waveSpread * 2;
    const ax = Math.cos(heading), az = Math.sin(heading);
    const omega = Math.sqrt(9.81 * k) * water.waveSpeed;
    const filter = Math.max(0, Math.min(1, 2 - spacing * frequency * 4 / water.waveLength));
    const a = water.waveHeight * scale * amplitude * filter * filter * (3 - 2 * filter);
    const p = k * (ax * x + az * z) - omega * time + phase;
    const sin = Math.sin(p), cos = Math.cos(p), crest = Math.exp(sin - 1);
    const value = sin + ((crest - WATER_CREST_MEAN) / WATER_CREST_RANGE - sin) * water.choppiness;
    const slope = cos + (crest * cos / WATER_CREST_RANGE - cos) * water.choppiness;
    height += a * value; dx += a * k * ax * slope; dz += a * k * az * slope; velocity -= a * omega * slope;
  }
  const n = Math.hypot(dx, 1, dz);
  return { height, normal: { x: -dx / n, y: 1 / n, z: -dz / n }, velocity };
}

const storm = { ...createDefaultWaterDefinition(), waveHeight: 1.2, waveLength: 22, choppiness: 0.8, steepness: 1 };
const ocean = { ...createDefaultWaterDefinition(), waveModel: "ocean" as const, waveSeed: 1234, steepness: 0.8, waveSpread: 0.6 };

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
    const body = normalizeWaterBody({ width: 2, flowSpeed: 3, curvature: 0, points: [[0, 4, 0], [0, 2, 10], [10, 0, 10]] }, "river");
    expect(sampleWaterSurface(flat, body, { x: 0, y: 0, z: 5 }, 0)).toMatchObject({ found: true, height: 3, velocity: { x: 0, z: 3 } });
    expect(sampleWaterSurface(flat, body, { x: 5, y: 0, z: 10 }, 0)).toMatchObject({ found: true, height: 1, velocity: { x: 3, z: 0 } });
    expect(sampleWaterSurface(flat, body, { x: 5, y: 0, z: 5 }, 0).found).toBe(false);
  });
  it("curves a river through its control points and narrows or widens it at each point", () => {
    const points: [number, number, number][] = [[0, 0, 0], [0, 0, 10], [10, 0, 10]];
    const curved = normalizeWaterBody({ width: 2, points, widthScales: [1, 1, 4] }, "river");
    const line = waterRiverCentreline(curved);
    // Every control point stays on the path, while the first reach bows away from its straight chord.
    for (const [x, , z] of points) expect(line.some((p) => Math.hypot(p.x - x, p.z - z) < 1e-9)).toBe(true);
    const straight = { ...curved, curvature: 0 };
    expect(sampleWaterSurface(flat, curved, { x: 0.9, y: -1, z: 7 }, 0).found).toBe(false);
    expect(sampleWaterSurface(flat, curved, { x: -1.5, y: -1, z: 7 }, 0).found).toBe(true);
    expect(sampleWaterSurface(flat, straight, { x: 0.9, y: -1, z: 7 }, 0).found).toBe(true);
    expect(sampleWaterSurface(flat, straight, { x: -1.5, y: -1, z: 7 }, 0).found).toBe(false);
    // The downstream point is four times as wide as Width.
    expect(sampleWaterSurface(flat, curved, { x: 10, y: -1, z: 13.5 }, 0).found).toBe(true);
    expect(sampleWaterSurface(flat, curved, { x: 1.5, y: -1, z: 1 }, 0).found).toBe(false);
    expect(normalizeWaterBody({ points, widthScales: [2, "x"] }, "river").widthScales).toEqual([2, 1, 1]);
  });
  it("keeps river elevation and width linear while shared spline sampling bends its footprint", () => {
    const body = normalizeWaterBody({ width: 4, points: [[0, 9, 0], [0, 3, 10], [10, 0, 10]], widthScales: [1, 2, 4] }, "river");
    const line = waterRiverCentreline(body);
    const halfway = line.find((point) => point.y === 6)!;
    expect(halfway.x).toBeCloseTo(-0.625, 10);
    expect(halfway.z).toBeCloseTo(5.625, 10);
    expect(halfway.halfWidth).toBe(3);
    expect(line.at(-1)).toEqual({ x: 10, y: 0, z: 10, halfWidth: 8 });
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
  it("fills Surface Foam and Subsurface from the chosen style and clamps authored values", () => {
    // Assets saved before these properties existed take the defaults of their own style.
    const legacyStylized = normalizeWaterDefinition({ style: "stylized", foamAmount: 0.5 });
    const legacyRealistic = normalizeWaterDefinition({ foamAmount: 0.5 });
    expect(legacyStylized).toMatchObject({ surfaceFoam: createDefaultWaterDefinition("stylized").surfaceFoam, subsurface: createDefaultWaterDefinition("stylized").subsurface });
    expect(legacyRealistic).toMatchObject({ surfaceFoam: createDefaultWaterDefinition().surfaceFoam, subsurface: createDefaultWaterDefinition().subsurface });
    expect(normalizeWaterDefinition({ surfaceFoam: 3, subsurface: -1 })).toMatchObject({ surfaceFoam: 1, subsurface: 0 });
    expect(normalizeWaterDefinition({ surfaceFoam: 0.25, subsurface: 5 })).toMatchObject({ surfaceFoam: 0.25, subsurface: 2 });
    expect(normalizeWaterDefinition({ surfaceFoam: "lots", subsurface: NaN })).toMatchObject({ surfaceFoam: createDefaultWaterDefinition().surfaceFoam, subsurface: createDefaultWaterDefinition().subsurface });
  });
  it("bounds malformed asset inputs before they reach sampling and rendering", () => {
    const water = normalizeWaterDefinition({ style: "stylized", waveLength: 0, waveHeight: NaN, shallowColor: [-1, 4, 0.2], density: -20 });
    expect(water).toMatchObject({ style: "stylized", shallowColor: [0, 1, 0.2], density: 1 });
    expect(water.waveLength).toBeGreaterThan(0);
    expect(Number.isFinite(sampleWaterWaves(water, 1, 2, 3).height)).toBe(true);
  });
  it("fills Gerstner, Ocean Spectrum and render-only fields from the style and bounds authored values", () => {
    // Assets saved before these fields existed take their own style's defaults, like Surface Foam.
    for (const style of ["realistic", "stylized"] as const) {
      const defaults = createDefaultWaterDefinition(style);
      expect(normalizeWaterDefinition({ style, waveHeight: 0.5 })).toMatchObject({
        steepness: defaults.steepness, waveModel: "classic", peakSharpness: 3.3, waveSeed: 0, detailWaves: defaults.detailWaves,
        refraction: defaults.refraction, objectReflections: defaults.objectReflections, colorVariation: defaults.colorVariation,
      });
    }
    expect(normalizeWaterDefinition({ steepness: 4, waveModel: "fft", peakSharpness: 0, waveSeed: 70000.4, detailWaves: -1, refraction: 2, objectReflections: "yes", colorVariation: NaN }))
      .toMatchObject({ steepness: 1, waveModel: "classic", peakSharpness: 1, waveSeed: 65535, detailWaves: 0, refraction: 1, objectReflections: true, colorVariation: 0.5 });
    expect(normalizeWaterDefinition({ style: "stylized", waveModel: "ocean", waveSeed: 12.6, objectReflections: true }))
      .toMatchObject({ waveModel: "ocean", waveSeed: 13, objectReflections: true });
  });
  it("reproduces the vertical-only waves exactly at Steepness 0", () => {
    for (const water of [{ ...createDefaultWaterDefinition(), steepness: 0 }, { ...storm, steepness: 0, waveSpread: 0.9 }]) {
      for (const [x, z, time, scale, spacing] of [[2, 3, 1, 1, 0], [-140.5, 77.25, 312.8, 0.35, 0], [9, -4, 6.5, 1.7, 2.5]] as const) {
        const { height, normal, velocity } = sampleWaterWaves(water, x, z, time, scale, spacing);
        expect({ height, normal, velocity }).toEqual(legacyWaves(water, x, z, time, scale, spacing));
      }
      // A level surface at the origin adds exactly the legacy height and height rate.
      const body = normalizeWaterBody({ width: 400, length: 400 }, "ocean");
      const sample = sampleWaterSurface(water, body, { x: 31.5, y: 0, z: -12 }, 4.25);
      const legacy = legacyWaves(water, 31.5, -12, 4.25);
      expect(sample.height).toBe(legacy.height);
      expect(sample.velocity.y).toBe(legacy.velocity);
      expect(Math.hypot(sample.velocity.x, sample.velocity.z)).toBe(0);
    }
  });
  it("finds the displaced rest point again and reports derivatives matching the moving Gerstner surface", () => {
    const out = createWaterWaveOutput(), ahead = createWaterWaveOutput(), behind = createWaterWaveOutput();
    for (const water of [createDefaultWaterDefinition(), storm, ocean]) {
      const set = waterWaveSet(water), h = 1e-4;
      expect(waterWaveQ(set)).toBeGreaterThan(0);
      for (const [x, z, time] of [[2, 3, 1], [-17.3, 41.9, 120.4], [5.5, -8.25, 7.75]] as const) {
        // The rest point carries the offset that lands exactly on the queried world X/Z.
        invertWaterWaves(set, x, z, time, 0, out);
        expect(out[11]! + out[1]!).toBeCloseTo(x, 9);
        expect(out[12]! + out[2]!).toBeCloseTo(z, 9);
        // Forward derivatives at the rest point: offsets in x0 (Jacobian), height in x0 and offsets in time.
        const [x0, z0] = [out[11]!, out[12]!];
        evaluateWaterWaves(set, x0 + h, z0, time, 0, ahead); evaluateWaterWaves(set, x0 - h, z0, time, 0, behind);
        expect(out[5]! - 1).toBeCloseTo((ahead[1]! - behind[1]!) / (2 * h), 6);
        expect(out[6]!).toBeCloseTo((ahead[2]! - behind[2]!) / (2 * h), 6);
        expect(out[3]!).toBeCloseTo((ahead[0]! - behind[0]!) / (2 * h), 6);
        evaluateWaterWaves(set, x0, z0, time + h, 0, ahead); evaluateWaterWaves(set, x0, z0, time - h, 0, behind);
        expect(out[9]!).toBeCloseTo((ahead[1]! - behind[1]!) / (2 * h), 6);
        expect(out[10]!).toBeCloseTo((ahead[2]! - behind[2]!) / (2 * h), 6);
        // The Eulerian surface: its slope is the normal and its height rate at a fixed X/Z is the vertical velocity.
        const p = sampleWaterWaves(water, x, z, time);
        const dx = (sampleWaterWaves(water, x + h, z, time).height - sampleWaterWaves(water, x - h, z, time).height) / (2 * h);
        const dz = (sampleWaterWaves(water, x, z + h, time).height - sampleWaterWaves(water, x, z - h, time).height) / (2 * h);
        const dt = (sampleWaterWaves(water, x, z, time + h).height - sampleWaterWaves(water, x, z, time - h).height) / (2 * h);
        expect(-p.normal.x / p.normal.y).toBeCloseTo(dx, 5);
        expect(-p.normal.z / p.normal.y).toBeCloseTo(dz, 5);
        expect(p.velocity).toBeCloseTo(dt, 5);
        expect(p.orbital).toEqual({ x: out[9], z: out[10] });
      }
    }
  });
  it("matches a tilted volume's displaced surface and moves its water with the orbital velocity", () => {
    const body = normalizeWaterBody({ width: 4, points: [[0, 2, -10], [0, -2, 10]] }, "river");
    const water = { ...storm, waveHeight: 0.4, waveLength: 9 };
    const [x, y, z, w] = eulerDegreesToQuaternion([12, 35, -8]);
    const transform = { position: { x: 20, y: 6, z: 10 }, rotation: { x, y, z, w }, scale: { x: -2, y: 1.5, z: 3 } };
    const rotated = quatRotateVector(transform.rotation, { x: 0.5 * -2, y: -0.8 * 1.5, z: 4 * 3 });
    const rest = { x: rotated.x + 20, y: rotated.y + 6, z: rotated.z + 10 };
    // The renderer displaces this rest point forward; the query must invert back to it from the displaced X/Z.
    const out = createWaterWaveOutput();
    evaluateWaterWaves(waterWaveSet(water), rest.x, rest.z, 2.5, 0, out, body.waveScale);
    expect(Math.hypot(out[1]!, out[2]!)).toBeGreaterThan(0.01);
    const surface = { x: rest.x + out[1]!, y: rest.y + out[0]!, z: rest.z + out[2]! };
    const sample = sampleWaterSurface(water, body, { ...surface, y: surface.y - 2 }, 2.5, transform);
    expect(sample.found).toBe(true);
    expect(sample.height).toBeCloseTo(surface.y, 6);
    expect(sample.depth).toBeCloseTo(2, 6);
    const h = 1e-4, next = sampleWaterSurface(water, body, { ...surface, x: surface.x + h }, 2.5, transform);
    expect(-sample.normal.x / sample.normal.y).toBeCloseTo((next.height - sample.height) / h, 3);
    const later = sampleWaterSurface(water, body, surface, 2.5 + h, transform), earlier = sampleWaterSurface(water, body, surface, 2.5 - h, transform);
    // Current plus orbital motion and its mean drift horizontally; the Eulerian height rate vertically.
    const current = sampleWaterSurface({ ...water, waveHeight: 0 }, body, surface, 2.5, transform).velocity;
    const drift = waterWaveDrift(waterWaveSet(water), body.waveScale, { x: 0, z: 0 });
    expect(sample.velocity.x).toBeCloseTo(current.x + out[9]! + drift.x, 6);
    expect(sample.velocity.z).toBeCloseTo(current.z + out[10]! + drift.z, 6);
    expect(sample.velocity.y - current.y).toBeCloseTo((later.height - earlier.height) / (2 * h), 4);
  });
  it("rocks water back and forth at a fixed point without a net horizontal push", () => {
    const body = normalizeWaterBody({}, "global");
    for (const water of [createDefaultWaterDefinition(), storm, ocean]) {
      let x = 0, z = 0, swing = 0;
      const samples = 20000;
      for (let i = 0; i < samples; i++) {
        const { velocity } = sampleWaterSurface(water, body, { x: 3.5, y: -1, z: -2 }, i * 0.0731);
        x += velocity.x / samples; z += velocity.z / samples; swing = Math.max(swing, Math.hypot(velocity.x, velocity.z));
      }
      // Orbital speeds reach about a metre per second, yet they average out under a stationary support.
      expect(swing).toBeGreaterThan(0.3);
      expect(Math.hypot(x, z)).toBeLessThan(swing * 0.01);
    }
  });
  it("draws a deterministic Ocean Spectrum with the Classic significant height", () => {
    const significant = (water: WaterDefinition) => {
      const set = waterWaveSet(water);
      return 4 * Math.sqrt(Array.from(set.amplitude).reduce((sum, a) => sum + (a * water.waveHeight) ** 2, 0) / 2);
    };
    const first = waterWaveSet(ocean), again = waterWaveSet({ ...ocean });
    expect(again).not.toBe(first);
    for (const key of ["k", "omega", "dirX", "dirZ", "amplitude", "phase"] as const) expect(again[key]).toEqual(first[key]);
    expect(waterWaveSet({ ...ocean, waveSeed: 1235 }).phase).not.toEqual(first.phase);
    expect(first.count).toBe(8);
    // Switching models at the same Wave Height keeps the sea's significant height (about 1.69 × Wave Height).
    expect(significant(ocean)).toBeCloseTo(significant({ ...ocean, waveModel: "classic" }), 10);
    expect(significant(ocean) / ocean.waveHeight).toBeCloseTo(1.695, 2);
    // Wave Length is the peak: components span the analytic band below the render-only detail cutoff.
    for (const k of first.k) expect(k / first.peakK).toBeGreaterThan(0.69);
    for (const k of first.k) expect(k).toBeLessThan(first.cutoffK);
    // Wave Spread 0 is a single heading along Wave Direction, as with Classic.
    const heading = ocean.waveDirection * Math.PI / 180, single = waterWaveSet({ ...ocean, waveSpread: 0 });
    for (let i = 0; i < single.count; i++) expect(Math.atan2(single.dirZ[i]!, single.dirX[i]!)).toBeCloseTo(heading, 12);
  });
  it("keeps every sampled wave inside the vertical and horizontal envelopes without folding", () => {
    const out = createWaterWaveOutput();
    for (const water of [createDefaultWaterDefinition(), createDefaultWaterDefinition("stylized"), storm, ocean, { ...ocean, peakSharpness: 7, choppiness: 1, steepness: 1 }]) {
      for (const scale of [0.35, 1, 3]) {
        const set = waterWaveSet(water), vertical = waterWaveEnvelope(water, scale), horizontal = waterHorizontalEnvelope(water, scale);
        let highest = 0, widest = 0, flattest = Infinity;
        for (let i = 0; i < 4000; i++) {
          evaluateWaterWaves(set, (i * 7.31) % 97 - 48, (i * 3.17) % 89 - 44, i * 0.173, 0, out, scale);
          highest = Math.max(highest, Math.abs(out[0]!)); widest = Math.max(widest, Math.hypot(out[1]!, out[2]!));
          flattest = Math.min(flattest, out[5]! * out[7]! - out[6]! * out[6]!);
        }
        expect(highest).toBeLessThanOrEqual(vertical);
        expect(highest).toBeGreaterThan(vertical * 0.25);
        expect(widest).toBeLessThanOrEqual(horizontal);
        expect(flattest).toBeGreaterThanOrEqual(WATER_JACOBIAN_FLOOR);
      }
    }
    expect(waterHorizontalEnvelope({ ...storm, steepness: 0 })).toBe(0);
  });
  it("writes shader constants whose float64 phase offsets reproduce the world-space phase far from the origin", () => {
    const set = waterWaveSet(ocean), constants = new Float64Array(set.count * WATER_WAVE_SHADER_STRIDE);
    const origin = { x: 81234.5, z: -40321.25 }, time = 98765.4, scale = 0.6;
    expect(waterWaveShaderConstants(set, scale, origin.x, origin.z, time, constants)).toBe(set.count);
    const q = waterWaveQ(set, scale), local = { x: 3.25, z: -1.5 }, world = { x: origin.x + local.x, z: origin.z + local.z };
    for (let i = 0; i < set.count; i++) {
      const c = constants.subarray(i * WATER_WAVE_SHADER_STRIDE);
      expect(c[5]!).toBeGreaterThanOrEqual(0);
      expect(c[5]!).toBeLessThan(2 * Math.PI);
      const shader = c[2]! * (c[0]! * local.x + c[1]! * local.z) + c[5]!;
      const direct = set.k[i]! * (set.dirX[i]! * world.x + set.dirZ[i]! * world.z) - set.omega[i]! * time + set.phase[i]!;
      expect(Math.sin(shader)).toBeCloseTo(Math.sin(direct), 6);
      expect(Math.cos(shader)).toBeCloseTo(Math.cos(direct), 6);
      expect(c[4]!).toBeCloseTo(ocean.waveHeight * scale * set.amplitude[i]!, 12);
      expect(c[6]!).toBeCloseTo(q * c[4]!, 12);
    }
  });
});
