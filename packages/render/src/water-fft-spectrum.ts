/**
 * Pure (Babylon-free) half of the FFT ocean: cascade layout, the initial spectrum h0(k) drawn from core's spectrum
 * (`WaterSpectrumModes`), and a CPU mirror of every GPU pass (time evolution and Stockham butterflies) used as the
 * reference the browser proof and unit tests compare against. `water-fft.ts` uploads the spectrum and runs the same
 * passes on the GPU.
 *
 * Conventions shared with core's spectrum (`evaluateWaterSpectrum`): texel x and y are cascade c's turned frame
 * p = R(−turn_c)·(X, Z) (`WATER_FFT_CASCADE_TURNS`; cascade 0 is the world frame), and a mode with wavevector k travels
 * along +k with phase k·p − ωt, ω = √(g|k|) · Wave Speed. Each mode's Gerstner offset is D = i·k̂·h̃ (water gathers
 * under crests). The stored h0 is in absolute metres; only Wave Speed and the quality's FFT Size / FFT Cascades are
 * outside the stored spectrum (`spectrumKey`).
 */
import { WATER_SPECTRUM_PERIOD, WATER_SPECTRUM_TURNS, WaterSpectrumModes, type WaterSpectrum } from "@haptic/core";

const TAU = 2 * Math.PI;

/**
 * Each cascade's texture frame is turned this far (radians, from world X toward world Z) from the world's: cascade c
 * holds the spectrum in coordinates p = R(−turn)·x, so a consumer turns its outputs back. The turns are 0°, 31° and
 * 59°, none near another or near 90° (a square patch is the same turned by a quarter), so the cascades' periodic patches
 * tile along different axes and never line up into one rectangular repeat across the sea.
 */
export const WATER_FFT_CASCADE_TURNS = WATER_SPECTRUM_TURNS;
/**
 * Grid texels one spectrum build step writes (whole rows): the water before-render observer advances a build by one
 * step per run, so drawing a new spectrum never stalls a frame.
 */
export const WATER_FFT_BUILD_TEXELS = 4096;

export interface WaterFftLayout {
  /** Grid cells per side (power of two). */
  readonly size: number;
  readonly cascades: number;
  /** World metres covered by each cascade's periodic patch. */
  readonly patchSizes: number[];
  /**
   * Wavenumber edges (rad/m): cascade i synthesizes bandEdges[i] ≤ |k| < min(bandEdges[i + 1], nyquist[i]); the last
   * edge is capped by the last cascade's Nyquist radius.
   */
  readonly bandEdges: number[];
  /**
   * Per cascade, the Nyquist radius of its grid (π · size / patch, rad/m): no mode at or beyond it is drawn, so a grid too
   * small for its cascade's band drops those waves rather than aliasing them (the Nyquist bin has no partner −k).
   */
  readonly nyquist: number[];
  /**
   * Per cascade, the wavenumber (rad/m) ∂Dx/∂z is divided by while it shares a complex FFT with Dz, so both halves have
   * similar magnitudes and GPU rounding in one never swamps the other; the final pass multiplies it back. The geometric
   * mean of the cascade's band edges.
   */
  readonly shearScales: number[];
  readonly seed: number;
  /** Metres per unit of the stored spectrum (1: it is stored in metres). */
  readonly amplitude: number;
  /** Spectrum clock per second of water time: Wave Speed (`waterFftCycle`). */
  readonly timeScale: number;
  /** Clock units after which the spectrum repeats (`WATER_SPECTRUM_PERIOD`). */
  readonly period: number;
  /** Identity of the stored spectrum: size, cascades and the spectrum's own key. */
  readonly spectrumKey: string;
  /** Identity of the whole simulation: the stored spectrum plus Wave Speed. */
  readonly key: string;
}

/** Butterfly stages per direction: log2(size). */
export function waterFftStages(size: number): number {
  return Math.round(Math.log2(size));
}

/**
 * Layout of a spectrum (`waterSpectrum`): the spectrum's own cascades (the first `cascades` of them) on `size`-grids,
 * in absolute metres (amplitude 1) on the spectrum's clock (`WATER_SPECTRUM_PERIOD`, at Wave Speed). Each cascade's
 * band is the spectrum's, cut at its grid's Nyquist radius. Allocates; call when the waves or the Water quality change.
 */
export function waterSpectrumLayout(spectrum: WaterSpectrum, size: number, cascades: number): WaterFftLayout {
  if (!Number.isInteger(size) || size < 8 || (size & (size - 1)) !== 0) throw new Error("FFT size must be a power of two of at least 8.");
  const count = Math.max(1, Math.min(cascades, spectrum.patchSizes.length));
  const patchSizes = spectrum.patchSizes.slice(0, count), bandEdges: number[] = [];
  for (let c = 0; c < count; c++) bandEdges.push(spectrum.bandEdges[c]!);
  bandEdges.push(Math.min(spectrum.bandEdges[count]!, Math.PI * size / patchSizes[count - 1]!));
  const nyquist = patchSizes.map((patch) => Math.PI * size / patch);
  const shearScales = patchSizes.map((patch, c) => {
    const low = Math.max(bandEdges[c]!, TAU / patch), high = Math.min(bandEdges[c + 1]!, nyquist[c]!);
    return Math.sqrt(low * Math.max(high, low));
  });
  const spectrumKey = [size, count, spectrum.key].join(":");
  return {
    size, cascades: count, patchSizes, bandEdges, nyquist, shearScales, seed: spectrum.seed,
    amplitude: 1, timeScale: spectrum.waveSpeed, spectrumKey, key: [spectrumKey, spectrum.waveSpeed].join(":"),
    period: WATER_SPECTRUM_PERIOD,
  };
}

/** Signed frequency index of grid column/row `index` (standard FFT order: 0…N/2−1, then −N/2…−1). */
const signedIndex = (index: number, size: number) => (index < size / 2 ? index : index - size);

/** An initial spectrum being drawn in budgeted steps (`waterSpectrumBuild`). */
export interface WaterFftSpectrumBuild {
  /** `spectrumKey` of the layout being drawn. */
  readonly key: string;
  /** The RGBA32F atlas (`waterFftInitialSpectrum`); complete only once `done`. */
  readonly data: Float32Array;
  readonly done: boolean;
  /** Draws whole rows until about `budget` more grid texels are written; true once the spectrum is complete. */
  step(budget: number): boolean;
}

/** The initial amplitudes drawn in budgeted steps: whole rows of one cascade at a time. */
class SpectrumModeBuild implements WaterFftSpectrumBuild {
  readonly key: string;
  readonly data: Float32Array;
  done = false;
  private readonly size: number;
  private readonly cascades: number;
  private readonly spectrum: WaterSpectrum;
  private modes: WaterSpectrumModes | null = null;
  private readonly texel = new Float64Array(3);
  private cascade = 0;
  private row = 0;

  constructor(spectrum: WaterSpectrum, layout: WaterFftLayout) {
    this.key = layout.spectrumKey; this.size = layout.size; this.cascades = layout.cascades; this.spectrum = spectrum;
    this.data = new Float32Array(layout.size * layout.cascades * layout.size * 4);
  }

  step(budget: number): boolean {
    const { size, data, texel } = this, width = size * this.cascades;
    let remaining = budget;
    while (!this.done && remaining > 0) {
      const modes = this.modes ??= new WaterSpectrumModes(this.spectrum, this.cascade), y = this.row, ny = signedIndex(y, size);
      // Bins at or past the grid's Nyquist radius (`WaterFftLayout.nyquist`, size / 2 bins) stay empty.
      for (let x = 0; x < size; x++) {
        const nx = signedIndex(x, size);
        if (nx * nx + ny * ny >= size * size / 4) texel.fill(0);
        else modes.mode(nx, ny, texel, 0);
        const o = (y * width + this.cascade * size + x) * 4;
        data[o] = texel[0]!; data[o + 1] = texel[1]!; data[o + 2] = texel[2]!;
      }
      remaining -= size;
      if (++this.row < size) continue;
      this.row = 0; this.modes = null;
      if (++this.cascade === this.cascades) this.done = true;
    }
    return this.done;
  }
}

/**
 * Starts drawing the initial amplitudes (`WaterSpectrumModes`) for `layout` in budgeted steps, into the atlas
 * `waterSpectrumInitial` describes. Allocates its buffer once.
 */
export function waterSpectrumBuild(spectrum: WaterSpectrum, layout: WaterFftLayout): WaterFftSpectrumBuild {
  return new SpectrumModeBuild(spectrum, layout);
}

/**
 * The initial spectrum, as uploaded to the GPU: an RGBA32F atlas `cascades · size` texels wide and `size` high, cascade c
 * in columns [c·size, (c+1)·size). Texel (x, y) of a cascade is the mode k = 2π/L · (signed x, signed y) and holds
 * (Re h0(k), Im h0(k), frequency multiple m, 0) in metres, where √(g·k) ≈ m · 2π / `WATER_SPECTRUM_PERIOD` for every
 * in-band mode (`WaterSpectrumModes.mode`). Modes outside the cascade's band are zero.
 */
export function waterSpectrumInitial(spectrum: WaterSpectrum, layout: WaterFftLayout): Float32Array {
  const build = new SpectrumModeBuild(spectrum, layout);
  build.step(Number.POSITIVE_INFINITY);
  return build.data;
}

/**
 * Position of water time `time` within the spectrum's repeat period, in [0, 1): the GPU phase of a mode is
 * 2π · fract(m · cycle). Pass the layout's `timeScale` (Wave Speed).
 */
export function waterFftCycle(time: number, timeScale = 1, period = WATER_SPECTRUM_PERIOD): number {
  const cycle = (time * timeScale / period) % 1;
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
  let current: Float64Array = work, next: Float64Array = new Float64Array(work.length);
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
 * (∂H/∂x, ∂H/∂z, ∂Dx/∂x, ∂Dz/∂z) of cascade c, in metres and slopes at Wave Scale 1 and λ = 1.
 */
export function waterFftSynthesize(spectrum: Float32Array, layout: WaterFftLayout, cycle: number): Float64Array[] {
  const alphaScales = Array.from({ length: 2 * layout.cascades }, (_, layer) => (layer & 1 ? 1 : layout.shearScales[layer >> 1]!));
  return waterFftInverse(waterFftEvolve(spectrum, layout, cycle), layout.size, 2 * layout.cascades, alphaScales);
}
