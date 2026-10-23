import { describe, expect, it } from "vitest";
import { identityTransform } from "./math-rng";
import { eulerDegreesToQuaternion, quatRotateVector } from "./euler";
import {
  WATER_WAVE_INVERT_TOLERANCE, createDefaultWaterDefinition, createWaterWaveOutput, invertWaterWaves, normalizeWaterBody, normalizeWaterDefinition,
  sampleWaterSurface, sampleWaterWaves, waterBankFadeLength, waterBankGain, waterFootprint, waterHorizontalEnvelope, waterRiverCentreline,
  waterWaveEnvelope,
} from "./water";
import { evaluateWaterSpectrum, waterSpectrum } from "./water-spectrum";

const realistic = createDefaultWaterDefinition();
const storm = { ...realistic, waveHeight: 1.2, waveLength: 30, swellHeight: 0.6, swellLength: 90, steepness: 1 };

describe("Water surfaces", () => {
  const flat = { ...realistic, waveHeight: 0, swellHeight: 0 };
  it("bounds Ocean independently of the camera and reserves infinite coverage for Global Water Volume", () => {
    const ocean = normalizeWaterBody({ width: 20, length: 10 }, "ocean");
    expect(sampleWaterSurface(flat, ocean, { x: 9, y: -1, z: 4 }, 0)).toMatchObject({ found: true, edgeDistance: 1 });
    expect(sampleWaterSurface(flat, ocean, { x: 11, y: 0, z: 0 }, 0).found).toBe(false);
    expect(sampleWaterSurface(flat, normalizeWaterBody({}, "global"), { x: 100000, y: -1, z: -100000 }, 0)).toMatchObject({ found: true, height: 0 });
  });
  it("keeps wave height, wavelength, normals and current speed in world units when a volume moves or stretches", () => {
    const water = realistic, body = normalizeWaterBody({ width: 80, length: 80, flowSpeed: 2 }, "ocean");
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
  it("reports normals matching the moving surface, and a flat sea at Wave Scale 0", () => {
    for (const water of [realistic, storm]) {
      const p = sampleWaterWaves(water, 2, 3, 1.01), h = 0.0001;
      const dx = (sampleWaterWaves(water, 2 + h, 3, 1.01).height - sampleWaterWaves(water, 2 - h, 3, 1.01).height) / (2 * h);
      const dz = (sampleWaterWaves(water, 2, 3 + h, 1.01).height - sampleWaterWaves(water, 2, 3 - h, 1.01).height) / (2 * h);
      expect(-p.normal.x / p.normal.y).toBeCloseTo(dx, 5);
      expect(-p.normal.z / p.normal.y).toBeCloseTo(dz, 5);
    }
    const still = sampleWaterWaves(realistic, 2, 3, 1, 0);
    expect([Math.abs(still.height), Math.abs(still.velocity), still.normal.y]).toEqual([0, 0, 1]);
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
  it("loads assets saved with the removed Toon look or wave model as Painted, keeping their colours and waves", () => {
    const toon = normalizeWaterDefinition({ style: "stylized", stylizedLook: "toon", shallowColor: [0.2, 0.86, 0.9], waveHeight: 2, waveModel: "ocean", rippleStrength: 0.4, choppiness: 0.7 });
    expect(toon).toEqual({ ...createDefaultWaterDefinition("stylized"), shallowColor: [0.2, 0.86, 0.9], waveHeight: 2 });
    expect(normalizeWaterDefinition({ style: "stylized", colorBands: 5, sparkles: 0.2 })).toMatchObject({ colorBands: 5, sparkles: 0.2 });
  });
  it("bounds malformed asset inputs before they reach sampling and rendering", () => {
    const water = normalizeWaterDefinition({ style: "stylized", waveLength: 0, waveHeight: NaN, shallowColor: [-1, 4, 0.2], density: -20 });
    expect(water).toMatchObject({ style: "stylized", shallowColor: [0, 1, 0.2], density: 1 });
    expect(water.waveLength).toBeGreaterThan(0);
    expect(Number.isFinite(sampleWaterWaves(water, 1, 2, 3).height)).toBe(true);
  });
  it("fills the wave and render-only fields from the style and bounds authored values", () => {
    // Assets saved before these fields existed take their own style's defaults, like Surface Foam.
    for (const style of ["realistic", "stylized"] as const) {
      const defaults = createDefaultWaterDefinition(style);
      expect(normalizeWaterDefinition({ style, waveHeight: 0.5 })).toMatchObject({
        steepness: defaults.steepness, peakSharpness: 3.3, waveSeed: 0, detailWaves: defaults.detailWaves, swellHeight: defaults.swellHeight,
        refraction: defaults.refraction, objectReflections: defaults.objectReflections, colorVariation: defaults.colorVariation,
      });
    }
    expect(normalizeWaterDefinition({ steepness: 4, peakSharpness: 0, waveSeed: 70000.4, detailWaves: -1, refraction: 2, objectReflections: "yes", colorVariation: NaN }))
      .toMatchObject({ steepness: 1, peakSharpness: 1, waveSeed: 65535, detailWaves: 0, refraction: 1, objectReflections: true, colorVariation: 0.5 });
    // Wave lengths span a puddle's ripples to an ocean's long swell.
    expect(normalizeWaterDefinition({ waveLength: 0.01, swellLength: 9000 })).toMatchObject({ waveLength: 0.1, swellLength: 2000 });
    expect(normalizeWaterDefinition({ waveLength: 5000 }).waveLength).toBe(2000);
  });
  it("moves water only up and down at Steepness 0, exactly as the spectrum's height field", () => {
    const out = createWaterWaveOutput(), body = normalizeWaterBody({ width: 400, length: 400 }, "ocean");
    for (const water of [{ ...realistic, steepness: 0 }, { ...storm, steepness: 0, waveSpread: 0.9 }]) {
      for (const [x, z, time] of [[31.5, -12, 4.25], [-140.5, 77.25, 312.8]] as const) {
        evaluateWaterSpectrum(waterSpectrum(water), x, z, time, out, 1, 1, 0, 0);
        const sample = sampleWaterSurface(water, body, { x, y: 0, z }, time);
        expect(sample.height).toBe(out[0]);
        expect(sample.velocity.y).toBe(out[8]);
        expect(Math.hypot(sample.velocity.x, sample.velocity.z)).toBe(0);
      }
    }
  });
  it("finds the displaced rest point again and reports derivatives matching the moving Gerstner surface", () => {
    const out = createWaterWaveOutput(), ahead = createWaterWaveOutput(), behind = createWaterWaveOutput();
    for (const water of [realistic, storm]) {
      const spectrum = waterSpectrum(water), h = 1e-4;
      expect(spectrum.choppiness).toBeGreaterThan(0);
      for (const [x, z, time] of [[2, 3, 1.01], [-17.3, 41.9, 120.41], [5.5, -8.25, 7.76]] as const) {
        // The rest point carries the offset that lands exactly on the queried world X/Z.
        invertWaterWaves(spectrum, x, z, time, out);
        expect(Math.hypot(out[11]! + out[1]! - x, out[12]! + out[2]! - z)).toBeLessThanOrEqual(WATER_WAVE_INVERT_TOLERANCE);
        // Forward derivatives at the rest point: offsets and height in x0 and z0.
        const [x0, z0] = [out[11]!, out[12]!];
        const forward = (px: number, pz: number, into: Float64Array) => evaluateWaterSpectrum(spectrum, px, pz, time, into, 1, 1, 0, 0);
        forward(x0 + h, z0, ahead); forward(x0 - h, z0, behind);
        expect(out[5]! - 1).toBeCloseTo((ahead[1]! - behind[1]!) / (2 * h), 5);
        expect(out[13]!).toBeCloseTo((ahead[2]! - behind[2]!) / (2 * h), 5);
        expect(out[3]!).toBeCloseTo((ahead[0]! - behind[0]!) / (2 * h), 5);
        forward(x0, z0 + h, ahead); forward(x0, z0 - h, behind);
        expect(out[6]!).toBeCloseTo((ahead[1]! - behind[1]!) / (2 * h), 5);
        expect(out[7]! - 1).toBeCloseTo((ahead[2]! - behind[2]!) / (2 * h), 5);
        expect(out[4]!).toBeCloseTo((ahead[0]! - behind[0]!) / (2 * h), 5);
        // The Eulerian surface: its slope is the normal.
        const p = sampleWaterWaves(water, x, z, time);
        const dx = (sampleWaterWaves(water, x + h, z, time).height - sampleWaterWaves(water, x - h, z, time).height) / (2 * h);
        const dz = (sampleWaterWaves(water, x, z + h, time).height - sampleWaterWaves(water, x, z - h, time).height) / (2 * h);
        expect(-p.normal.x / p.normal.y).toBeCloseTo(dx, 4);
        expect(-p.normal.z / p.normal.y).toBeCloseTo(dz, 4);
        expect(p.orbital).toEqual({ x: out[9], z: out[10] });
      }
    }
  });
  it("matches a tilted volume's displaced surface and moves its water with the orbital velocity", () => {
    const body = normalizeWaterBody({ width: 4, points: [[0, 2, -10], [0, -2, 10]] }, "river");
    const water = { ...storm, waveHeight: 0.4, waveLength: 9, swellHeight: 0 };
    const [x, y, z, w] = eulerDegreesToQuaternion([12, 35, -8]);
    const transform = { position: { x: 20, y: 6, z: 10 }, rotation: { x, y, z, w }, scale: { x: -2, y: 1.5, z: 3 } };
    const rotated = quatRotateVector(transform.rotation, { x: 0.5 * -2, y: -0.8 * 1.5, z: 4 * 3 });
    const rest = { x: rotated.x + 20, y: rotated.y + 6, z: rotated.z + 10 };
    // The renderer displaces this rest point forward; the query must invert back to it from the displaced X/Z.
    const out = createWaterWaveOutput();
    evaluateWaterSpectrum(waterSpectrum(water), rest.x, rest.z, 2.51, out, body.waveScale, 1, 0, 0);
    expect(Math.hypot(out[1]!, out[2]!)).toBeGreaterThan(0.01);
    const surface = { x: rest.x + out[1]!, y: rest.y + out[0]!, z: rest.z + out[2]! };
    const sample = sampleWaterSurface(water, body, { ...surface, y: surface.y - 2 }, 2.51, transform);
    expect(sample.found).toBe(true);
    expect(sample.height).toBeCloseTo(surface.y, 6);
    expect(sample.depth).toBeCloseTo(2, 6);
    const h = 1e-4, next = sampleWaterSurface(water, body, { ...surface, x: surface.x + h }, 2.51, transform);
    expect(-sample.normal.x / sample.normal.y).toBeCloseTo((next.height - sample.height) / h, 3);
    // Current plus orbital motion horizontally.
    const current = sampleWaterSurface({ ...water, waveHeight: 0 }, body, surface, 2.51, transform).velocity;
    expect(sample.velocity.x).toBeCloseTo(current.x + out[9]!, 6);
    expect(sample.velocity.z).toBeCloseTo(current.z + out[10]!, 6);
  });
  it("keeps every sampled wave inside the vertical and horizontal envelopes", () => {
    const out = createWaterWaveOutput();
    for (const water of [realistic, createDefaultWaterDefinition("stylized"), storm, { ...storm, peakSharpness: 7 }]) {
      for (const scale of [0.35, 1, 3]) {
        const spectrum = waterSpectrum(water), vertical = waterWaveEnvelope(water, scale), horizontal = waterHorizontalEnvelope(water, scale);
        let highest = 0, widest = 0;
        // Moments outer, so each synthesized frame serves a hundred points.
        for (let t = 0; t < 40; t++) for (let i = 0; i < 100; i++) {
          evaluateWaterSpectrum(spectrum, (i * 7.31) % 97 - 48, (i * 3.17 + t * 11.3) % 89 - 44, t * 1.73, out, scale, 1, 0, 0);
          highest = Math.max(highest, Math.abs(out[0]!)); widest = Math.max(widest, Math.hypot(out[1]!, out[2]!));
        }
        expect(highest).toBeLessThanOrEqual(vertical);
        expect(highest).toBeGreaterThan(vertical * 0.25);
        expect(widest).toBeLessThanOrEqual(horizontal);
      }
    }
    expect(waterHorizontalEnvelope({ ...storm, steepness: 0 })).toBe(0);
  });
  it("fades the horizontal motion to the bank of finite bodies, so edges stay put and queries match the faded surface", () => {
    const out = createWaterWaveOutput(), plain = createWaterWaveOutput(), gain = new Float64Array(2);
    const bodies = [normalizeWaterBody({ width: 40, length: 30 }, "ocean"), normalizeWaterBody({ width: 30, length: 20, waveScale: 1 }, "lake")];
    for (const water of [{ ...realistic, steepness: 1 }, storm]) for (const body of bodies) {
      const spectrum = waterSpectrum(water), fade = waterBankFadeLength(water, body.waveScale);
      expect(fade).toBeGreaterThan(waterHorizontalEnvelope(water, body.waveScale));
      let near = 0;
      // Moments outer, so each synthesized frame serves many points.
      for (let i = 0; i < 3000; i++) {
        const x0 = Math.sin(i * 12.9898) * 25, z0 = Math.cos(i * 78.233) * 25, time = Math.floor(i / 100) * 0.31;
        const rest = waterFootprint(body, x0, z0);
        if (!rest.inside) continue;
        // The renderer's forward map: the gain at the vertex's bank, with its gradient pointing inward.
        waterBankGain(rest.edge, fade, gain);
        evaluateWaterSpectrum(spectrum, x0, z0, time, out, body.waveScale, gain[0]!, -rest.edgeX * gain[1]!, -rest.edgeZ * gain[1]!);
        evaluateWaterSpectrum(spectrum, x0, z0, time, plain, body.waveScale, 1, 0, 0);
        const reach = Math.hypot(out[1]!, out[2]!);
        if (rest.edge >= fade) expect(reach).toBeCloseTo(Math.hypot(plain[1]!, plain[2]!), 12);
        else near++;
        // Displaced water never leaves the rest footprint, and its edge stays on the bank.
        expect(reach).toBeLessThan(Math.max(rest.edge, 1e-9));
        const sample = sampleWaterSurface(water, body, { x: x0 + out[1]!, y: -4, z: z0 + out[2]! }, time);
        expect(sample.found).toBe(true);
        expect(sample.height).toBeCloseTo(out[0]!, 4);
      }
      expect(near).toBeGreaterThan(50);
      // Just outside a bank there is no water, even where unfaded waves would have carried it.
      expect(sampleWaterSurface(water, body, { x: body.width / 2 + 0.01, y: -1, z: 0 }, 1.5).found).toBe(false);
    }
  });
  it("sharpens crests and widens troughs as Steepness rises", () => {
    const body = normalizeWaterBody({}, "global");
    // One heading and no swell, so only the Gerstner motion shapes the crests.
    const profile = (steepness: number) => {
      const water = { ...realistic, waveSpread: 0, swellHeight: 0, waveDirection: 0, steepness };
      // Three moments along one 300 m line, so no single alignment of the waves decides it.
      let above = 0, steepest = 0;
      for (const time of [3.1, 9.7, 17.3]) for (let i = 0; i < 6000; i++) {
        const sample = sampleWaterSurface(water, body, { x: i * 0.05, y: -2, z: 1.3 }, time);
        if (sample.height > 0) above++;
        steepest = Math.max(steepest, Math.abs(sample.normal.x / sample.normal.y));
      }
      return { above: above / 18000, steepest };
    };
    const rounded = profile(0), sharp = profile(1);
    // Water gathers under narrower, steeper crests: the surface spends clearly less of each wavelength above its mean.
    expect(rounded.above).toBeGreaterThan(0.45);
    expect(sharp.above).toBeLessThan(rounded.above - 0.05);
    expect(sharp.steepest).toBeGreaterThan(rounded.steepest * 1.3);
  });
});

describe("Spectrum water", () => {
  const body = normalizeWaterBody({ width: 4000, length: 4000 }, "ocean");

  it("answers a query from its position and time alone, whatever was asked before", () => {
    const at = (x: number, z: number, t: number) => sampleWaterSurface(realistic, body, { x, y: 0, z }, t);
    const first = at(13, -7, 41.37);
    at(-300, 800, 9000);
    at(13, -7, 41.4);
    expect(at(13, -7, 41.37)).toEqual(first);
  });

  it("rises and falls with the spectrum's height, and its long waves carry most of it", () => {
    const sigma = (realistic.waveHeight ** 2 + realistic.swellHeight ** 2) ** 0.5 / 2;
    let sum = 0, squares = 0, count = 0;
    for (let x = -200; x < 200; x += 7.3) for (let z = -200; z < 200; z += 6.1) {
      const height = sampleWaterSurface(realistic, body, { x, y: 0, z }, 12).height;
      sum += height; squares += height * height; count++;
    }
    const mean = sum / count, rms = Math.sqrt(squares / count - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.15 * sigma);
    expect(rms).toBeGreaterThan(0.7 * sigma);
    expect(rms).toBeLessThan(1.1 * sigma);
  });

  it("reports a vertical velocity that matches how its height changes", () => {
    const at = (t: number) => sampleWaterSurface(realistic, body, { x: 21, y: 0, z: 34 }, t);
    for (const t of [3, 50.2, 700.9]) {
      const step = 1 / 30, numeric = (at(t + step).height - at(t - step).height) / (2 * step);
      expect(at(t).velocity.y).toBeCloseTo(numeric, 1);
    }
  });

  it("makes longer waves from a longer Wave Length and a longer swell", () => {
    const crossings = (water: typeof realistic) => {
      let count = 0, previous = 0;
      for (let x = 0; x < 600; x += 0.5) {
        const height = sampleWaterSurface(water, body, { x, y: 0, z: 0 }, 5).height;
        if (x > 0 && Math.sign(height) !== Math.sign(previous)) count++;
        previous = height;
      }
      return count;
    };
    const short = { ...realistic, waveLength: 8, swellHeight: 0 }, long = { ...realistic, waveLength: 60, swellHeight: 0.4, swellLength: 160 };
    expect(crossings(long)).toBeLessThan(crossings(short) / 3);
  });
});
