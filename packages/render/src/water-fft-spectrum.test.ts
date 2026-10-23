import { describe, expect, it } from "vitest";
import {
  createDefaultWaterDefinition, createSeededRng, normalizeWaterDefinition, WATER_SPECTRUM_PERIOD, waterSpectrum, waterSpectrumDensity, type WaterDefinition,
} from "@haptic/core";
import {
  WATER_FFT_CASCADE_TURNS, waterFftCycle, waterFftInverse, waterFftSynthesize, waterSpectrumBuild, waterSpectrumInitial, waterSpectrumLayout,
  type WaterFftLayout,
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

  it("synthesizes real height, Gerstner offset, slope and Jacobian fields that travel downwind", () => {
    const spectrum = waterSpectrum(water({ waveDirection: 25, waveSpread: 0.6, waveSeed: 9, waveLength: 30, waveSpeed: 1.3 }));
    const layout = waterSpectrumLayout(spectrum, 16, 2), initial = waterSpectrumInitial(spectrum, layout);
    for (const time of [0, 3.7, 1000.25]) {
      const cycle = waterFftCycle(time, layout.timeScale);
      const layers = waterFftSynthesize(initial, layout, cycle), expected = travellingWaves(initial, layout, cycle);
      for (let layer = 0; layer < layers.length; layer++) {
        let magnitude = 0;
        for (const value of expected[layer]!) magnitude = Math.max(magnitude, Math.abs(value));
        expect(magnitude).toBeGreaterThan(0);
        expect(maxDifference(layers[layer]!, expected[layer]!)).toBeLessThan(magnitude * 1e-9);
      }
    }
    // Every mode runs at the deep-water frequency √(g|k|) · Wave Speed of its wavenumber, quantized to whole multiples of
    // 2π over the repeat period.
    let modes = 0;
    for (let cascade = 0; cascade < layout.cascades; cascade++) {
      const scale = TAU / layout.patchSizes[cascade]!;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const i = (y * 32 + cascade * 16 + x) * 4;
        if (initial[i] === 0 && initial[i + 1] === 0) continue;
        const k = Math.hypot(x < 8 ? x : x - 16, y < 8 ? y : y - 16) * scale;
        const omega = initial[i + 2]! * TAU / WATER_SPECTRUM_PERIOD * layout.timeScale;
        expect(Math.abs(omega - Math.sqrt(9.81 * k) * 1.3)).toBeLessThanOrEqual(Math.PI / WATER_SPECTRUM_PERIOD * 1.3 + 1e-12);
        modes++;
      }
    }
    expect(modes).toBeGreaterThan(20);
    // The sea repeats after exactly one period, so the GPU phase never needs large arguments.
    const period = WATER_SPECTRUM_PERIOD / layout.timeScale;
    const start = waterFftSynthesize(initial, layout, waterFftCycle(12.5, layout.timeScale));
    const later = waterFftSynthesize(initial, layout, waterFftCycle(12.5 + 7 * period, layout.timeScale));
    expect(maxDifference(start[0]!, later[0]!)).toBeLessThan(1e-9);
  });

  it("holds the spectrum's variance in each cascade's own band, downwind, whatever the cascade's turn", () => {
    let ratio = 0, outOfBand = 0;
    // Energy-weighted heading sums per cascade, in its texture frame and turned back to the world.
    const texel = [[0, 0], [0, 0]], world = [[0, 0], [0, 0]];
    const seeds = 16;
    for (let seed = 0; seed < seeds; seed++) {
      const spectrum = waterSpectrum(water({ waveDirection: 40, waveSpread: 0.2, swellHeight: 0, waveSeed: seed * 101 + 7 }));
      const layout = waterSpectrumLayout(spectrum, 64, 2), initial = waterSpectrumInitial(spectrum, layout);
      for (let cascade = 0; cascade < layout.cascades; cascade++) {
        const scale = TAU / layout.patchSizes[cascade]!, low = layout.bandEdges[cascade]!;
        const high = Math.min(layout.bandEdges[cascade + 1]!, layout.nyquist[cascade]!);
        const cos = Math.cos(WATER_FFT_CASCADE_TURNS[cascade]!), sin = Math.sin(WATER_FFT_CASCADE_TURNS[cascade]!);
        let drawn = 0, expected = 0;
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
          const i = (y * 64 * layout.cascades + cascade * 64 + x) * 4, power = initial[i]! ** 2 + initial[i + 1]! ** 2;
          const fx = (x < 32 ? x : x - 64) * scale, fz = (y < 32 ? y : y - 64) * scale, k = Math.hypot(fx, fz);
          const inBand = k >= low * (1 - 1e-9) && k < high * (1 + 1e-9) && k > 0;
          // Inside the cascade's own band only, so no wavenumber counts twice.
          if (!inBand && power !== 0) outOfBand++;
          if (!inBand) continue;
          // The mode's wavevector in world axes, R(θ)·k.
          const kx = cos * fx - sin * fz, kz = sin * fx + cos * fz;
          drawn += 2 * power; expected += waterSpectrumDensity(spectrum, kx, kz) * scale * scale;
          texel[cascade]![0] += power * fx / k; texel[cascade]![1] += power * fz / k;
          world[cascade]![0] += power * kx / k; world[cascade]![1] += power * kz / k;
        }
        ratio += drawn / expected / layout.cascades;
      }
    }
    expect(outOfBand).toBe(0);
    // Each mode's expected power is Ψ·Δk²/2 (a Hermitian pair holds it): averaged over seeds, the drawn variance matches.
    expect(ratio / seeds).toBeGreaterThan(0.85);
    expect(ratio / seeds).toBeLessThan(1.15);
    // Each cascade's texture frame is turned by its own angle, so the cascades' patches tile along different axes;
    // turned back to the world, every cascade's energy-weighted mean heading is the asset's Wave Direction.
    const degrees = ([x, z]: number[]) => Math.atan2(z!, x!) * 180 / Math.PI;
    expect(degrees(texel[1]!) - degrees(texel[0]!)).toBeCloseTo(-WATER_FFT_CASCADE_TURNS[1] * 180 / Math.PI, -1);
    for (const sums of world) expect(degrees(sums)).toBeCloseTo(40, -1);
  });

  it("keeps the stored spectrum for another Wave Speed and draws a new one for any other wave field", () => {
    const base = waterSpectrumLayout(waterSpectrum(water({ waveSeed: 11 })), 64, 2);
    const faster = waterSpectrumLayout(waterSpectrum(water({ waveSeed: 11, waveSpeed: 2 })), 64, 2);
    expect(faster.spectrumKey).toBe(base.spectrumKey);
    expect(faster.key).not.toBe(base.key);
    for (const variant of [{ waveHeight: 2.6 }, { waveLength: 41 }, { swellLength: 300 }, { detailWaves: 0.5 }]) {
      expect(waterSpectrumLayout(waterSpectrum(water({ waveSeed: 11, ...variant })), 64, 2).spectrumKey).not.toBe(base.spectrumKey);
    }
    // Quality's FFT Size and Cascades draw their own.
    expect(waterSpectrumLayout(waterSpectrum(water({ waveSeed: 11 })), 128, 2).spectrumKey).not.toBe(base.spectrumKey);
  });

  it("draws the same spectrum for the same asset however the build is stepped, and a different one for another Wave Seed", () => {
    const spectrum = waterSpectrum(water({ waveSeed: 3 })), layout = waterSpectrumLayout(spectrum, 32, 3);
    const first = waterSpectrumInitial(spectrum, layout);
    expect(waterSpectrumInitial(waterSpectrum(water({ waveSeed: 3 })), layout)).toEqual(first);
    // Drawn three rows per step (resuming mid-cascade), it needs every step and matches bit for bit.
    const build = waterSpectrumBuild(spectrum, layout);
    let steps = 1;
    while (!build.step(3 * 32)) steps++;
    expect(steps).toBe(Math.ceil(3 * 32 / 3));
    expect(build.data).toEqual(first);
    const other = waterSpectrum(water({ waveSeed: 4 })), otherLayout = waterSpectrumLayout(other, 32, 3);
    expect(otherLayout.spectrumKey).not.toBe(layout.spectrumKey);
    expect(maxDifference(waterSpectrumInitial(other, otherLayout), first)).toBeGreaterThan(0);
  });
});
