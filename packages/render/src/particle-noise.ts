/**
 * Noise data the Particle Graph Noise node samples on the CPU (`SlateNoiseBlock`): the built-in
 * noise, generated once from a fixed seed (procedural data, not shipped artwork), or a Texture
 * asset's pixels read back once. RGBA8, row-major; Babylon's `_fetchR` reads the red channel.
 */
export interface ParticleNoisePixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A Noise node's pixels; null until a Texture's read-back lands (the node pushes nothing until then). */
export interface ParticleNoiseSource {
  pixels(): ParticleNoisePixels | null;
}

export const PARTICLE_BUILTIN_NOISE_SIZE = 256;
const BUILTIN_NOISE_SEED = 0x5eed;
/** Lattice cells across the built-in noise per octave, coarsest first. */
const BUILTIN_NOISE_OCTAVES = [8, 16, 32] as const;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Tileable fractal value noise in 0–1, one independent field per R, G and B; alpha 255. Deterministic. */
export function createParticleBuiltinNoise(size = PARTICLE_BUILTIN_NOISE_SIZE, seed = BUILTIN_NOISE_SEED): ParticleNoisePixels {
  const random = mulberry32(seed);
  const data = new Uint8Array(size * size * 4);
  const field = new Float32Array(size * size);
  for (let channel = 0; channel < 3; channel += 1) {
    field.fill(0);
    let weight = 0.5;
    let total = 0;
    for (const cells of BUILTIN_NOISE_OCTAVES) {
      const lattice = Float32Array.from({ length: cells * cells }, () => random());
      const at = (x: number, y: number) => lattice[(y % cells) * cells + (x % cells)]!;
      for (let y = 0; y < size; y += 1) {
        const v = (y / size) * cells;
        const y0 = Math.floor(v);
        const ty = smooth(v - y0);
        for (let x = 0; x < size; x += 1) {
          const u = (x / size) * cells;
          const x0 = Math.floor(u);
          const tx = smooth(u - x0);
          const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
          const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
          field[y * size + x]! += (top + (bottom - top) * ty) * weight;
        }
      }
      total += weight;
      weight *= 0.5;
    }
    for (let index = 0; index < field.length; index += 1) data[index * 4 + channel] = Math.round((field[index]! / total) * 255);
  }
  for (let index = 0; index < size * size; index += 1) data[index * 4 + 3] = 255;
  return { width: size, height: size, data };
}

let builtin: ParticleNoisePixels | null = null;

/** The built-in noise, generated on first use and shared by every service. */
export const BUILTIN_PARTICLE_NOISE: ParticleNoiseSource = {
  pixels: () => (builtin ??= createParticleBuiltinNoise()),
};

/** RGBA8 pixels from a read-back (8-bit or float channels); null when the size and data disagree. */
export function particleNoisePixelsFrom(view: ArrayBufferView, size: { width: number; height: number }): ParticleNoisePixels | null {
  const count = size.width * size.height * 4;
  if (!count) return null;
  if (view instanceof Uint8Array || view instanceof Uint8ClampedArray) {
    return view.length >= count ? { width: size.width, height: size.height, data: Uint8Array.from(view.subarray(0, count)) } : null;
  }
  if (view instanceof Float32Array) {
    if (view.length < count) return null;
    const data = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) data[index] = Math.round(Math.min(1, Math.max(0, view[index]!)) * 255);
    return { width: size.width, height: size.height, data };
  }
  return null;
}
