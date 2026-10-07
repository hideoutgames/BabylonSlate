import { describe, expect, it } from "vitest";
import { identityTransform } from "./math-rng";
import { eulerDegreesToQuaternion, quatRotateVector } from "./euler";
import {
  WATER_CREST_MEAN, WATER_CREST_RANGE, WATER_JACOBIAN_FLOOR, WATER_WAVE_INVERT_TOLERANCE, WATER_WAVE_SHADER_STRIDE, createDefaultWaterDefinition,
  createWaterWaveOutput, evaluateWaterWaves, invertWaterWaves, normalizeWaterBody, normalizeWaterDefinition, sampleWaterSurface, sampleWaterWaves,
  waterBankFadeLength, waterBankGain, waterFootprint, waterHorizontalEnvelope, waterOceanSpectrumDensity, waterRiverCentreline,
  waterSurfaceDrift, waterSwellWarp, waterSwellWarpShaderConstants, waterWaveComponents, waterWaveDrift, waterWaveEnvelope, waterWaveGroups, waterWaveQ,
  waterWaveSet, waterWaveShaderConstants, WATER_SWELL_WARP_STRIDE, type WaterDefinition,
} from "./water";

/**
 * The vertical-only kernel: the Classic table's plane waves, each riding its wave group (`waterWaveGroups`), summed at
 * the warped rest point u = x + W(x) (`waterSwellWarp`, W = Σ A·K̂·cos(K·x + φ)), their slope carried back through
 * ∂u/∂x. The Steepness 0 reference.
 */
function legacyWaves(water: WaterDefinition, x: number, z: number, time: number, scale = 1, spacing = 0) {
  const angle = water.waveDirection * Math.PI / 180;
  let wx = 0, wz = 0, wxx = 0, wxz = 0, wzz = 0;
  for (const [turn, frequency, amplitude, phase] of waterSwellWarp) {
    const ax = Math.cos(angle + turn), az = Math.sin(angle + turn);
    const k = 2 * Math.PI / water.waveLength * frequency, a = water.waveLength * amplitude;
    const p = k * (ax * x + az * z) + phase, cos = Math.cos(p), sin = a * k * Math.sin(p);
    wx += a * ax * cos; wz += a * az * cos;
    wxx -= sin * ax * ax; wxz -= sin * ax * az; wzz -= sin * az * az;
  }
  const ux = x + wx, uz = z + wz, reach = spacing * waterWaveSet(water).warpStretch * 4 / water.waveLength;
  let height = 0, dx = 0, dz = 0, velocity = 0;
  waterWaveComponents.forEach(([turn, frequency, amplitude, phase], i) => {
    const k = 2 * Math.PI * frequency / water.waveLength;
    const heading = angle + turn * water.waveSpread * 2;
    const ax = Math.cos(heading), az = Math.sin(heading);
    const omega = Math.sqrt(9.81 * k) * water.waveSpeed;
    const filter = Math.max(0, Math.min(1, 2 - reach * frequency));
    const a = water.waveHeight * scale * amplitude * filter * filter * (3 - 2 * filter);
    const p = k * (ax * ux + az * uz) - omega * time + phase;
    const sin = Math.sin(p), cos = Math.cos(p), crest = Math.exp(sin - 1);
    const value = sin + ((crest - WATER_CREST_MEAN) / WATER_CREST_RANGE - sin) * water.choppiness;
    const slope = cos + (crest * cos / WATER_CREST_RANGE - cos) * water.choppiness;
    // The component's wave group: an envelope travelling at the deep-water group velocity, turned off its heading.
    const [ratio, groupTurn, groupPhase, depth] = waterWaveGroups[i]!, envelope = ratio * k, norm = 1 / Math.sqrt(1 + 0.5 * depth * depth);
    const gx = envelope * Math.cos(heading + groupTurn), gz = envelope * Math.sin(heading + groupTurn);
    const groupOmega = envelope * Math.cos(groupTurn) * omega / (2 * k);
    const gp = gx * ux + gz * uz - groupOmega * time + groupPhase;
    const g = (1 + depth * Math.cos(gp)) * norm, gs = depth * norm * Math.sin(gp) * value;
    height += a * g * value; dx += a * (g * k * ax * slope - gs * gx); dz += a * (g * k * az * slope - gs * gz);
    velocity += a * (gs * groupOmega - g * omega * slope);
  });
  const sx = (1 + wxx) * dx + wxz * dz, sz = wxz * dx + (1 + wzz) * dz, n = Math.hypot(sx, 1, sz);
  return { height, normal: { x: -sx / n, y: 1 / n, z: -sz / n }, velocity };
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
  it("loads Stylized assets saved without a look as Painted with their stored values and fills Toon from its own defaults", () => {
    const legacy = normalizeWaterDefinition({ style: "stylized", shallowColor: [0.1, 0.78, 0.72], colorBands: 3 });
    expect(legacy).toMatchObject({ stylizedLook: "painted", shallowColor: [0.1, 0.78, 0.72], colorBands: 3, depthColorDistance: createDefaultWaterDefinition("stylized").depthColorDistance });
    expect(normalizeWaterDefinition({ style: "stylized", stylizedLook: "watercolor" }).stylizedLook).toBe("painted");
    expect(normalizeWaterDefinition({ style: "stylized", stylizedLook: "toon", waveHeight: 2 })).toEqual({ ...createDefaultWaterDefinition("stylized", "toon"), waveHeight: 2 });
    // Realistic ignores the look: its defaults never follow it.
    expect({ ...createDefaultWaterDefinition("realistic", "toon"), stylizedLook: "painted" }).toEqual(createDefaultWaterDefinition());
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
        expect(Math.hypot(out[11]! + out[1]! - x, out[12]! + out[2]! - z)).toBeLessThanOrEqual(WATER_WAVE_INVERT_TOLERANCE);
        // Forward derivatives at the rest point: offsets in x0 (Jacobian), height in x0 and offsets in time.
        const [x0, z0] = [out[11]!, out[12]!];
        evaluateWaterWaves(set, x0 + h, z0, time, 0, ahead); evaluateWaterWaves(set, x0 - h, z0, time, 0, behind);
        expect(out[5]! - 1).toBeCloseTo((ahead[1]! - behind[1]!) / (2 * h), 6);
        expect(out[13]!).toBeCloseTo((ahead[2]! - behind[2]!) / (2 * h), 6);
        expect(out[3]!).toBeCloseTo((ahead[0]! - behind[0]!) / (2 * h), 6);
        // The warp makes the Jacobian asymmetric: ∂x/∂z0 is checked on its own.
        evaluateWaterWaves(set, x0, z0 + h, time, 0, ahead); evaluateWaterWaves(set, x0, z0 - h, time, 0, behind);
        expect(out[6]!).toBeCloseTo((ahead[1]! - behind[1]!) / (2 * h), 6);
        expect(out[7]! - 1).toBeCloseTo((ahead[2]! - behind[2]!) / (2 * h), 6);
        expect(out[4]!).toBeCloseTo((ahead[0]! - behind[0]!) / (2 * h), 6);
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
    // The query's mean-drift term is that of its own world X/Z (the warp stretches the waves differently from place to place).
    const drift = waterWaveDrift(waterWaveSet(water), body.waveScale, { x: 0, z: 0 }, 0, surface.x, surface.z);
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
          flattest = Math.min(flattest, out[5]! * out[7]! - out[6]! * out[13]!);
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
    // The warp's constants reproduce its world-space displacement W = Σ A·K̂·cos(K·x + φ) from eye-relative points too.
    const warp = new Float64Array(waterSwellWarp.length * WATER_SWELL_WARP_STRIDE), angle = ocean.waveDirection * Math.PI / 180;
    waterSwellWarpShaderConstants(set, origin.x, origin.z, warp);
    let shaderX = 0, shaderZ = 0, directX = 0, directZ = 0;
    waterSwellWarp.forEach(([turn, frequency, amplitude, phase], t) => {
      const c = warp.subarray(t * WATER_SWELL_WARP_STRIDE);
      expect(c[3]!).toBeGreaterThanOrEqual(0);
      expect(c[3]!).toBeLessThan(2 * Math.PI);
      const cos = Math.cos(c[0]! * local.x + c[1]! * local.z + c[3]!);
      shaderX += c[0]! * c[2]! * cos; shaderZ += c[1]! * c[2]! * cos;
      const dirX = Math.cos(angle + turn), dirZ = Math.sin(angle + turn), k = 2 * Math.PI / ocean.waveLength * frequency;
      const direct = Math.cos(k * (dirX * world.x + dirZ * world.z) + phase) * ocean.waveLength * amplitude;
      directX += dirX * direct; directZ += dirZ * direct;
    });
    expect(shaderX).toBeCloseTo(directX, 6);
    expect(shaderZ).toBeCloseTo(directZ, 6);
  });
  it("gives both wave models one detail spectrum above the analytic swell, bounded by the envelope", () => {
    for (const model of ["classic", "ocean"] as const) {
      const water = { ...createDefaultWaterDefinition(), waveModel: model }, set = waterWaveSet(water);
      // Render-only detail starts above every analytic component, at the same cutoff for both models.
      expect(set.cutoffK / set.peakK).toBeCloseTo(4, 12);
      for (const k of set.k) expect(k).toBeLessThan(set.cutoffK);
      // The analytic band of the density carries the swell's variance (Σ A² / 2), so detail never double counts it.
      let variance = 0;
      for (let i = 0, steps = 4000; i < steps; i++) {
        const low = set.peakK * 0.7 * (4 / 0.7) ** (i / steps), high = set.peakK * 0.7 * (4 / 0.7) ** ((i + 1) / steps);
        variance += (high - low) * (waterOceanSpectrumDensity(set, low) + waterOceanSpectrumDensity(set, high)) / 2;
      }
      const swell = Array.from(set.amplitude).reduce((sum, a) => sum + (a * water.waveHeight) ** 2, 0) / 2;
      expect(variance / swell).toBeGreaterThan(model === "ocean" ? 0.85 : 0.999);
      expect(variance / swell).toBeLessThan(model === "ocean" ? 1.15 : 1.001);
      expect(waterOceanSpectrumDensity(set, set.cutoffK * 1.5)).toBeGreaterThan(0);
      // Detail Waves widens the vertical envelope by the detail band's significant height, for Classic too.
      expect(set.detailHeight).toBeGreaterThan(0);
      expect(waterWaveEnvelope(water, 2) - waterWaveEnvelope({ ...water, detailWaves: 0 }, 2)).toBeCloseTo(2 * set.detailHeight, 12);
    }
    // The same sea size gives nearly the same detail whichever model draws the swell.
    const classic = waterWaveSet(createDefaultWaterDefinition()), spectrum = waterWaveSet({ ...createDefaultWaterDefinition(), waveModel: "ocean" });
    expect(waterOceanSpectrumDensity(classic, classic.cutoffK * 2) / waterOceanSpectrumDensity(spectrum, spectrum.cutoffK * 2)).toBeCloseTo(1, 1);
  });
  it("fades the horizontal motion to the bank of finite bodies, so edges stay put and queries match the faded surface", () => {
    const out = createWaterWaveOutput(), plain = createWaterWaveOutput(), gain = new Float64Array(2);
    const bodies = [normalizeWaterBody({ width: 40, length: 30 }, "ocean"), normalizeWaterBody({ width: 30, length: 20, waveScale: 1 }, "lake")];
    for (const water of [{ ...createDefaultWaterDefinition(), steepness: 1 }, storm, ocean]) for (const body of bodies) {
      const set = waterWaveSet(water), fade = waterBankFadeLength(water, body.waveScale);
      expect(fade).toBeGreaterThan(waterHorizontalEnvelope(water, body.waveScale));
      let near = 0;
      for (let i = 0; i < 3000; i++) {
        const x0 = Math.sin(i * 12.9898) * 25, z0 = Math.cos(i * 78.233) * 25, time = (i % 97) * 0.31;
        const rest = waterFootprint(body, x0, z0);
        if (!rest.inside) continue;
        // The renderer's forward map: the gain at the vertex's bank, with its gradient pointing inward.
        waterBankGain(rest.edge, fade, gain);
        evaluateWaterWaves(set, x0, z0, time, 0, out, body.waveScale, gain[0]!, -rest.edgeX * gain[1]!, -rest.edgeZ * gain[1]!);
        evaluateWaterWaves(set, x0, z0, time, 0, plain, body.waveScale);
        const reach = Math.hypot(out[1]!, out[2]!);
        if (rest.edge >= fade) expect(reach).toBeCloseTo(Math.hypot(plain[1]!, plain[2]!), 12);
        else near++;
        // Displaced water never leaves the rest footprint, and its edge stays on the bank.
        expect(reach).toBeLessThan(Math.max(rest.edge, 1e-9));
        expect(out[5]! * out[7]! - out[6]! * out[13]!).toBeGreaterThan(0);
        const sample = sampleWaterSurface(water, body, { x: x0 + out[1]!, y: -4, z: z0 + out[2]! }, time);
        expect(sample.found).toBe(true);
        expect(sample.height).toBeCloseTo(out[0]!, 4);
      }
      expect(near).toBeGreaterThan(50);
      // Just outside a bank there is no water, even where unfaded waves would have carried it.
      expect(sampleWaterSurface(water, body, { x: body.width / 2 + 0.01, y: -1, z: 0 }, 1.5).found).toBe(false);
    }
  });
  it("sharpens crests and widens troughs as Steepness rises, for both wave models", () => {
    const body = normalizeWaterBody({}, "global");
    for (const waveModel of ["classic", "ocean"] as const) {
      // One heading and a rounded profile, so only the Gerstner motion shapes the crests.
      const profile = (steepness: number) => {
        const water = { ...createDefaultWaterDefinition(), waveSpread: 0, choppiness: 0, waveDirection: 0, waveModel, steepness };
        let above = 0, steepest = 0;
        for (let i = 0; i < 6000; i++) {
          const sample = sampleWaterSurface(water, body, { x: i * 0.05, y: -2, z: 1.3 }, 3.1);
          if (sample.height > 0) above++;
          steepest = Math.max(steepest, Math.abs(sample.normal.x / sample.normal.y));
        }
        return { above: above / 6000, steepest };
      };
      const rounded = profile(0), sharp = profile(1);
      // Water gathers under narrower, steeper crests: the surface spends clearly less of each wavelength above its mean
      // (the rounded sea's share along one 300 m line varies by a few percent around a half with the eight components).
      expect(rounded.above).toBeGreaterThan(0.45);
      expect(sharp.above).toBeLessThan(rounded.above - 0.05);
      expect(sharp.steepest).toBeGreaterThan(rounded.steepest * 1.25);
    }
  });
  it("re-weights the waves' mean drift for a drag-coupled support so it rocks in place at any coupling", () => {
    const body = normalizeWaterBody({}, "global"), fixed = { x: 0, z: 0 }, coupled = { x: 0, z: 0 };
    for (const water of [createDefaultWaterDefinition(), storm]) {
      const along = { x: Math.cos(water.waveDirection * Math.PI / 180), z: Math.sin(water.waveDirection * Math.PI / 180) };
      for (const rate of [1, 8, 30]) {
        const travel = (correct: boolean) => {
          let x = 0, z = 0, vx = 0, vz = 0;
          const dt = 1 / 60, seconds = 300;
          for (let i = 0; i < seconds / dt; i++) {
            // A support relaxing toward the queried water velocity, as buoyancy drag does.
            const sample = sampleWaterSurface(water, body, { x, y: -0.1, z }, i * dt);
            let ux = sample.velocity.x, uz = sample.velocity.z;
            if (correct) {
              waterSurfaceDrift(water, body, sample.edgeDistance, fixed, 0, x, z);
              waterSurfaceDrift(water, body, sample.edgeDistance, coupled, rate, x, z);
              ux += coupled.x - fixed.x; uz += coupled.z - fixed.z;
            }
            vx += (ux - vx) * Math.min(1, rate * dt); vz += (uz - vz) * Math.min(1, rate * dt);
            x += vx * dt; z += vz * dt;
          }
          return (x * along.x + z * along.z) / seconds;
        };
        // The fixed-point term alone carries well-coupled supports downwind; the coupled term leaves them in place.
        if (rate >= 8) expect(travel(false)).toBeGreaterThan(0.05);
        expect(Math.abs(travel(true))).toBeLessThan(0.015);
      }
    }
    expect(waterSurfaceDrift({ ...storm, steepness: 0 }, body, Infinity, fixed, 4)).toEqual({ x: 0, z: 0 });
  });
});
