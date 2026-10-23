import type { WaterDefinition } from "./water";

/**
 * FFT ocean spectrum: the wave source of Realistic and Painted water (`waterUsesSpectrum`), after the FFT-Ocean
 * approach (JONSWAP wind sea plus an optional swell, Cosine-2s spreading, three cascades). The renderer synthesizes
 * every cascade on the GPU (`water-fft.ts`); physics, queries and buoyancy evaluate the large-wave part of the same
 * modes on the CPU (`WaterSpectrumField`), so floating objects ride the waves that are drawn.
 *
 * Conventions shared with the GPU passes: cascade c holds the field in its turned frame p = R(−turn_c)·(X, Z)
 * (`WATER_SPECTRUM_TURNS`) on a periodic patch of `patchSizes[c]` metres; texel (i, j) of an N-grid holds the field at
 * p = (i, j)·L_c / N. A mode with wavevector k (2π·n / L_c for signed bin n) travels along +k with phase k·p − ωt. Its
 * initial amplitude h0(k) is drawn from a Gaussian hashed from (Wave Seed, cascade, n), never from the grid size, so
 * every quality draws the same modes and the CPU physics grid holds exactly the GPU's lowest modes. Each mode's angular
 * frequency is quantized to a whole multiple m of 2π / `WATER_SPECTRUM_PERIOD` (simulation seconds at Wave Speed 1): its
 * phase is 2π·fract(m·cycle) with cycle = fract(t·Wave Speed / period), so no large-argument trigonometry runs however
 * long a session lasts. The Gerstner offset of a mode is D = i·k̂·h̃ (water gathers under crests).
 */

const TAU = 2 * Math.PI;
export const WATER_SPECTRUM_GRAVITY = 9.81;
/** Seconds (at Wave Speed 1) after which the whole spectrum repeats exactly. */
export const WATER_SPECTRUM_PERIOD = 1024;
/** Cascades every spectrum layout partitions its band into (the renderer draws the first `fftCascades` of them). */
export const WATER_SPECTRUM_CASCADES = 3;
/** Patch size ratio between consecutive cascades: irrational, so cascades never repeat in step. */
export const WATER_SPECTRUM_RATIO = 4 + 2 * Math.SQRT2;
/** First cascade's patch in multiples of the dominant (longest) peak wavelength. */
export const WATER_SPECTRUM_PATCH = 9;
/** Cascade c > 0 starts this many bins from its own centre, where cascade c − 1 hands over. */
export const WATER_SPECTRUM_LOW_BIN = 6;
/**
 * Each cascade's frame is turned this far (radians) from the world's, so the cascades' periodic patches tile along
 * different axes and never line up into one rectangular repeat.
 */
export const WATER_SPECTRUM_TURNS = [0, 0.5411, 1.0297] as const;
/** CPU physics grid per side of the first cascade (the second uses half): their lowest modes are what physics reads. */
export const WATER_SPECTRUM_PHYSICS_SIZE = 64;
/** Horizontal displacement (choppiness λ) per unit of Steepness. */
export const WATER_SPECTRUM_CHOP = 2;

/** Water whose waves and look come from the FFT spectrum: Realistic and Painted built-in shading. */
export function waterUsesSpectrum(water: WaterDefinition): boolean {
  return !water.materialGuid && !(water.style === "stylized" && water.stylizedLook === "toon");
}

interface SpectrumComponent {
  /** Variance (m²) the component integrates to, before the detail gain. */
  readonly variance: number;
  readonly peakOmega: number;
  readonly gamma: number;
  readonly heading: number;
  /** Multiplies the spreading exponent s: larger is narrower. */
  readonly spreadScale: number;
  /** FFT-Ocean's swell parameter (0-1): narrows the spreading near and below the peak. */
  readonly swell: number;
  /** α·g² of the JONSWAP density normalized to `variance`. */
  readonly alphaG2: number;
}

/** One Water definition's spectrum and cascade layout. Immutable; shared by every body that uses the asset. */
export interface WaterSpectrum {
  readonly components: readonly SpectrumComponent[];
  /** Peak wavenumber of the wind sea (rad/m): the detail gain fades the tail above a few times it. */
  readonly windPeakK: number;
  readonly detail: number;
  /** Horizontal displacement scale λ (`WATER_SPECTRUM_CHOP` · Steepness). */
  readonly choppiness: number;
  readonly seed: number;
  readonly waveSpeed: number;
  /** Metres of each cascade's periodic patch. */
  readonly patchSizes: readonly number[];
  /** Wavenumber edges (rad/m): cascade c synthesizes bandEdges[c] ≤ |k| < bandEdges[c + 1] (its Nyquist radius caps it). */
  readonly bandEdges: readonly number[];
  /** Standard deviation of the height (m at Wave Scale 1). */
  readonly sigma: number;
  /** Identity of the drawn modes: every field above but Wave Speed and choppiness. */
  readonly key: string;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** ln Γ(x) for x > 0 (Lanczos, g = 7), so every host computes the same normalization. */
function lnGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  const z = x - 1;
  let a = c[0]!;
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (z + i);
  return 0.5 * Math.log(TAU) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Normalization of the Cosine-2s spreading cos^{2s}(θ/2) over (−π, π]: Γ(s + 1) / (2√π·Γ(s + ½)). */
function cosine2sNorm(s: number): number {
  return Math.exp(lnGamma(s + 1) - lnGamma(s + 0.5)) / (2 * Math.sqrt(Math.PI));
}

/** JONSWAP shape in ω relative to the peak, x = ω / ωp (constants normalize away). */
function jonswapShape(x: number, gamma: number): number {
  const sigma = x <= 1 ? 0.07 : 0.09, d = x - 1;
  return x ** -5 * Math.exp(-1.25 * x ** -4) * gamma ** Math.exp(-(d * d) / (2 * sigma * sigma));
}

/** ∫ shape dx over (0, ∞) (fixed log steps plus the x⁻⁵ tail, so every host agrees). */
function jonswapIntegral(gamma: number): number {
  const low = 0.3, high = 12, steps = 1024;
  let sum = 0, previous = low, previousValue = jonswapShape(low, gamma);
  for (let i = 1; i <= steps; i++) {
    const x = low * (high / low) ** (i / steps), value = jonswapShape(x, gamma);
    sum += (x - previous) * (value + previousValue) / 2;
    previous = x; previousValue = value;
  }
  return sum + 1 / (4 * high ** 4);
}

function component(height: number, wavelength: number, gamma: number, heading: number, spreadScale: number, swell: number): SpectrumComponent {
  // Significant height Hs = 2 × Wave Height (crests stand about Wave Height above the mean), σ = Hs / 4.
  const variance = (height / 2) ** 2;
  const peakOmega = Math.sqrt(WATER_SPECTRUM_GRAVITY * TAU / wavelength);
  // ∫ α·g²·ω⁻⁵·… dω = α·g²·ωp⁻⁴·J(γ) = variance.
  const alphaG2 = variance > 0 ? variance * peakOmega ** 4 / jonswapIntegral(gamma) : 0;
  return { variance, peakOmega, gamma, heading, spreadScale, swell, alphaG2 };
}

const spectra = new WeakMap<WaterDefinition, { fields: string; spectrum: WaterSpectrum }>();
/** Recent spectra by their wave fields, newest last: every body of one asset (each holding its own copy) shares one. */
const interned = new Map<string, WaterSpectrum>();
const INTERNED_SPECTRA = 32;
const fieldsOf = (w: WaterDefinition) => [w.waveHeight, w.waveLength, w.waveDirection, w.waveSpread, w.peakSharpness, w.swellHeight,
  w.swellLength, w.swellDirection, w.detailWaves, w.steepness, w.waveSeed, w.waveSpeed].join(":");

/** The definition's spectrum, rebuilt only when one of its wave fields changes. Never keyed on Wave Scale. */
export function waterSpectrum(water: WaterDefinition): WaterSpectrum {
  const fields = fieldsOf(water), cached = spectra.get(water);
  if (cached && cached.fields === fields) return cached.spectrum;
  let spectrum = interned.get(fields);
  if (spectrum) interned.delete(fields);
  else spectrum = buildSpectrum(water);
  interned.set(fields, spectrum);
  if (interned.size > INTERNED_SPECTRA) interned.delete(interned.keys().next().value!);
  spectra.set(water, { fields, spectrum });
  return spectrum;
}

function buildSpectrum(w: WaterDefinition): WaterSpectrum {
  const rad = Math.PI / 180, gamma = clamp(w.peakSharpness, 1, 7);
  // Wave Spread 0.5 is FFT-Ocean's spreading; 0 is eight times narrower and 1 eight times wider.
  const windSpread = 2 ** ((0.5 - w.waveSpread) * 6);
  const components = [component(w.waveHeight, w.waveLength, gamma, w.waveDirection * rad, windSpread, 0.2)];
  if (w.swellHeight > 0) components.push(component(w.swellHeight, w.swellLength, gamma, w.swellDirection * rad, 1, 1));
  const dominant = Math.max(w.waveLength, w.swellHeight > 0 ? w.swellLength : 0);
  const first = clamp(dominant * WATER_SPECTRUM_PATCH, 2, 20000);
  const patchSizes = Array.from({ length: WATER_SPECTRUM_CASCADES }, (_, c) => first / WATER_SPECTRUM_RATIO ** c);
  const bandEdges = [0];
  for (let c = 1; c < WATER_SPECTRUM_CASCADES; c++) bandEdges.push(TAU * WATER_SPECTRUM_LOW_BIN / patchSizes[c]!);
  bandEdges.push(Infinity);
  const sigma = Math.sqrt(components.reduce((sum, c) => sum + c.variance, 0));
  return {
    components, windPeakK: TAU / w.waveLength, detail: clamp(w.detailWaves, 0, 1), choppiness: WATER_SPECTRUM_CHOP * w.steepness,
    seed: w.waveSeed, waveSpeed: w.waveSpeed, patchSizes, bandEdges, sigma,
    key: fieldsOf({ ...w, steepness: 0, waveSpeed: 0 }),
  };
}

/** Deep-water angular frequency (rad/s at Wave Speed 1) of wavenumber k. */
const dispersion = (k: number) => Math.sqrt(WATER_SPECTRUM_GRAVITY * k);

/** The mode's frequency as a whole multiple of 2π / `WATER_SPECTRUM_PERIOD`. */
export function waterSpectrumFrequencyMultiple(k: number): number {
  return Math.round(dispersion(k) * WATER_SPECTRUM_PERIOD / TAU);
}

/**
 * Variance density Ψ(k) (m⁴; ∫∫ Ψ dkx dkz is the sea's height variance) at wavevector (kx, kz) in world axes:
 * Σ S_ω(ω)·dω/dk·D(θ)/k over the components, with the detail gain fading the tail above four wind-sea peaks.
 */
export function waterSpectrumDensity(spectrum: WaterSpectrum, kx: number, kz: number): number {
  const k = Math.hypot(kx, kz);
  if (!(k > 0)) return 0;
  const ring = spectrumRing(spectrum, k, new Float64Array(spectrum.components.length * 2));
  return ringDensity(spectrum, ring, Math.atan2(kz, kx));
}

/** The radial part of every component at |k| (its density per radian before spreading, and its spreading exponent s). */
function spectrumRing(spectrum: WaterSpectrum, k: number, out: Float64Array): Float64Array {
  const omega = dispersion(k), dOmega = WATER_SPECTRUM_GRAVITY / (2 * omega);
  let tail = 1;
  if (spectrum.detail < 1) {
    const t = clamp((k / spectrum.windPeakK - 4) / 12, 0, 1);
    tail = 1 + (spectrum.detail * spectrum.detail - 1) * t * t * (3 - 2 * t);
  }
  spectrum.components.forEach((c, i) => {
    const x = omega / c.peakOmega;
    // FFT-Ocean's spreading exponent: wide well above the peak, narrow near it, narrower still for swell.
    const s = (x > 1 ? 9.77 * x ** -2.5 : 6.97 * x ** 5) * c.spreadScale + 16 * Math.tanh(Math.min(x, 20)) * c.swell * c.swell;
    out[i * 2] = c.alphaG2 > 0 ? c.alphaG2 * c.peakOmega ** -5 * jonswapShape(x, c.gamma) * dOmega / k * cosine2sNorm(s) * tail : 0;
    out[i * 2 + 1] = s;
  });
  return out;
}

/** Ψ of a ring (`spectrumRing`) at world heading `theta`. */
function ringDensity(spectrum: WaterSpectrum, ring: Float64Array, theta: number): number {
  let sum = 0;
  for (let i = 0; i < spectrum.components.length; i++) {
    const radial = ring[i * 2]!;
    if (!(radial > 0)) continue;
    let d = theta - spectrum.components[i]!.heading;
    d -= TAU * Math.round(d / TAU);
    sum += radial * Math.abs(Math.cos(d / 2)) ** (2 * ring[i * 2 + 1]!);
  }
  return sum;
}

/** Two uniform values in (0, 1] and [0, 1) hashed from the seed, cascade and signed bin (SplitMix-style mixing). */
function hashUniforms(seed: number, cascade: number, nx: number, ny: number, out: Float64Array): void {
  let h = Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(cascade + 7, 0x85ebca6b) ^ Math.imul(nx + 0x8000, 0xc2b2ae35) ^ Math.imul(ny + 0x8000, 0x27d4eb2f);
  for (let i = 0; i < 2; i++) {
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h ^= h >>> 16;
    out[i] = ((h >>> 0) + (i === 0 ? 1 : 0)) / 0x100000001;
    h = (h + 0x6d2b79f5) | 0;
  }
}

/**
 * Draws one cascade's modes (`mode`), caching the radial part of the spectrum per squared bin radius n², so drawing a
 * whole grid costs one directional term per mode. Every mode is a pure function of the spectrum, cascade and bin.
 */
export class WaterSpectrumModes {
  readonly spectrum: WaterSpectrum;
  readonly cascade: number;
  private readonly binK: number;
  private readonly cos: number;
  private readonly sin: number;
  private readonly rings = new Map<number, Float64Array>();
  private readonly uniforms = new Float64Array(2);

  constructor(spectrum: WaterSpectrum, cascade: number) {
    this.spectrum = spectrum; this.cascade = cascade;
    this.binK = TAU / spectrum.patchSizes[cascade]!;
    const turn = WATER_SPECTRUM_TURNS[cascade]!;
    this.cos = Math.cos(turn); this.sin = Math.sin(turn);
  }

  /**
   * The initial amplitude of the mode at signed bin (nx, ny) in the cascade's turned frame: writes (Re h0, Im h0,
   * frequency multiple m) into `out` at `offset`. Zero outside the cascade's band (m is still written for in-band radii,
   * as the time evolution reads it for conj(h0(−k))). E|h0|² = Ψ·Δk²/2, so the Hermitian pair carries the band's variance.
   */
  mode(nx: number, ny: number, out: Float32Array | Float64Array, offset: number): void {
    const { spectrum, binK } = this, n2 = nx * nx + ny * ny, k = binK * Math.sqrt(n2);
    out[offset] = 0; out[offset + 1] = 0; out[offset + 2] = 0;
    if (!(k > 0 && k >= spectrum.bandEdges[this.cascade]! && k < spectrum.bandEdges[this.cascade + 1]!)) return;
    out[offset + 2] = waterSpectrumFrequencyMultiple(k);
    let ring = this.rings.get(n2);
    if (!ring) this.rings.set(n2, ring = spectrumRing(spectrum, k, new Float64Array(spectrum.components.length * 2)));
    // The frame's heading back in world axes (turned by the cascade's turn).
    const fx = nx, fz = ny, theta = Math.atan2(this.sin * fx + this.cos * fz, this.cos * fx - this.sin * fz);
    const power = ringDensity(spectrum, ring, theta) * binK * binK;
    if (!(power > 0)) return;
    hashUniforms(spectrum.seed, this.cascade, nx, ny, this.uniforms);
    const radius = Math.sqrt(-2 * Math.log(this.uniforms[0]!)), angle = TAU * this.uniforms[1]!;
    const amplitude = Math.sqrt(power / 4) * radius;
    out[offset] = amplitude * Math.cos(angle);
    out[offset + 1] = amplitude * Math.sin(angle);
  }
}

/** Position of simulation time `time` within the spectrum's repeat period at Wave Speed `speed`, in [0, 1). */
export function waterSpectrumCycle(time: number, speed: number): number {
  const cycle = (time * speed / WATER_SPECTRUM_PERIOD) % 1;
  return cycle < 0 ? cycle + 1 : cycle;
}

// ---------------------------------------------------------------------------------------------------------------
// CPU physics field

/** Field slots of one physics cascade: height, offset, and their time rates. */
const H = 0, DX = 1, DZ = 2, HT = 3, DXT = 4, DZT = 5, FIELDS = 6;

/** One cascade's physics grid: its modes, FFT tables and per-frame fields (`size` per side). */
class PhysicsGrid {
  readonly size: number;
  readonly cascade: number;
  /** (re, im, m) per bin, row-major by unsigned index. */
  readonly modes: Float64Array;
  /** Bins with a frequency (in band), their mirrors −k and unit wavevectors k̂. */
  readonly active: Uint16Array;
  readonly mirror: Uint16Array;
  readonly units: Float64Array;
  private readonly reversed: Uint16Array;
  /** Per butterfly stage: twiddles (cos, sin) interleaved. */
  private readonly twiddles: Float64Array[];
  /** Complex scratch (interleaved) and its transpose. */
  private readonly data: Float64Array;
  private readonly transposed: Float64Array;
  private readonly row: Float64Array;
  /** Per bin at the synthesized time: h and ∂h/∂t (re, im each). */
  private readonly h: Float64Array;

  constructor(spectrum: WaterSpectrum, cascade: number, size: number) {
    this.size = size; this.cascade = cascade;
    const n = size * size, bits = Math.round(Math.log2(size));
    this.modes = new Float64Array(n * 3);
    this.mirror = new Uint16Array(n); this.units = new Float64Array(n * 2);
    const bins: number[] = [], draw = new WaterSpectrumModes(spectrum, cascade);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x, nx = x < size / 2 ? x : x - size, ny = y < size / 2 ? y : y - size, length = Math.sqrt(nx * nx + ny * ny) || 1;
      draw.mode(nx, ny, this.modes, i * 3);
      if (this.modes[i * 3 + 2] !== 0) bins.push(i);
      this.mirror[i] = ((size - y) % size) * size + (size - x) % size;
      this.units[i * 2] = nx / length; this.units[i * 2 + 1] = ny / length;
    }
    this.active = Uint16Array.from(bins);
    this.reversed = Uint16Array.from({ length: size }, (_, i) => {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      return r;
    });
    this.twiddles = [];
    for (let span = 2; span <= size; span <<= 1) {
      const half = span >> 1, table = new Float64Array(half * 2);
      for (let k = 0; k < half; k++) { table[k * 2] = Math.cos(TAU * k / span); table[k * 2 + 1] = Math.sin(TAU * k / span); }
      this.twiddles.push(table);
    }
    this.data = new Float64Array(n * 2); this.transposed = new Float64Array(n * 2);
    this.row = new Float64Array(size * 2); this.h = new Float64Array(n * 4);
  }

  /** Unnormalized inverse DFT (e^{+i…}) of every row of `d` (interleaved complex, `size` × `size`), in place. */
  private rows(d: Float64Array): void {
    const size = this.size, tmp = this.row, reversed = this.reversed, twiddles = this.twiddles;
    for (let row = 0; row < size; row++) {
      const base = row * size * 2;
      for (let i = 0; i < size; i++) { const j = reversed[i]! * 2; tmp[j] = d[base + 2 * i]!; tmp[j + 1] = d[base + 2 * i + 1]!; }
      for (let stage = 0, span = 2; span <= size; span <<= 1, stage++) {
        const half = span >> 1, table = twiddles[stage]!;
        for (let block = 0; block < size; block += span) {
          for (let k = 0; k < half; k++) {
            const a = 2 * (block + k), b = a + 2 * half, c = table[k * 2]!, s = table[k * 2 + 1]!;
            const xr = tmp[b]!, xi = tmp[b + 1]!, br = xr * c - xi * s, bi = xr * s + xi * c;
            tmp[b] = tmp[a]! - br; tmp[b + 1] = tmp[a + 1]! - bi; tmp[a] = tmp[a]! + br; tmp[a + 1] = tmp[a + 1]! + bi;
          }
        }
      }
      d.set(tmp, base);
    }
  }

  private transpose(from: Float64Array, to: Float64Array): void {
    const size = this.size;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const a = 2 * (y * size + x), b = 2 * (x * size + y);
      to[b] = from[a]!; to[b + 1] = from[a + 1]!;
    }
  }

  /** Writes the six fields (`H` … `DZT`) at simulation time `time` into `out` (`FIELDS` per texel). */
  synthesize(cycle: number, omega0: number, out: Float64Array): void {
    const { modes, active, mirror, units, h, data } = this, n = this.size * this.size;
    // h = h0(k)·e^{−iθ} + conj(h0(−k))·e^{iθ} and ∂h/∂t = −iω·(h0(k)·e^{−iθ} − conj(h0(−k))·e^{iθ}), once per mode.
    for (let j = 0; j < active.length; j++) {
      const i = active[j]!, a = i * 3, b = mirror[i]! * 3, m = modes[a + 2]!;
      const theta = TAU * ((m * cycle) % 1), cs = Math.cos(theta), sn = Math.sin(theta);
      const ar = modes[a]!, ai = modes[a + 1]!, br = modes[b]!, bi = -modes[b + 1]!;
      const pr = ar * cs + ai * sn, pi = ai * cs - ar * sn, qr = br * cs - bi * sn, qi = bi * cs + br * sn, w = m * omega0;
      h[i * 4] = pr + qr; h[i * 4 + 1] = pi + qi; h[i * 4 + 2] = w * (pi - qi); h[i * 4 + 3] = -w * (pr - qr);
    }
    // Three passes of two real fields each: (H, Dx), (Dz, ∂H/∂t), (∂Dx/∂t, ∂Dz/∂t). Spectra of real fields A + i·B pack as
    // (A.re − B.im, A.im + B.re); D = i·k̂·h.
    for (let pass = 0; pass < 3; pass++) {
      data.fill(0);
      for (let j = 0; j < active.length; j++) {
        const i = active[j]!, hr = h[i * 4]!, hi = h[i * 4 + 1]!, tr = h[i * 4 + 2]!, ti = h[i * 4 + 3]!, ux = units[i * 2]!, uz = units[i * 2 + 1]!;
        let fr: number, fi: number, gr: number, gi: number;
        if (pass === 0) { fr = hr; fi = hi; gr = -ux * hi; gi = ux * hr; }
        else if (pass === 1) { fr = -uz * hi; fi = uz * hr; gr = tr; gi = ti; }
        else { fr = -ux * ti; fi = ux * tr; gr = -uz * ti; gi = uz * tr; }
        data[i * 2] = fr - gi; data[i * 2 + 1] = fi + gr;
      }
      this.rows(data);
      this.transpose(data, this.transposed);
      this.rows(this.transposed);
      this.transpose(this.transposed, data);
      const first = pass === 0 ? H : pass === 1 ? DZ : DXT, second = pass === 0 ? DX : pass === 1 ? HT : DZT;
      for (let i = 0; i < n; i++) { out[i * FIELDS + first] = data[i * 2]!; out[i * FIELDS + second] = data[i * 2 + 1]!; }
    }
  }
}

/**
 * Physics grid per side of each physics cascade: the first cascade's 64² modes (|n| < 32) hold the swell and the wind
 * sea's peak; the second's 32² (its band starts at `WATER_SPECTRUM_LOW_BIN`) extends it to waves a few metres long.
 */
const PHYSICS_SIZES = [WATER_SPECTRUM_PHYSICS_SIZE, WATER_SPECTRUM_PHYSICS_SIZE / 2] as const;
/** Physics frames per second of simulation time: queries blend the two frames around them linearly. */
export const WATER_SPECTRUM_PHYSICS_RATE = 30;

/**
 * The large-wave part of a spectrum on the CPU: the lowest modes of the first two cascades, synthesized by an inverse
 * FFT on a fixed grid of times (`WATER_SPECTRUM_PHYSICS_RATE`) and blended linearly between the two frames around the
 * queried time, then sampled with periodic Catmull-Rom splines. Every result depends only on the time and position
 * asked, never on what was asked before, so every host agrees. One per spectrum; the frames and the blend for the last
 * time are cached, so a physics step's many samples share one synthesis.
 */
export class WaterSpectrumField {
  readonly spectrum: WaterSpectrum;
  private readonly grids: PhysicsGrid[];
  /** Per cascade: two synthesized frames (by frame index) and their blend at the last time. */
  private readonly frames: { index: number; fields: Float64Array }[][];
  private readonly blended: Float64Array[];
  private time = Number.NaN;

  constructor(spectrum: WaterSpectrum) {
    this.spectrum = spectrum;
    this.grids = PHYSICS_SIZES.map((size, c) => new PhysicsGrid(spectrum, c, size));
    this.frames = this.grids.map((grid) => [0, 1].map(() => ({ index: Number.NaN, fields: new Float64Array(grid.size * grid.size * FIELDS) })));
    this.blended = this.grids.map((grid) => new Float64Array(grid.size * grid.size * FIELDS));
  }

  /** Brings the blended fields to `time` (simulation seconds). */
  synthesize(time: number): void {
    if (time === this.time) return;
    this.time = time;
    const speed = this.spectrum.waveSpeed, omega0 = TAU / WATER_SPECTRUM_PERIOD * speed;
    const position = time * WATER_SPECTRUM_PHYSICS_RATE, first = Math.floor(position), t = position - first;
    for (let c = 0; c < this.grids.length; c++) {
      const grid = this.grids[c]!, frames = this.frames[c]!;
      const pick = (index: number) => {
        let frame = frames.find((f) => f.index === index);
        if (!frame) {
          // Reuse the frame that is neither of the two wanted.
          frame = frames.find((f) => f.index !== first && f.index !== first + 1)!;
          frame.index = index;
          grid.synthesize(waterSpectrumCycle(index / WATER_SPECTRUM_PHYSICS_RATE, speed), omega0, frame.fields);
        }
        return frame.fields;
      };
      const a = pick(first), b = pick(first + 1), out = this.blended[c]!;
      for (let i = 0; i < out.length; i++) out[i] = a[i]! + (b[i]! - a[i]!) * t;
    }
  }

  /**
   * Accumulates the fields at world rest point (x0, z0) into `result` (`F_*` slots): H, Dx, Dz, their rates, ∇H, and
   * the offset's gradient tensor, in world axes. Call `synthesize` first.
   */
  sample(x0: number, z0: number, result: Float64Array): void {
    result.fill(0);
    for (let c = 0; c < this.grids.length; c++) {
      const size = this.grids[c]!.size, turn = WATER_SPECTRUM_TURNS[c]!, cos = Math.cos(turn), sin = Math.sin(turn);
      const patch = this.spectrum.patchSizes[c]!, per = size / patch;
      const px = cos * x0 + sin * z0, pz = -sin * x0 + cos * z0;
      catmullRom(this.blended[c]!, size, px * per, pz * per, sampleScratch);
      const s = sampleScratch;
      result[F_H] = result[F_H]! + s[H * 3]!;
      result[F_HT] = result[F_HT]! + s[HT * 3]!;
      // Frame vectors back to world axes, R(turn)·v; gradients per texel to per metre of the frame first.
      const dx = s[DX * 3]!, dz = s[DZ * 3]!, dxt = s[DXT * 3]!, dzt = s[DZT * 3]!;
      result[F_DX] = result[F_DX]! + cos * dx - sin * dz; result[F_DZ] = result[F_DZ]! + sin * dx + cos * dz;
      result[F_DXT] = result[F_DXT]! + cos * dxt - sin * dzt; result[F_DZT] = result[F_DZT]! + sin * dxt + cos * dzt;
      const hx = s[H * 3 + 1]! * per, hz = s[H * 3 + 2]! * per;
      result[F_HX] = result[F_HX]! + cos * hx - sin * hz; result[F_HX + 1] = result[F_HX + 1]! + sin * hx + cos * hz;
      // The offset's gradient tensor J' = ∂D'/∂p in the frame, then R·J'·Rᵀ in world axes.
      const jxx = s[DX * 3 + 1]! * per, jxz = s[DX * 3 + 2]! * per, jzx = s[DZ * 3 + 1]! * per, jzz = s[DZ * 3 + 2]! * per;
      const axx = cos * jxx - sin * jzx, axz = cos * jxz - sin * jzz, azx = sin * jxx + cos * jzx, azz = sin * jxz + cos * jzz;
      result[F_JXX] = result[F_JXX]! + axx * cos - axz * sin; result[F_JXZ] = result[F_JXZ]! + axx * sin + axz * cos;
      result[F_JZX] = result[F_JZX]! + azx * cos - azz * sin; result[F_JZZ] = result[F_JZZ]! + azx * sin + azz * cos;
    }
  }
}

/** Slots of `WaterSpectrumField.sample`. */
const F_H = 0, F_DX = 1, F_DZ = 2, F_HT = 3, F_DXT = 4, F_DZT = 5, F_HX = 6, F_JXX = 8, F_JXZ = 9, F_JZX = 10, F_JZZ = 11;
export const WATER_SPECTRUM_SAMPLE_SIZE = 12;
const sampleScratch = new Float64Array(FIELDS * 3);

/**
 * Periodic Catmull-Rom of every field of a `size`-grid at texel coordinates (u, v): value and ∂/∂u, ∂/∂v per field into
 * `out`. Rates need no gradient, so only H, Dx and Dz take one.
 */
function catmullRom(grid: Float64Array, size: number, u: number, v: number, out: Float64Array): void {
  const iu = Math.floor(u), iv = Math.floor(v), tu = u - iu, tv = v - iv;
  const wu = weights(tu, weightU), dwu = derivatives(tu, weightDu), wv = weights(tv, weightV), dwv = derivatives(tv, weightDv);
  out.fill(0);
  for (let j = 0; j < 4; j++) {
    const row = (((iv + j - 1) % size) + size) % size;
    for (let i = 0; i < 4; i++) {
      const column = (((iu + i - 1) % size) + size) % size, o = (row * size + column) * FIELDS;
      const w = wu[i]! * wv[j]!, du = dwu[i]! * wv[j]!, dv = wu[i]! * dwv[j]!;
      for (let f = 0; f < 3; f++) {
        const value = grid[o + f]!;
        out[f * 3] = out[f * 3]! + value * w; out[f * 3 + 1] = out[f * 3 + 1]! + value * du; out[f * 3 + 2] = out[f * 3 + 2]! + value * dv;
      }
      for (let f = 3; f < FIELDS; f++) out[f * 3] = out[f * 3]! + grid[o + f]! * w;
    }
  }
}
const weightU = new Float64Array(4), weightV = new Float64Array(4), weightDu = new Float64Array(4), weightDv = new Float64Array(4);
function weights(t: number, out: Float64Array): Float64Array {
  const t2 = t * t, t3 = t2 * t;
  out[0] = (-t3 + 2 * t2 - t) / 2; out[1] = (3 * t3 - 5 * t2 + 2) / 2; out[2] = (-3 * t3 + 4 * t2 + t) / 2; out[3] = (t3 - t2) / 2;
  return out;
}
function derivatives(t: number, out: Float64Array): Float64Array {
  const t2 = t * t;
  out[0] = (-3 * t2 + 4 * t - 1) / 2; out[1] = (9 * t2 - 10 * t) / 2; out[2] = (-9 * t2 + 8 * t + 1) / 2; out[3] = (3 * t2 - 2 * t) / 2;
  return out;
}

const fields = new WeakMap<WaterSpectrum, WaterSpectrumField>();
/** The spectrum's CPU field, built on first use (two M×M mode sets). */
export function waterSpectrumField(spectrum: WaterSpectrum): WaterSpectrumField {
  let field = fields.get(spectrum);
  if (!field) fields.set(spectrum, field = new WaterSpectrumField(spectrum));
  return field;
}

const fieldSample = new Float64Array(WATER_SPECTRUM_SAMPLE_SIZE);

/**
 * `evaluateWaterWaves` for spectrum water: the large-wave field at rest point (x0, z0) and `time`, in `WaterWaveSlot`
 * order (0-10 and 13). Wave Scale `scale` multiplies height and offset; `gain` (with its gradient) is a finite body's bank
 * fade of the offset.
 */
export function evaluateWaterSpectrum(
  spectrum: WaterSpectrum, x0: number, z0: number, time: number, out: Float64Array, scale: number, gain: number, gainX: number, gainZ: number,
): void {
  const field = waterSpectrumField(spectrum);
  field.synthesize(time);
  field.sample(x0, z0, fieldSample);
  const s = fieldSample, q = spectrum.choppiness * scale;
  const dx = q * s[F_DX]!, dz = q * s[F_DZ]!;
  out[0] = scale * s[F_H]!; out[1] = gain * dx; out[2] = gain * dz;
  out[3] = scale * s[F_HX]!; out[4] = scale * s[F_HX + 1]!;
  out[5] = 1 + gain * q * s[F_JXX]! + dx * gainX; out[6] = gain * q * s[F_JXZ]! + dx * gainZ;
  out[13] = gain * q * s[F_JZX]! + dz * gainX; out[7] = 1 + gain * q * s[F_JZZ]! + dz * gainZ;
  out[8] = scale * s[F_HT]!; out[9] = gain * q * s[F_DXT]!; out[10] = gain * q * s[F_DZT]!;
}
