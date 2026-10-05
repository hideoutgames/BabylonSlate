/**
 * Pure (Babylon-free) half of the FFT ocean detail band: cascade layout, the seeded initial spectrum h0(k), and a
 * CPU mirror of every GPU pass (time evolution and Stockham butterflies) used as the reference the browser proof and
 * unit tests compare against. `water-fft.ts` uploads `waterFftInitialSpectrum` and runs the same passes on the GPU.
 *
 * Conventions shared with the analytic kernel (`evaluateWaterWaves`): world X is texel x, world Z is texel y, and a
 * mode with wavevector k travels along +k with phase k·x − ωt, ω = √(g|k|) · Wave Speed. Each mode's Gerstner offset
 * is D = i·k̂·h̃ (water gathers under crests, as `D = q·a·d·cos p` does for the analytic swell with q = 1).
 */
import { createSeededRng, waterOceanSpectrumDensity, type WaterWaveSet } from "@babylonslate/core";

const TAU = 2 * Math.PI;
const GRAVITY = 9.81;

/**
 * Seconds after which the band repeats exactly. Every mode's frequency is a whole multiple of 2π / period (Tessendorf's
 * frequency quantization, under 0.3% at the cutoff), so the GPU phase is 2π · fract(multiple · fract(t / period)): no
 * large-argument trigonometry however long a session runs.
 */
export const WATER_FFT_PERIOD = 256;
/**
 * Patch size (and band) ratio between consecutive cascades: 3 + 2√2 is irrational, so cascades never repeat in step,
 * and below 8, so each cascade's band stays inside its grid.
 */
export const WATER_FFT_CASCADE_RATIO = 3 + 2 * Math.SQRT2;
/** Narrowest heading spread (Wave Spread units) of the detail band: short waves are never all parallel. */
export const WATER_FFT_MIN_SPREAD = 0.3;

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
  /** Wind heading (radians from +X toward +Z) and effective spread of the directional distribution. */
  readonly heading: number;
  readonly spread: number;
}

/** Butterfly stages per direction: log2(size). */
export function waterFftStages(size: number): number {
  return Math.round(Math.log2(size));
}

/**
 * Cascade layout for a wave set. Every cascade starts its band `size / 16` bins from its own centre (so the directional
 * distribution is resolved at its lowest wavenumber) and ends `WATER_FFT_CASCADE_RATIO` times higher, where the next,
 * smaller patch takes over; the last cascade runs to its Nyquist radius. Bands never overlap and nothing below the
 * analytic cutoff is synthesized, so no wavenumber is counted twice.
 */
export function waterFftLayout(set: WaterWaveSet, size: number, cascades: number): WaterFftLayout {
  if (!Number.isInteger(size) || size < 8 || (size & (size - 1)) !== 0) throw new Error("FFT size must be a power of two of at least 8.");
  if (!Number.isInteger(cascades) || cascades < 1) throw new Error("FFT cascades must be a positive integer.");
  const lowBin = Math.max(1, size / 16);
  const patchSizes: number[] = [], bandEdges: number[] = [];
  for (let i = 0; i < cascades; i++) {
    const low = set.cutoffK * WATER_FFT_CASCADE_RATIO ** i;
    bandEdges.push(low);
    patchSizes.push(TAU * lowBin / low);
  }
  bandEdges.push(Math.PI * size / patchSizes[cascades - 1]!);
  return {
    size, cascades, patchSizes, bandEdges,
    heading: set.waveDirection * Math.PI / 180,
    spread: Math.max(set.waveSpread, WATER_FFT_MIN_SPREAD),
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

/** ∫ S(k) dk over [low, high] (log-spaced trapezoid with a fixed step count, so every host agrees). */
export function waterFftBandVariance(set: WaterWaveSet, low: number, high: number): number {
  const steps = 256;
  let sum = 0, previous = low, previousValue = waterOceanSpectrumDensity(set, low);
  for (let i = 1; i <= steps; i++) {
    const k = low * (high / low) ** (i / steps), value = waterOceanSpectrumDensity(set, k);
    sum += (k - previous) * (value + previousValue) / 2;
    previous = k; previousValue = value;
  }
  return sum;
}

/** Seed of one cascade's draw: the asset's Wave Seed and the cascade index, mixed so cascades never share a stream. */
const cascadeSeed = (waveSeed: number, cascade: number) =>
  (Math.imul(waveSeed + 1, 0x9e3779b1) ^ Math.imul(cascade + 1, 0x85ebca6b)) >>> 0;

/**
 * Seeded initial spectrum, as uploaded to the GPU: an RGBA32F atlas `cascades · size` texels wide and `size` high,
 * cascade c in columns [c·size, (c+1)·size). Texel (x, y) of a cascade is the mode k = 2π/L · (signed x, signed y) and
 * holds (Re h0(k), Im h0(k), frequency multiple m, 0), where ω(|k|) ≈ m · 2π / WATER_FFT_PERIOD for every in-band mode.
 *
 * Modes outside the cascade's band are zero (in particular every |k| below the analytic cutoff). Inside it, the
 * expected power follows the core density with the asset's heading spread, Ψ(k) = S(|k|)·D(θ)/|k|, normalized per
 * cascade so the band's variance is exactly ∫ S(k) dk over the band. h0(k) = sqrt(Ψ·Δk²/4)·(g₁ + i·g₂) with seeded
 * Gaussians g (Mulberry32 from Wave Seed and the cascade index), drawn in row-major order for non-zero modes only.
 */
export function waterFftInitialSpectrum(set: WaterWaveSet, layout: WaterFftLayout, out?: Float32Array): Float32Array {
  const { size, cascades } = layout, width = size * cascades;
  const data = out ?? new Float32Array(width * size * 4);
  if (data.length !== width * size * 4) throw new Error("FFT spectrum buffer has the wrong size.");
  data.fill(0);
  const power = new Float64Array(size * size);
  const omega0 = TAU / WATER_FFT_PERIOD;
  for (let cascade = 0; cascade < cascades; cascade++) {
    const dk = TAU / layout.patchSizes[cascade]!, low = layout.bandEdges[cascade]!, high = layout.bandEdges[cascade + 1]!;
    let sum = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const nx = signedIndex(x, size), ny = signedIndex(y, size), k = dk * Math.hypot(nx, ny);
      let p = 0;
      if (k >= low && k < high) {
        p = waterOceanSpectrumDensity(set, k) * directional(Math.atan2(ny, nx), layout.heading, layout.spread) / k * dk * dk;
        // Every in-band mode carries its frequency, even upwind ones with no energy of their own: the evolution pass
        // reads it for conj(h0(−k)), the downwind wave this texel also represents.
        data[(y * width + cascade * size + x) * 4 + 2] = Math.round(Math.sqrt(GRAVITY * k) * set.waveSpeed / omega0);
      }
      power[y * size + x] = p; sum += p;
    }
    const target = waterFftBandVariance(set, low, high), scale = sum > 0 ? target / sum : 0;
    const rng = createSeededRng(cascadeSeed(set.waveSeed, cascade));
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const p = power[y * size + x]! * scale;
      if (!(p > 0)) continue;
      const radius = Math.sqrt(-2 * Math.log(1 - rng.nextFloat())), angle = TAU * rng.nextFloat();
      const amplitude = Math.sqrt(p / 4) * radius, o = (y * width + cascade * size + x) * 4;
      data[o] = amplitude * Math.cos(angle);
      data[o + 1] = amplitude * Math.sin(angle);
    }
  }
  return data;
}

/** Position of `time` within the band's repeat period, in [0, 1): the GPU phase of a mode is 2π · fract(m · cycle). */
export function waterFftCycle(time: number): number {
  const cycle = (time / WATER_FFT_PERIOD) % 1;
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
 * segment 2c holds (D̃x + i·H̃, D̃z + i·∂D̃x/∂z) and segment 2c + 1 holds (∂H̃/∂x + i·∂H̃/∂z, ∂D̃x/∂x + i·∂D̃z/∂z) of
 * cascade c, with h̃(k, t) = h0(k)·e^{−iθ} + conj(h0(−k))·e^{iθ}, θ = 2π · fract(m · cycle). Each pair of real fields
 * shares one complex inverse FFT: their spectra are Hermitian, so the real and imaginary parts of the result separate.
 */
export function waterFftEvolve(spectrum: Float32Array, layout: WaterFftLayout, cycle: number, out?: Float64Array): Float64Array {
  const { size, cascades } = layout, width = 2 * cascades * size, sourceWidth = cascades * size;
  const result = out ?? new Float64Array(width * size * 4);
  for (let y = 0; y < size; y++) for (let column = 0; column < width; column++) {
    const segment = Math.floor(column / size), cascade = segment >> 1, x = column - segment * size;
    const a = (y * sourceWidth + cascade * size + x) * 4;
    const b = (((size - y) % size) * sourceWidth + cascade * size + (size - x) % size) * 4;
    const theta = TAU * fract(spectrum[a + 2]! * cycle), c = Math.cos(theta), s = Math.sin(theta);
    // h = h0(k)·(c − i·s) + conj(h0(−k))·(c + i·s)
    const are = spectrum[a]!, aim = spectrum[a + 1]!, bre = spectrum[b]!, bim = -spectrum[b + 1]!;
    const hre = are * c + aim * s + bre * c - bim * s, him = aim * c - are * s + bre * s + bim * c;
    const scale = TAU / layout.patchSizes[cascade]!;
    const kx = signedIndex(x, size) * scale, kz = signedIndex(y, size) * scale, kl = Math.hypot(kx, kz);
    const ux = kl > 0 ? kx / kl : 0, uz = kl > 0 ? kz / kl : 0;
    const o = (y * width + column) * 4;
    if ((segment & 1) === 0) {
      // D̃x = i·k̂x·h̃, D̃z = i·k̂z·h̃, ∂D̃x/∂z = −kx·kz/|k|·h̃.
      packComplex(-ux * him, ux * hre, hre, him, result, o);
      packComplex(-uz * him, uz * hre, -kx * uz * hre, -kx * uz * him, result, o + 2);
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
 * (px, py) reads column px + xOffset, so the final vertical pass can write one segment into an `size`-wide array layer.
 */
export function waterFftButterfly(
  input: Float64Array, inputWidth: number, output: Float64Array, outputWidth: number, outputHeight: number,
  size: number, stage: number, horizontal: boolean, xOffset = 0,
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
  }
}

/**
 * CPU mirror of the GPU's inverse transform of a work atlas (`segments · size` wide, `size` high, RGBA; consumed):
 * log2(size) horizontal and log2(size) − 1 vertical atlas passes, then the last vertical pass once per segment, each
 * writing one `size × size` output layer (row-major from texel row 0).
 */
export function waterFftInverse(work: Float64Array, size: number, segments: number): Float64Array[] {
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
    waterFftButterfly(current, width, out, size, size, size, stages - 1, false, layer * size);
    layers.push(out);
  }
  return layers;
}

/**
 * CPU reference of the whole GPU dispatch for `cycle` (`waterFftEvolve`, then `waterFftInverse`). Returns the
 * `2 · cascades` output layers in the GPU output's packing: layer 2c = (Dx, H, Dz, ∂Dx/∂z) and layer 2c + 1 =
 * (∂H/∂x, ∂H/∂z, ∂Dx/∂x, ∂Dz/∂z) of cascade c, in metres and slopes at Detail Waves 1 and Wave Scale 1.
 */
export function waterFftSynthesize(spectrum: Float32Array, layout: WaterFftLayout, cycle: number): Float64Array[] {
  return waterFftInverse(waterFftEvolve(spectrum, layout, cycle), layout.size, 2 * layout.cascades);
}
