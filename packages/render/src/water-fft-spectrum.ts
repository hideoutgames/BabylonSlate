/**
 * Pure (Babylon-free) half of the FFT ocean detail band: cascade layout, the seeded initial spectrum h0(k), and a
 * CPU mirror of every GPU pass (time evolution and Stockham butterflies) used as the reference the browser proof and
 * unit tests compare against. `water-fft.ts` uploads the spectrum and runs the same passes on the GPU.
 *
 * Conventions shared with the analytic kernel (`evaluateWaterWaves`): world X is texel x, world Z is texel y, and a
 * mode with wavevector k travels along +k with phase k·x − ωt, ω = √(g|k|) · Wave Speed. Each mode's Gerstner offset
 * is D = i·k̂·h̃ (water gathers under crests, as `D = q·a·d·cos p` does for the analytic swell with q = 1).
 *
 * Unit spectrum: the stored h0 is the band at peak wavenumber 1 and density scale 1. In grid bins the band does not
 * depend on Wave Length, Wave Height or Wave Speed: the physical band is the stored one times `layout.amplitude`
 * (√(spectrumScale · peakK)), on patches `layout.patchSizes`, with phases advancing at `layout.timeScale`
 * (√peakK · Wave Speed). Editing those fields therefore reuses the stored spectrum; only Wave Direction, Wave Spread,
 * Peak Sharpness, Wave Seed and the Water quality's FFT Size / FFT Cascades draw a new one (`spectrumKey`).
 */
import { createSeededRng, waterOceanSpectrumDensity, type Rng, type WaterWaveSet } from "@babylonslate/core";

const TAU = 2 * Math.PI;
const GRAVITY = 9.81;

/**
 * Band clock units after which the band repeats exactly (`WATER_FFT_PERIOD / timeScale` seconds). Every unit mode's
 * frequency is a whole multiple of 2π / period (Tessendorf's frequency quantization, under 0.2% in every band), so the
 * GPU phase is 2π · fract(multiple · cycle) with cycle = fract(timeScale · t / period): no large-argument
 * trigonometry however long a session runs.
 */
export const WATER_FFT_PERIOD = 256;
/**
 * Patch size (and band) ratio between consecutive cascades: 3 + 2√2 is irrational, so cascades never repeat in step,
 * and below 8, so each cascade's band stays inside its grid.
 */
export const WATER_FFT_CASCADE_RATIO = 3 + 2 * Math.SQRT2;
/** Narrowest heading spread (Wave Spread units) of the detail band: short waves are never all parallel. */
export const WATER_FFT_MIN_SPREAD = 0.3;
/**
 * Grid texels one spectrum build step writes (whole rows): the water before-render observer advances a build by one
 * step per run, about a millisecond on desktop, so drawing a new spectrum never stalls a frame. 64²×1 builds in one
 * step, 128²×2 in 4 and 256²×3 in 24.
 */
export const WATER_FFT_BUILD_TEXELS = 16384;

export interface WaterFftLayout {
  /** Grid cells per side (power of two). */
  readonly size: number;
  readonly cascades: number;
  /** World metres covered by each cascade's periodic patch. */
  readonly patchSizes: number[];
  /**
   * Wavenumber edges (rad/m): cascade i synthesizes bandEdges[i] ≤ |k| < bandEdges[i + 1]. bandEdges[0] is the
   * analytic cutoff (`WaterWaveSet.cutoffK`); the last edge is the last cascade's Nyquist radius.
   */
  readonly bandEdges: number[];
  /**
   * Per cascade, the wavenumber (rad/m) ∂Dx/∂z is divided by while it shares a complex FFT with Dz, so both halves have
   * similar magnitudes and GPU rounding in one never swamps the other; the final pass multiplies it back. The geometric
   * mean of the cascade's band edges.
   */
  readonly shearScales: number[];
  /** Wind heading (radians from +X toward +Z) and effective spread of the directional distribution. */
  readonly heading: number;
  readonly spread: number;
  /** Peak enhancement γ of the density (`WaterWaveSet.spectrumSharpness`). */
  readonly sharpness: number;
  readonly seed: number;
  /** Analytic cutoff over the peak wavenumber (`cutoffK / peakK`, 4 for both wave models). */
  readonly cutoff: number;
  /** Metres of band per unit of the stored spectrum: √(spectrumScale · peakK). */
  readonly amplitude: number;
  /** Band clock per second of water time: √peakK · Wave Speed (`waterFftCycle`). */
  readonly timeScale: number;
  /** Identity of the stored unit spectrum: size, cascades, sharpness, heading, spread, seed and cutoff. */
  readonly spectrumKey: string;
  /** Identity of the whole simulation: the unit spectrum plus patch scale, amplitude and time scale. */
  readonly key: string;
}

/** Butterfly stages per direction: log2(size). */
export function waterFftStages(size: number): number {
  return Math.round(Math.log2(size));
}

/** Lowest in-band bin radius of every cascade: the directional distribution is resolved at its lowest wavenumber. */
const lowBin = (size: number) => Math.max(1, size / 16);

/**
 * Cascade layout for a wave set. Every cascade starts its band `size / 16` bins from its own centre and ends
 * `WATER_FFT_CASCADE_RATIO` times higher, where the next, smaller patch takes over; the last cascade runs to its
 * Nyquist radius. Bands never overlap and nothing below the analytic cutoff is synthesized, so no wavenumber is
 * counted twice. Allocates; call when the waves or the Water quality change, never per frame.
 */
export function waterFftLayout(set: WaterWaveSet, size: number, cascades: number): WaterFftLayout {
  if (!Number.isInteger(size) || size < 8 || (size & (size - 1)) !== 0) throw new Error("FFT size must be a power of two of at least 8.");
  if (!Number.isInteger(cascades) || cascades < 1) throw new Error("FFT cascades must be a positive integer.");
  const patchSizes: number[] = [], bandEdges: number[] = [];
  for (let i = 0; i < cascades; i++) {
    const low = set.cutoffK * WATER_FFT_CASCADE_RATIO ** i;
    bandEdges.push(low);
    patchSizes.push(TAU * lowBin(size) / low);
  }
  bandEdges.push(Math.PI * size / patchSizes[cascades - 1]!);
  const shearScales = patchSizes.map((_, i) => Math.sqrt(bandEdges[i]! * bandEdges[i + 1]!));
  const heading = set.waveDirection * Math.PI / 180, spread = Math.max(set.waveSpread, WATER_FFT_MIN_SPREAD);
  const sharpness = set.spectrumSharpness, seed = set.waveSeed, cutoff = set.cutoffK / set.peakK;
  const amplitude = Math.sqrt(Math.max(0, set.spectrumScale) * set.peakK), timeScale = Math.sqrt(set.peakK) * set.waveSpeed;
  const spectrumKey = [size, cascades, sharpness, heading, spread, seed, cutoff].join(":");
  return {
    size, cascades, patchSizes, bandEdges, shearScales, heading, spread, sharpness, seed, cutoff, amplitude, timeScale, spectrumKey,
    key: [spectrumKey, set.cutoffK, amplitude, timeScale].join(":"),
  };
}

/** Signed frequency index of grid column/row `index` (standard FFT order: 0…N/2−1, then −N/2…−1). */
const signedIndex = (index: number, size: number) => (index < size / 2 ? index : index - size);

/** Headings follow Wave Direction plus 2 · spread · Θ with Θ distributed as cos²Θ (the analytic model's distribution). */
function directional(angle: number, heading: number, spread: number): number {
  let theta = angle - heading;
  theta -= TAU * Math.round(theta / TAU);
  return Math.abs(theta) <= Math.PI * spread ? Math.cos(theta / (2 * spread)) ** 2 / (Math.PI * spread) : 0;
}

/** ∫ k^power · S(k) dk over [low, high] (log-spaced trapezoid with a fixed step count, so every host agrees). */
function bandMoment(set: WaterWaveSet, low: number, high: number, power: number): number {
  const steps = 256;
  let sum = 0, previous = low, previousValue = waterOceanSpectrumDensity(set, low) * low ** power;
  for (let i = 1; i <= steps; i++) {
    const k = low * (high / low) ** (i / steps), value = waterOceanSpectrumDensity(set, k) * k ** power;
    sum += (k - previous) * (value + previousValue) / 2;
    previous = k; previousValue = value;
  }
  return sum;
}

/** ∫ S(k) dk over [low, high]: the band's height variance (m² at Wave Scale 1). */
export function waterFftBandVariance(set: WaterWaveSet, low: number, high: number): number {
  return bandMoment(set, low, high, 0);
}

/**
 * ∫ k² · S(k) dk over [low, high]: the band's mean square slope E|∇H|² at Wave Scale 1, whatever its headings. A water
 * shader that fades a cascade before it would alias adds the faded share of this to its filtered roughness.
 */
export function waterFftBandSlopeVariance(set: WaterWaveSet, low: number, high: number): number {
  return bandMoment(set, low, high, 2);
}

/** Seed of one cascade's draw: the asset's Wave Seed and the cascade index, mixed so cascades never share a stream. */
const cascadeSeed = (waveSeed: number, cascade: number) =>
  (Math.imul(waveSeed + 1, 0x9e3779b1) ^ Math.imul(cascade + 1, 0x85ebca6b)) >>> 0;

/** An initial spectrum being drawn in budgeted steps (`waterFftSpectrumBuild`). */
export interface WaterFftSpectrumBuild {
  /** `spectrumKey` of the layout being drawn. */
  readonly key: string;
  /** The RGBA32F atlas (`waterFftInitialSpectrum`); complete only once `done`. */
  readonly data: Float32Array;
  readonly done: boolean;
  /** Draws whole rows until about `budget` more grid texels are written; true once the spectrum is complete. */
  step(budget: number): boolean;
}

class SpectrumBuild implements WaterFftSpectrumBuild {
  readonly key: string;
  readonly data: Float32Array;
  done = false;
  private readonly size: number;
  private readonly cascades: number;
  private readonly layout: WaterFftLayout;
  /** The density at peak wavenumber 1 and scale 1 (the unit spectrum). */
  private readonly unit: WaterWaveSet;
  private readonly power: Float64Array;
  /** Per squared bin radius n² of the current cascade: S(k)/k·Δk² (NaN until first used) and the frequency multiple. */
  private readonly radial: Float64Array;
  private readonly multiple: Float32Array;
  private cascade = -1;
  private drawing = false;
  private row = 0;
  private sum = 0;
  private scale = 0;
  private rng: Rng | null = null;
  /** Unit wavenumber per bin, and the squared bin radii [lowN2, highN2) of the current cascade's band. */
  private binK = 0;
  private lowN2 = 0;
  private highN2 = 0;

  constructor(set: WaterWaveSet, layout: WaterFftLayout, out?: Float32Array) {
    const { size, cascades } = layout;
    this.key = layout.spectrumKey; this.layout = layout; this.size = size; this.cascades = cascades;
    this.data = out ?? new Float32Array(size * cascades * size * 4);
    if (this.data.length !== size * cascades * size * 4) throw new Error("FFT spectrum buffer has the wrong size.");
    this.data.fill(0);
    this.unit = { ...set, spectrumScale: 1, peakK: 1, cutoffK: layout.cutoff, spectrumSharpness: layout.sharpness };
    this.power = new Float64Array(size * size);
    // Indexed by n² = nx² + ny², at most 2 · (size / 2)².
    this.radial = new Float64Array(size * size / 2 + 1);
    this.multiple = new Float32Array(size * size / 2 + 1);
    this.nextCascade();
  }

  private nextCascade(): void {
    if (++this.cascade === this.cascades) { this.done = true; return; }
    const low = lowBin(this.size);
    this.binK = this.layout.cutoff * WATER_FFT_CASCADE_RATIO ** this.cascade / low;
    this.lowN2 = low * low;
    this.highN2 = this.cascade === this.cascades - 1 ? (this.size / 2) ** 2 : (WATER_FFT_CASCADE_RATIO * low) ** 2;
    this.radial.fill(Number.NaN);
    this.sum = 0;
  }

  step(budget: number): boolean {
    let remaining = budget;
    while (!this.done && remaining > 0) {
      if (this.drawing) this.drawRow(); else this.powerRow();
      remaining -= this.size;
    }
    return this.done;
  }

  /** Expected power of every mode of one row (and the frequency multiple of every in-band mode). */
  private powerRow(): void {
    const { size, data, power, radial, multiple, layout, binK, lowN2: low, highN2: high } = this, y = this.row;
    const width = size * this.cascades, omega0 = TAU / WATER_FFT_PERIOD, ny = signedIndex(y, size);
    for (let x = 0; x < size; x++) {
      const nx = signedIndex(x, size), n2 = nx * nx + ny * ny;
      let p = 0;
      if (n2 >= low && n2 < high) {
        let factor = radial[n2]!;
        if (factor !== factor) {
          const k = binK * Math.sqrt(n2);
          factor = radial[n2] = waterOceanSpectrumDensity(this.unit, k) / k * binK * binK;
          multiple[n2] = Math.round(Math.sqrt(GRAVITY * k) / omega0);
        }
        p = factor * directional(Math.atan2(ny, nx), layout.heading, layout.spread);
        // Every in-band mode carries its frequency, even upwind ones with no energy of their own: the evolution pass
        // reads it for conj(h0(−k)), the downwind wave this texel also represents.
        data[(y * width + this.cascade * size + x) * 4 + 2] = multiple[n2]!;
      }
      power[y * size + x] = p; this.sum += p;
    }
    if (++this.row < size) return;
    const lowK = binK * lowBin(size), highK = binK * Math.sqrt(high);
    const target = waterFftBandVariance(this.unit, lowK, this.cascade === this.cascades - 1 ? highK : lowK * WATER_FFT_CASCADE_RATIO);
    this.scale = this.sum > 0 ? target / this.sum : 0;
    this.rng = createSeededRng(cascadeSeed(layout.seed, this.cascade));
    this.drawing = true; this.row = 0;
  }

  /** Seeded complex Gaussian amplitudes of one row's non-zero modes, in row-major order. */
  private drawRow(): void {
    const { size, data, power } = this, y = this.row, width = size * this.cascades, rng = this.rng!;
    for (let x = 0; x < size; x++) {
      const p = power[y * size + x]! * this.scale;
      if (!(p > 0)) continue;
      const radius = Math.sqrt(-2 * Math.log(1 - rng.nextFloat())), angle = TAU * rng.nextFloat();
      const amplitude = Math.sqrt(p / 4) * radius, o = (y * width + this.cascade * size + x) * 4;
      data[o] = amplitude * Math.cos(angle);
      data[o + 1] = amplitude * Math.sin(angle);
    }
    if (++this.row < size) return;
    this.drawing = false; this.row = 0; this.rng = null;
    this.nextCascade();
  }
}

/**
 * Starts drawing the seeded unit spectrum of `layout` in budgeted steps (`WaterFftSpectrumBuild.step`); the result is
 * bit-identical to `waterFftInitialSpectrum` however it is stepped. Allocates its buffers once.
 */
export function waterFftSpectrumBuild(set: WaterWaveSet, layout: WaterFftLayout, out?: Float32Array): WaterFftSpectrumBuild {
  return new SpectrumBuild(set, layout, out);
}

/**
 * Seeded unit spectrum, as uploaded to the GPU: an RGBA32F atlas `cascades · size` texels wide and `size` high,
 * cascade c in columns [c·size, (c+1)·size). Texel (x, y) of a cascade is the mode k = 2π/L · (signed x, signed y)
 * and holds (Re h0(k), Im h0(k), frequency multiple m, 0) at unit amplitude (multiply by `layout.amplitude`), where
 * the unit frequency √(g · k/peakK) ≈ m · 2π / WATER_FFT_PERIOD for every in-band mode.
 *
 * Modes outside the cascade's band are zero (in particular every |k| below the analytic cutoff). Inside it, the
 * expected power follows the core density with the asset's heading spread, Ψ(k) = S(|k|)·D(θ)/|k|, normalized per
 * cascade so the band's variance is exactly ∫ S(k) dk over the band. h0(k) = sqrt(Ψ·Δk²/4)·(g₁ + i·g₂) with seeded
 * Gaussians g (Mulberry32 from Wave Seed and the cascade index), drawn in row-major order for non-zero modes only.
 */
export function waterFftInitialSpectrum(set: WaterWaveSet, layout: WaterFftLayout, out?: Float32Array): Float32Array {
  const build = new SpectrumBuild(set, layout, out);
  build.step(Number.POSITIVE_INFINITY);
  return build.data;
}

/**
 * Position of water time `time` within the band's repeat period, in [0, 1): the GPU phase of a mode is
 * 2π · fract(m · cycle). Pass the layout's `timeScale` (Wave Length and Wave Speed set how fast the band runs).
 */
export function waterFftCycle(time: number, timeScale = 1): number {
  const cycle = (time * timeScale / WATER_FFT_PERIOD) % 1;
  return cycle < 0 ? cycle + 1 : cycle;
}

/** v − floor(v), as GLSL `fract` and WGSL `fract` compute it. */
const fract = (value: number) => value - Math.floor(value);

/** Writes A + i·B for complex A and B (each the spectrum of a real field) at `o`: (A.re − B.im, A.im + B.re). */
function packComplex(aRe: number, aIm: number, bRe: number, bIm: number, out: Float64Array, o: number): void {
  out[o] = aRe - bIm; out[o + 1] = aIm + bRe;
}

/**
 * CPU mirror of the time-evolution pass. Writes the work atlas (`2 · cascades · size` wide, `size` high, RGBA):
 * segment 2c holds (D̃x + i·H̃, D̃z + i·∂D̃x/∂z / shearScales[c]) and segment 2c + 1 holds (∂H̃/∂x + i·∂H̃/∂z, ∂D̃x/∂x + i·∂D̃z/∂z) of
 * cascade c, with h̃(k, t) = A·(h0(k)·e^{−iθ} + conj(h0(−k))·e^{iθ}), θ = 2π · fract(m · cycle), A = `amplitude` (the
 * GPU evaluates the same fract as fract(mHigh · fract(64 · cycle) + mLow · cycle), m = 64·mHigh + mLow, for float32
 * precision). Each pair of real fields shares one complex inverse FFT: their spectra are Hermitian, so the real and
 * imaginary parts of the result separate.
 */
export function waterFftEvolve(spectrum: Float32Array, layout: WaterFftLayout, cycle: number, out?: Float64Array): Float64Array {
  const { size, cascades, amplitude } = layout, width = 2 * cascades * size, sourceWidth = cascades * size;
  const result = out ?? new Float64Array(width * size * 4);
  for (let y = 0; y < size; y++) for (let column = 0; column < width; column++) {
    const segment = Math.floor(column / size), cascade = segment >> 1, x = column - segment * size;
    const a = (y * sourceWidth + cascade * size + x) * 4;
    const b = (((size - y) % size) * sourceWidth + cascade * size + (size - x) % size) * 4;
    const theta = TAU * fract(spectrum[a + 2]! * cycle), c = Math.cos(theta), s = Math.sin(theta);
    // h = A·(h0(k)·(c − i·s) + conj(h0(−k))·(c + i·s))
    const are = spectrum[a]!, aim = spectrum[a + 1]!, bre = spectrum[b]!, bim = -spectrum[b + 1]!;
    const hre = amplitude * (are * c + aim * s + bre * c - bim * s), him = amplitude * (aim * c - are * s + bre * s + bim * c);
    const scale = TAU / layout.patchSizes[cascade]!;
    const kx = signedIndex(x, size) * scale, kz = signedIndex(y, size) * scale, kl = Math.hypot(kx, kz);
    const ux = kl > 0 ? kx / kl : 0, uz = kl > 0 ? kz / kl : 0;
    const o = (y * width + column) * 4;
    if ((segment & 1) === 0) {
      // D̃x = i·k̂x·h̃, D̃z = i·k̂z·h̃, ∂D̃x/∂z = −kx·kz/|k|·h̃ (carried divided by the cascade's shear scale).
      const shear = kx * uz / layout.shearScales[cascade]!;
      packComplex(-ux * him, ux * hre, hre, him, result, o);
      packComplex(-uz * him, uz * hre, -shear * hre, -shear * him, result, o + 2);
    } else {
      // ∂H̃/∂x = i·kx·h̃, ∂H̃/∂z = i·kz·h̃, ∂D̃x/∂x = −kx²/|k|·h̃, ∂D̃z/∂z = −kz²/|k|·h̃.
      packComplex(-kx * him, kx * hre, -kz * him, kz * hre, result, o);
      packComplex(-kx * ux * hre, -kx * ux * him, -kz * uz * hre, -kz * uz * him, result, o + 2);
    }
  }
  return result;
}

/**
 * CPU mirror of one butterfly pass: radix-2 Stockham autosort (no bit-reversal pass; the result of log2(size) stages is
 * in natural order), inverse sign, unnormalized, applied to both complex values (rg, ba) of every RGBA texel.
 * Stage s combines sub-transforms of `2^s` points: output index i = block · 2^(s+1) + pos gathers a = in[j] and
 * b = in[j + size/2] with k = pos mod 2^s, j = block · 2^s + k, and writes a ± e^{iπk/2^s}·b (minus when pos ≥ 2^s).
 * Horizontal passes transform along x within each `size`-wide atlas segment; vertical passes along y. Output texel
 * (px, py) reads column px + xOffset, so the final vertical pass can write one segment into an `size`-wide array layer;
 * it multiplies alpha by `alphaScale` (a cascade's shear scale for its first layer, else 1).
 */
export function waterFftButterfly(
  input: Float64Array, inputWidth: number, output: Float64Array, outputWidth: number, outputHeight: number,
  size: number, stage: number, horizontal: boolean, xOffset = 0, alphaScale = 1,
): void {
  const span = 1 << stage, half = size / 2;
  for (let py = 0; py < outputHeight; py++) for (let px = 0; px < outputWidth; px++) {
    const x = px + xOffset, y = py;
    const i = horizontal ? x - Math.floor(x / size) * size : y;
    const block = Math.floor(i / (2 * span)), pos = i - block * 2 * span;
    const k = pos >= span ? pos - span : pos, j = block * span + k;
    const a = horizontal ? (y * inputWidth + x - i + j) * 4 : (j * inputWidth + x) * 4;
    const b = horizontal ? a + half * 4 : a + half * inputWidth * 4;
    const angle = Math.PI * k / span, c = Math.cos(angle), s = Math.sin(angle), sign = pos >= span ? -1 : 1;
    const o = (py * outputWidth + px) * 4;
    for (let pair = 0; pair < 4; pair += 2) {
      const bre = input[b + pair]!, bim = input[b + pair + 1]!;
      output[o + pair] = input[a + pair]! + sign * (c * bre - s * bim);
      output[o + pair + 1] = input[a + pair + 1]! + sign * (c * bim + s * bre);
    }
    output[o + 3]! *= alphaScale;
  }
}

/**
 * CPU mirror of the GPU's inverse transform of a work atlas (`segments · size` wide, `size` high, RGBA; consumed):
 * log2(size) horizontal and log2(size) − 1 vertical atlas passes, then the last vertical pass once per segment, each
 * writing one `size × size` output layer (row-major from texel row 0) with alpha times `alphaScales[segment]` (1 when
 * omitted).
 */
export function waterFftInverse(work: Float64Array, size: number, segments: number, alphaScales?: readonly number[]): Float64Array[] {
  const width = segments * size, stages = waterFftStages(size);
  let current = work, next = new Float64Array(work.length);
  for (let stage = 0; stage < stages; stage++) {
    waterFftButterfly(current, width, next, width, size, size, stage, true);
    [current, next] = [next, current];
  }
  for (let stage = 0; stage < stages - 1; stage++) {
    waterFftButterfly(current, width, next, width, size, size, stage, false);
    [current, next] = [next, current];
  }
  const layers: Float64Array[] = [];
  for (let layer = 0; layer < segments; layer++) {
    const out = new Float64Array(size * size * 4);
    waterFftButterfly(current, width, out, size, size, size, stages - 1, false, layer * size, alphaScales?.[layer] ?? 1);
    layers.push(out);
  }
  return layers;
}

/**
 * CPU reference of the whole GPU dispatch for `cycle` (`waterFftEvolve`, then `waterFftInverse`). Returns the
 * `2 · cascades` output layers in the GPU output's packing: layer 2c = (Dx, H, Dz, ∂Dx/∂z) and layer 2c + 1 =
 * (∂H/∂x, ∂H/∂z, ∂Dx/∂x, ∂Dz/∂z) of cascade c, in metres and slopes at Detail Waves 1, Wave Scale 1 and λ = 1.
 */
export function waterFftSynthesize(spectrum: Float32Array, layout: WaterFftLayout, cycle: number): Float64Array[] {
  const alphaScales = Array.from({ length: 2 * layout.cascades }, (_, layer) => (layer & 1 ? 1 : layout.shearScales[layer >> 1]!));
  return waterFftInverse(waterFftEvolve(spectrum, layout, cycle), layout.size, 2 * layout.cascades, alphaScales);
}
