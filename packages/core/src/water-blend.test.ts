import { describe, expect, it } from "vitest";
import { identityTransform } from "./math-rng";
import {
  createDefaultWaterDefinition, createWaterWaveOutput, invertWaterWaves, normalizeWaterBody, sampleWaterSurface, waterBankGain, waterWaveSet,
  type WaterBodyProperties, type WaterDefinition, type WaterKind,
} from "./water";
import { createWaterBlendSample, evaluateWaterBlend, sampleWaterBlend, WaterBlendIndex, type WaterBlendBody } from "./water-blend";
import { DEFAULT_WATER_BLEND_DISTANCE, normalizeWaterBlendDistance } from "./water-settings";
import { normalizeRenderProjectSettings } from "./project";

const calm = { ...createDefaultWaterDefinition(), waveHeight: 0 };
const body = (kind: WaterKind, props: Record<string, unknown>, x = 0, y = 0, z = 0, definition: WaterDefinition = calm): WaterBlendBody => {
  const transform = identityTransform();
  transform.position = { x, y, z };
  return { definition, body: normalizeWaterBody(props, kind), transform };
};
const lake = (x: number, width = 20, y = 0, definition?: WaterDefinition, props: Record<string, unknown> = {}) =>
  body("lake", { width, length: width, ...props }, x, y, 0, definition);

/** The answer the world gives at X/Z: the owning body's blended surface (`sampleWaterBlend` with ownership). */
function worldSample(index: WaterBlendIndex, x: number, z: number, time = 0) {
  const found = index.bodies.map((_, i) => sampleWaterBlend(index, i, { x, y: -1, z }, time)).filter((sample) => sample.found);
  return { count: found.length, sample: found[0] };
}

describe("Water Blend Distance setting", () => {
  it("defaults to 8 m, keeps 0 (off) and clamps, and travels with the render settings", () => {
    expect(normalizeWaterBlendDistance(undefined)).toBe(DEFAULT_WATER_BLEND_DISTANCE);
    expect(normalizeWaterBlendDistance(0)).toBe(0);
    expect(normalizeWaterBlendDistance(-3)).toBe(0);
    expect(normalizeWaterBlendDistance(1e6)).toBe(64);
    expect(normalizeRenderProjectSettings({}).water).toEqual({ blendDistance: 8 });
    expect(normalizeRenderProjectSettings({ water: { blendDistance: 2.5 } }).water).toEqual({ blendDistance: 2.5 });
  });
});

/**
 * The blended surface height the way queries once found it: the inversion's Gerstner gain read from the blend kernel at
 * every iterate (with central-difference gradients), then the kernel once at the converged rest point. Null where the
 * body has no water.
 */
function perStepBlendHeight(index: WaterBlendIndex, self: number, position: { x: number; y: number; z: number }, time: number): number | null {
  const me = index.bodies[self]!, set = waterWaveSet(me.definition), scale = me.referenceScale;
  const sample = createWaterBlendSample(), fade = new Float64Array(2), wave = createWaterWaveOutput();
  const gainAt = (x: number, z: number) => {
    if (!evaluateWaterBlend(index, self, x, position.y, z, sample)) return 0;
    waterBankGain(sample.union, me.fadeLength * sample.offsetScale, fade);
    return fade[0]! * sample.offsetScale;
  };
  const h = 0.05;
  invertWaterWaves(set, position.x, position.z, time, 0, wave, scale, {
    sample(x, z, out) {
      out[0] = gainAt(x, z);
      out[1] = (gainAt(x + h, z) - gainAt(x - h, z)) / (2 * h);
      out[2] = (gainAt(x, z + h) - gainAt(x, z - h)) / (2 * h);
    },
  });
  if (!evaluateWaterBlend(index, self, wave[11]!, position.y, wave[12]!, sample) || sample.union < 0) return null;
  return sample.restHeight + sample.heightScale * wave[0]!;
}

describe("Water blend index", () => {
  it("pairs bodies within the distance at compatible heights and rebuilds only when an input changes", () => {
    const index = new WaterBlendIndex();
    const bodies = [lake(0), lake(25), lake(70), lake(0, 20, 30), body("global", {}, 0, 0, 0)];
    expect(index.update(bodies, 8)).toBe(true);
    // 5 m apart: neighbours. 25 m apart: not. 30 m above: not. The ocean pairs with every body at its level.
    expect(index.neighbours(0)).toEqual([1, 4]);
    expect(index.neighbours(2)).toEqual([4]);
    expect(index.neighbours(3)).toEqual([]);
    expect(index.neighbours(4)).toEqual([0, 1, 2]);
    expect(index.update(bodies, 8)).toBe(false);
    bodies[1]!.transform.position.x = 40;
    expect(index.update(bodies, 8)).toBe(true);
    expect(index.neighbours(0)).toEqual([4]);
    // A body moving into reach of a differently coloured one (only poses changed) gets fresh matches for its new list.
    bodies[2]!.definition = { ...calm, shallowColor: [0.1, 0.7, 0.3] };
    expect(index.update(bodies, 8)).toBe(true);
    bodies[2]!.transform.position.x = 52;
    expect(index.update(bodies, 8)).toBe(true);
    expect(index.neighbours(1)).toEqual([2, 4]);
    expect([index.colorsMatch(1, 0), index.colorsMatch(1, 1), index.wavesMatch(1, 0)]).toEqual([false, true, true]);
    expect(index.update(bodies, 0)).toBe(true);
    expect(bodies.map((_, i) => index.neighbours(i).length)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("Water blend surface", () => {
  it("lets exactly one body answer across two overlapping lakes, with one shared rest height and wave scale", () => {
    const definition = createDefaultWaterDefinition();
    const index = new WaterBlendIndex();
    index.update([lake(0, 20, 0, definition, { waveScale: 0.2 }), lake(14, 20, 0.6, definition, { waveScale: 0.8 })], 8);
    const a = createWaterBlendSample(), b = createWaterBlendSample();
    for (let x = 4.5; x <= 9.5; x += 0.25) {
      expect(evaluateWaterBlend(index, 0, x, 0, 0, a) && evaluateWaterBlend(index, 1, x, 0, 0, b)).toBe(true);
      // Shares sum to one and both bodies agree on the blended surface.
      expect(a.weight + b.weight).toBeCloseTo(1, 12);
      expect(a.restHeight).toBeCloseTo(b.restHeight, 12);
      expect(a.heightScale * 0.2).toBeCloseTo(b.heightScale * 0.8, 12);
      expect(a.union).toBeCloseTo(b.union, 12);
      // Neither edge inside the overlap is a shore.
      expect(a.union).toBeGreaterThan(2);
      expect((a.margin >= 0 ? 1 : 0) + (b.margin >= 0 ? 1 : 0)).toBe(1);
    }
    // Far inside each lake its own surface is unchanged.
    expect(evaluateWaterBlend(index, 0, -6, 0, 0, a) && a.restHeight === 0 && a.heightScale === 1 && a.margin === 1).toBe(true);
  });

  it("keeps a river's current into a lake until its end, then hands over to the lake", () => {
    const index = new WaterBlendIndex();
    const river = body("river", { width: 6, flowSpeed: 2, points: [[0, 0, -40], [0, 0, 6]] });
    index.update([lake(0, 30, 0, calm), river], 8);
    const r = createWaterBlendSample(), l = createWaterBlendSample();
    // Inside the lake, along the river: the river owns its middle and carries nearly all of its current (a reach
    // narrower than the distance always shares a little with the lake); no shore at its end cap.
    evaluateWaterBlend(index, 1, 0, 0, -5, r);
    expect(r.margin).toBeGreaterThan(0.8);
    expect(r.flowZ).toBeGreaterThan(1.8);
    evaluateWaterBlend(index, 1, 0, 0, 5.5, r);
    expect(r.union).toBeGreaterThan(5);
    // Past the river's end the lake owns, and the current fades out across the blend.
    evaluateWaterBlend(index, 0, 0, 0, 10, l);
    expect(l.margin).toBeGreaterThan(0);
    expect(l.flowZ).toBeGreaterThan(0.3);
    expect(l.flowZ).toBeLessThan(1);
    evaluateWaterBlend(index, 0, 0, 0, 13.5, l);
    expect(l.flowZ).toBe(0);
    // Where the river crosses the lake's shore, the lake has no shore under it.
    evaluateWaterBlend(index, 0, 0, 0, -14.9, l);
    expect(l.union).toBeGreaterThan(1);
  });

  it("lets a lake take over from Global Water Volume inside its footprint and draw nothing of the ocean there", () => {
    const index = new WaterBlendIndex();
    index.update([body("global", {}), lake(0, 20, 0.2)], 8);
    const ocean = createWaterBlendSample(), inner = createWaterBlendSample();
    evaluateWaterBlend(index, 0, 0, 0, 0, ocean); evaluateWaterBlend(index, 1, 0, 0, 0, inner);
    expect([ocean.margin < 0, inner.margin > 0, inner.restHeight]).toEqual([true, true, 0.2]);
    // At the lake's edge the two meet halfway; outside its reach the ocean is untouched.
    evaluateWaterBlend(index, 0, 10, 0, 0, ocean);
    expect(ocean.restHeight).toBeCloseTo(0.1, 6);
    evaluateWaterBlend(index, 0, 14.5, 0, 0, ocean);
    expect([ocean.restHeight, ocean.margin]).toEqual([0, 1]);
  });

  it("calms bodies with different swells toward their seam, so they meet flat and continuous", () => {
    const long = { ...createDefaultWaterDefinition(), waveLength: 30 };
    const index = new WaterBlendIndex();
    index.update([lake(0, 20, 0, createDefaultWaterDefinition()), lake(16, 20, 0, long)], 8);
    const a = createWaterBlendSample(), b = createWaterBlendSample();
    evaluateWaterBlend(index, 0, 8, 0, 0, a); evaluateWaterBlend(index, 1, 8, 0, 0, b);
    expect(a.weight).toBeCloseTo(0.5, 9);
    expect([a.heightScale, b.heightScale, a.offsetScale, b.offsetScale].map((v) => Math.abs(v) < 1e-9)).toEqual([true, true, true, true]);
    evaluateWaterBlend(index, 0, -2, 0, 0, a);
    expect(a.heightScale).toBe(1);
  });

  it("fills a gap narrower than the distance with water, and leaves it dry when blending is off", () => {
    const bodies = [lake(0, 20), lake(23, 20)];
    const index = new WaterBlendIndex();
    index.update(bodies, 8);
    expect(worldSample(index, 11.5, 0).count).toBe(1);
    expect(worldSample(index, 11.5, 3).count).toBe(1);
    index.update(bodies, 0);
    expect(worldSample(index, 11.5, 0).count).toBe(0);
  });

  it("answers queries with one continuous surface across a seam between lakes of different Wave Scale", () => {
    const definition = { ...createDefaultWaterDefinition(), waveHeight: 0.3, waveLength: 16, steepness: 0.6 };
    const index = new WaterBlendIndex();
    index.update([lake(0, 24, 0, definition, { waveScale: 0.3 }), lake(18, 24, 0.4, definition, { waveScale: 1 })], 8);
    for (const time of [0.3, 2.1, 5.7]) {
      let previous: number | null = null, steepest = 0;
      for (let x = -4; x <= 22; x += 0.1) {
        const { count, sample } = worldSample(index, x, 1.3, time);
        expect(count).toBe(1);
        if (previous !== null) steepest = Math.max(steepest, Math.abs(sample!.height - previous) / 0.1);
        previous = sample!.height;
      }
      // The waves' own slopes stay under 1; a step between surfaces would read as a slope of metres per decimetre.
      expect(steepest).toBeLessThan(1);
    }
  });

  it("agrees with the per-step inversion to well under a millimetre across seams of differing rest height and swell", () => {
    const definition = { ...createDefaultWaterDefinition(), waveHeight: 0.3, waveLength: 16, steepness: 0.6 };
    const scenarios: Array<{ bodies: WaterBlendBody[]; from: number; to: number }> = [
      { bodies: [lake(0, 24, 0, definition, { waveScale: 0.3 }), lake(18, 24, 0.4, definition, { waveScale: 1 })], from: -4, to: 22 },
      { bodies: [body("global", {}, 0, 0, 0, definition), lake(0, 20, 0.2, definition, { waveScale: 0.5 })], from: 0, to: 22 },
    ];
    for (const { bodies, from, to } of scenarios) {
      const index = new WaterBlendIndex();
      index.update(bodies, 8);
      let compared = 0, worst = 0;
      for (const time of [0.3, 2.1, 5.7]) {
        for (let x = from; x <= to; x += 0.05) {
          // The world still finds exactly one surface (the owner), however early the others give up.
          expect(worldSample(index, x, 1.3, time).count).toBe(1);
          for (let self = 0; self < bodies.length; self++) {
            const position = { x, y: -1, z: 1.3 };
            const fast = sampleWaterBlend(index, self, position, time, false), reference = perStepBlendHeight(index, self, position, time);
            expect(fast.found).toBe(reference !== null);
            if (reference === null) continue;
            worst = Math.max(worst, Math.abs(fast.height - reference));
            compared++;
          }
        }
      }
      expect(compared).toBeGreaterThan(1000);
      expect(worst).toBeLessThan(1e-4);
    }
  });

  it("leaves a body without neighbours on the unblended path", () => {
    const index = new WaterBlendIndex();
    const alone = lake(0, 20, 0, { ...createDefaultWaterDefinition(), steepness: 0.7 });
    index.update([alone, lake(80, 20)], 8);
    for (const [x, z] of [[0, 0], [8, 3], [-9.6, 0.4]] as const) {
      const position = { x, y: -0.5, z };
      expect(sampleWaterBlend(index, 0, position, 1.4)).toEqual(sampleWaterSurface(alone.definition, alone.body as WaterBodyProperties, position, 1.4, alone.transform));
    }
  });
});
