import { describe, expect, it } from "vitest";
import {
  createDefaultWaterDefinition, createSeededRng, normalizeWaterDefinition, waterWaveSet, type WaterDefinition, type WaterWaveSet,
} from "@babylonslate/core";
import {
  WATER_FFT_CASCADE_TURNS, WATER_FFT_PERIOD, waterFftBandVariance, waterFftCycle, waterFftInitialSpectrum, waterFftInverse, waterFftLayout,
  waterFftSpectrumBuild, waterFftSynthesize, type WaterFftLayout,
} from "./water-fft-spectrum";

const TAU = 2 * Math.PI;
const water = (patch: Partial<WaterDefinition> = {}) => normalizeWaterDefinition({ ...createDefaultWaterDefinition(), ...patch });

/** Direct O(N⁴) inverse DFT of one atlas segment, both complex pairs of every RGBA texel. */
function inverseDft(input: Float64Array, width: number, size: number, segment: number): Float64Array {
  const out = new Float64Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4;
    for (let v = 0; v < size; v++) for (let u = 0; u < size; u++) {
      const angle = TAU * (u * x + v * y) / size, c = Math.cos(angle), s = Math.sin(angle);
      const i = (v * width + segment * size + u) * 4;
      for (let pair = 0; pair < 4; pair += 2) {
        out[o + pair] += input[i + pair]! * c - input[i + pair + 1]! * s;
        out[o + pair + 1] += input[i + pair]! * s + input[i + pair + 1]! * c;
      }
    }
  }
  return out;
}

const maxDifference = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
};

/**
 * Each mode as its own travelling wave, independent of the packed transform: a mode k with h0(k) adds
 * 2·Re(F(k)·h0(k)·e^{i(k·x − θ)}) to a field whose spectral factor is F (1 for H, i·k̂ for D, i·k for ∇H, …).
 */
function travellingWaves(spectrum: Float32Array, layout: WaterFftLayout, cycle: number): Float64Array[] {
  const { size, cascades, amplitude } = layout, width = size * cascades;
  const layers = Array.from({ length: 2 * cascades }, () => new Float64Array(size * size * 4));
  for (let cascade = 0; cascade < cascades; cascade++) {
    const patch = layout.patchSizes[cascade]!, scale = TAU / patch;
    for (let my = 0; my < size; my++) for (let mx = 0; mx < size; mx++) {
      const i = (my * width + cascade * size + mx) * 4, re = spectrum[i]!, im = spectrum[i + 1]!;
      if (re === 0 && im === 0) continue;
      const kx = (mx < size / 2 ? mx : mx - size) * scale, kz = (my < size / 2 ? my : my - size) * scale, kl = Math.hypot(kx, kz);
      const theta = TAU * (spectrum[i + 2]! * cycle - Math.floor(spectrum[i + 2]! * cycle));
      // [real factor, imaginary factor] of F for each output channel, in output packing order.
      const factors: [number, number][][] = [
        [[0, kx / kl], [1, 0], [0, kz / kl], [-kx * kz / kl, 0]],
        [[0, kx], [0, kz], [-kx * kx / kl, 0], [-kz * kz / kl, 0]],
      ];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const phase = kx * x * patch / size + kz * y * patch / size - theta, c = Math.cos(phase), s = Math.sin(phase);
        const wre = re * c - im * s, wim = re * s + im * c; // h0·e^{i·phase}
        for (let half = 0; half < 2; half++) for (let channel = 0; channel < 4; channel++) {
          const [fr, fi] = factors[half]![channel]!;
          layers[2 * cascade + half]![(y * size + x) * 4 + channel] += 2 * amplitude * (fr * wre - fi * wim);
        }
      }
    }
  }
  return layers;
}

describe("FFT ocean spectrum and CPU reference", () => {
  it("runs the GPU's Stockham pass sequence to the natural-order inverse DFT of every atlas segment", () => {
    for (const [size, segments] of [[8, 2], [16, 4]] as const) {
      const rng = createSeededRng(size);
      const work = Float64Array.from({ length: segments * size * size * 4 }, () => rng.nextFloat() * 2 - 1);
      const expected = Array.from({ length: segments }, (_, segment) => inverseDft(work, segments * size, size, segment));
      const layers = waterFftInverse(work.slice(), size, segments);
      expect(layers).toHaveLength(segments);
      for (let segment = 0; segment < segments; segment++) expect(maxDifference(layers[segment]!, expected[segment]!)).toBeLessThan(1e-9);
    }
  });

  it("synthesizes real height, Gerstner offset, slope and Jacobian fields that travel downwind like the analytic swell", () => {
    const set = waterWaveSet(water({ waveDirection: 25, waveSpread: 0.6, waveSeed: 9, waveLength: 30, waveSpeed: 1.3 }));
    const layout = waterFftLayout(set, 16, 2);
    const spectrum = waterFftInitialSpectrum(set, layout);
    for (const time of [0, 3.7, 1000.25]) {
      const cycle = waterFftCycle(time, layout.timeScale);
      const layers = waterFftSynthesize(spectrum, layout, cycle), expected = travellingWaves(spectrum, layout, cycle);
      for (let layer = 0; layer < layers.length; layer++) {
        let magnitude = 0;
        for (const value of expected[layer]!) magnitude = Math.max(magnitude, Math.abs(value));
        expect(magnitude).toBeGreaterThan(0);
        expect(maxDifference(layers[layer]!, expected[layer]!)).toBeLessThan(magnitude * 1e-9);
      }
    }
    // Every mode runs at the deep-water frequency √(g|k|) · Wave Speed of its physical wavenumber (quantized below
    // 0.2%), so Wave Length and Wave Speed act through the layout alone.
    let modes = 0;
    for (let cascade = 0; cascade < layout.cascades; cascade++) {
      const scale = TAU / layout.patchSizes[cascade]!;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const i = (y * 32 + cascade * 16 + x) * 4;
        if (spectrum[i] === 0 && spectrum[i + 1] === 0) continue;
        const k = Math.hypot(x < 8 ? x : x - 16, y < 8 ? y : y - 16) * scale;
        const omega = spectrum[i + 2]! * TAU / WATER_FFT_PERIOD * layout.timeScale;
        expect(Math.abs(omega / (Math.sqrt(9.81 * k) * 1.3) - 1)).toBeLessThan(0.002);
        modes++;
      }
    }
    expect(modes).toBeGreaterThan(20);
    // The band repeats after exactly one period, so the GPU phase never needs large arguments.
    const period = WATER_FFT_PERIOD / layout.timeScale;
    const start = waterFftSynthesize(spectrum, layout, waterFftCycle(12.5, layout.timeScale));
    const later = waterFftSynthesize(spectrum, layout, waterFftCycle(12.5 + 7 * period, layout.timeScale));
    expect(maxDifference(start[0]!, later[0]!)).toBeLessThan(1e-9);
  });

  it("holds the core density's variance above the analytic cutoff, downwind, and nothing below it", () => {
    for (const waveModel of ["classic", "ocean"] as const) {
      const definition = water({ waveModel, waveDirection: 40, waveSpread: 0.2 });
      const set = waterWaveSet(definition);
      expect(waterFftLayout(set, 64, 2).bandEdges[0]).toBe(set.cutoffK);
      let ratio = 0, outOfBand = 0;
      // Energy-weighted heading sums per cascade, in its texture frame and turned back to the world.
      const texel = [[0, 0], [0, 0]], world = [[0, 0], [0, 0]];
      const seeds = 24;
      for (let seed = 0; seed < seeds; seed++) {
        const seeded = waterWaveSet(water({ waveModel, waveDirection: 40, waveSpread: 0.2, waveSeed: seed * 101 + 7 }));
        const layout = waterFftLayout(seeded, 64, 2), spectrum = waterFftInitialSpectrum(seeded, layout);
        const layers = waterFftSynthesize(spectrum, layout, waterFftCycle(seed * 1.3, layout.timeScale));
        for (let cascade = 0; cascade < layout.cascades; cascade++) {
          const scale = TAU / layout.patchSizes[cascade]!, low = layout.bandEdges[cascade]!, high = layout.bandEdges[cascade + 1]!;
          const cos = Math.cos(WATER_FFT_CASCADE_TURNS[cascade]!), sin = Math.sin(WATER_FFT_CASCADE_TURNS[cascade]!);
          for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
            const i = (y * 64 * layout.cascades + cascade * 64 + x) * 4, power = spectrum[i]! ** 2 + spectrum[i + 1]! ** 2;
            const kx = (x < 32 ? x : x - 64) * scale, kz = (y < 32 ? y : y - 64) * scale, k = Math.hypot(kx, kz);
            // Inside the cascade's own band only, so neither the analytic band nor another cascade counts twice.
            if ((k < low * (1 - 1e-9) || k >= high * (1 + 1e-9)) && power !== 0) outOfBand++;
            if (k > 0) {
              texel[cascade]![0] += power * kx / k; texel[cascade]![1] += power * kz / k;
              world[cascade]![0] += power * (cos * kx - sin * kz) / k; world[cascade]![1] += power * (sin * kx + cos * kz) / k;
            }
          }
          let variance = 0;
          const height = layers[2 * cascade]!;
          for (let i = 1; i < height.length; i += 4) variance += height[i]! ** 2;
          ratio += variance / (64 * 64) / waterFftBandVariance(seeded, low, high) / layout.cascades;
        }
      }
      expect(outOfBand).toBe(0);
      // Realized height variance matches ∫S(k)dk over the bands (averaged over seeds and cascades).
      expect(ratio / seeds).toBeGreaterThan(0.85);
      expect(ratio / seeds).toBeLessThan(1.15);
      // Each cascade's texture frame is turned by its own angle, so the cascades' patches tile along different axes;
      // turned back to the world, every cascade's energy-weighted mean heading is the asset's Wave Direction.
      const degrees = ([x, z]: number[]) => Math.atan2(z!, x!) * 180 / Math.PI;
      expect(degrees(texel[1]!) - degrees(texel[0]!)).toBeCloseTo(-WATER_FFT_CASCADE_TURNS[1] * 180 / Math.PI, -1);
      for (const sums of world) expect(degrees(sums)).toBeCloseTo(40, -1);
    }
  });

  it("splits the same band more finely, on larger patches, with three cascades than with two", () => {
    for (const waveLength of [3, 12, 80]) {
      const set = waterWaveSet(water({ waveLength }));
      const high = waterFftLayout(set, 128, 2), ultra = waterFftLayout(set, 256, 3);
      // Both run from the analytic cutoff to the same shortest wavelength: a third cascade adds no ripples that only a
      // footprint within arm's length would resolve.
      expect(ultra.bandEdges[0]).toBe(high.bandEdges[0]);
      expect(ultra.bandEdges[3]! / high.bandEdges[2]! - 1).toBeCloseTo(0, 9);
      // Instead each cascade is narrower, so a consumer fading a cascade by its shortest wavelength keeps the band's
      // longer waves at footprints and mesh spacings where High's wide first cascade is gone, and the patches carrying
      // the same waves are twice as large, so they repeat half as often.
      expect(ultra.bandEdges[1]! / ultra.bandEdges[0]!).toBeLessThan(high.bandEdges[1]! / high.bandEdges[0]! / 2);
      expect(ultra.bandEdges[2]! / high.bandEdges[1]! - 1).toBeCloseTo(0, 9);
      expect(ultra.patchSizes[0]! / high.patchSizes[0]!).toBeCloseTo(2, 9);
      expect(ultra.patchSizes[2]! / high.patchSizes[1]!).toBeCloseTo(2, 9);
    }
    // The drawn spectrum follows that split: every mode inside its own cascade's band, each band holding its share of
    // the density's variance (phase-averaged, over seeds).
    let ratio = 0;
    const seeds = 8;
    for (let seed = 0; seed < seeds; seed++) {
      const set = waterWaveSet(water({ waveDirection: 40, waveSpread: 0.2, waveSeed: seed * 37 + 5 }));
      const layout = waterFftLayout(set, 64, 3), spectrum = waterFftInitialSpectrum(set, layout);
      for (let cascade = 0; cascade < 3; cascade++) {
        const scale = TAU / layout.patchSizes[cascade]!, low = layout.bandEdges[cascade]!, high = layout.bandEdges[cascade + 1]!;
        let variance = 0;
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
          const i = (y * 64 * 3 + cascade * 64 + x) * 4, power = spectrum[i]! ** 2 + spectrum[i + 1]! ** 2;
          const k = Math.hypot((x < 32 ? x : x - 64) * scale, (y < 32 ? y : y - 64) * scale);
          if (k < low * (1 - 1e-9) || k >= high * (1 + 1e-9)) expect(power).toBe(0);
          variance += 2 * layout.amplitude ** 2 * power;
        }
        ratio += variance / waterFftBandVariance(set, low, high) / 3;
      }
    }
    expect(ratio / seeds).toBeGreaterThan(0.85);
    expect(ratio / seeds).toBeLessThan(1.15);
  });

  it("serves every Wave Height, Wave Length and Wave Speed from one unit spectrum scaled by the layout", () => {
    const asset = { waveModel: "ocean" as const, waveDirection: 40, waveSpread: 0.2, waveSeed: 11 };
    const base = waterFftLayout(waterWaveSet(water(asset)), 64, 2);
    const spectrum = waterFftInitialSpectrum(waterWaveSet(water(asset)), base);
    /** Phase-averaged variance the layout gives each cascade over the physical density's variance in its band. */
    const bandRatios = (set: WaterWaveSet, layout: WaterFftLayout) => Array.from({ length: layout.cascades }, (_, cascade) => {
      let sum = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const i = (y * 128 + cascade * 64 + x) * 4;
        sum += 2 * layout.amplitude ** 2 * (spectrum[i]! ** 2 + spectrum[i + 1]! ** 2);
      }
      return sum / waterFftBandVariance(set, layout.bandEdges[cascade]!, layout.bandEdges[cascade + 1]!);
    });
    const expected = bandRatios(waterWaveSet(water(asset)), base);
    for (const variant of [{ waveHeight: 2.6, waveLength: 41, waveSpeed: 0.4 }, { waveHeight: 0.3, waveLength: 5 }, { waveModel: "classic" as const, peakSharpness: 3.3 }]) {
      const set = waterWaveSet(water({ ...asset, ...variant })), layout = waterFftLayout(set, 64, 2);
      expect(layout.spectrumKey).toBe(base.spectrumKey);
      expect(layout.key).not.toBe(base.key);
      expect(layout.bandEdges[0]).toBe(set.cutoffK);
      const ratios = bandRatios(set, layout);
      for (let cascade = 0; cascade < 2; cascade++) expect(ratios[cascade]! / expected[cascade]! - 1).toBeCloseTo(0, 9);
    }
  });

  it("draws the same spectrum for the same asset however the build is stepped, and a different one for another Wave Seed", () => {
    const layout = waterFftLayout(waterWaveSet(water({ waveSeed: 3 })), 32, 3);
    const first = waterFftInitialSpectrum(waterWaveSet(water({ waveSeed: 3 })), layout);
    expect(waterFftInitialSpectrum(waterWaveSet(water({ waveSeed: 3 })), layout)).toEqual(first);
    // Drawn three rows per step (resuming mid-cascade and mid-draw), it needs every step and matches bit for bit.
    const build = waterFftSpectrumBuild(waterWaveSet(water({ waveSeed: 3 })), layout);
    let steps = 1;
    while (!build.step(3 * 32)) steps++;
    expect(steps).toBe(Math.ceil(2 * 3 * 32 / 3));
    expect(build.data).toEqual(first);
    const other = waterFftLayout(waterWaveSet(water({ waveSeed: 4 })), 32, 3);
    expect(other.spectrumKey).not.toBe(layout.spectrumKey);
    expect(maxDifference(waterFftInitialSpectrum(waterWaveSet(water({ waveSeed: 4 })), other), first)).toBeGreaterThan(0);
  });
});
