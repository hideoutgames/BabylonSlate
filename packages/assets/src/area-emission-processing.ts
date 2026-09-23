/*! @license
 * Native 9.20 AreaLightTextureTools filtering, moved off the render thread.
 * Algorithm adapted from Babylon.js (Apache-2.0), with cooperative progress.
 * https://github.com/BabylonJS/Babylon.js/blob/9.20.0/packages/dev/core/src/Misc/areaLightsTextureTools.ts
 */
import { AREA_EMISSION_EDGE } from "./area-emission";

type Checkpoint = (progress: number) => void | Promise<void>;
const mirrorTexel = (index: number, size: number) => {
  const repeat = ((index % (size * 2)) + size * 2) % (size * 2);
  return repeat >= size ? size * 2 - 1 - repeat : repeat;
};
const mirrorBlur = (index: number, size: number) => {
  const positive = index < 0 ? -index : index;
  return positive >= size ? size * 2 - 2 - positive : positive;
};

type Raster = { pixels: Uint8Array; width: number; height: number };

export const AREA_EMISSION_INTERIOR = AREA_EMISSION_EDGE * 0.75;

/** Area averaging for minification; mirrored linear sampling for magnification. */
async function resampleAxis(source: Raster, horizontal: boolean, checkpoint: Checkpoint): Promise<Raster> {
  const target = AREA_EMISSION_INTERIOR;
  const size = horizontal ? source.width : source.height;
  if (size === target) { await checkpoint(1); return source; }
  const contributions = Array.from({ length: target }, (_, pixel) => {
    if (size < target) {
      const center = (pixel + 0.5) * size / target - 0.5, first = Math.floor(center), fraction = center - first;
      return [[mirrorTexel(first, size), 1 - fraction], [mirrorTexel(first + 1, size), fraction]] as const;
    }
    const start = pixel * size / target, end = (pixel + 1) * size / target;
    return Array.from({ length: Math.ceil(end) - Math.floor(start) }, (_, offset) => {
      const index = Math.floor(start) + offset;
      return [index, (Math.min(end, index + 1) - Math.max(start, index)) / (end - start)] as const;
    });
  });
  const width = horizontal ? target : source.width, height = horizontal ? source.height : target;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (y % 16 === 0) await checkpoint(y / height);
    for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
      let value = 0;
      for (const [index, weight] of contributions[horizontal ? x : y]!)
        value += source.pixels[((horizontal ? y : index) * source.width + (horizontal ? index : x)) * 4 + c]! * weight;
      pixels[(y * width + x) * 4 + c] = Math.round(value);
    }
  }
  await checkpoint(1);
  return { pixels, width, height };
}

/** Deterministic source sampling, independent of backend mip-generation filters. */
export async function resampleAreaEmissionSource(source: Uint8Array, width: number, height: number, checkpoint: Checkpoint = () => {}): Promise<Uint8Array> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || source.byteLength !== width * height * 4) throw new Error("Invalid emission source pixels.");
  // Reduce the longer axis first to bound the intermediate raster.
  const horizontalFirst = width >= height;
  const first = await resampleAxis({ pixels: source, width, height }, horizontalFirst, (value) => checkpoint(value * 0.5));
  return (await resampleAxis(first, !horizontalFirst, (value) => checkpoint(0.5 + value * 0.5))).pixels;
}

/** Native copy of a canonical 768-square source: mirrored border and Y flip. */
function extendSource(source: Uint8Array): Uint8Array {
  const edge = AREA_EMISSION_EDGE;
  const interior = AREA_EMISSION_INTERIOR, margin = edge * 0.125;
  const result = new Uint8Array(edge * edge * 4);
  for (let y = 0; y < edge; y++) {
    const sy = mirrorTexel(edge - 1 - y - margin, interior);
    for (let x = 0; x < edge; x++) {
      const offset = (sy * interior + mirrorTexel(x - margin, interior)) * 4;
      for (let c = 0; c < 4; c++) result[(y * edge + x) * 4 + c] = source[offset + c]!;
    }
  }
  return result;
}

/** Pure separable native filter; small square inputs support focused algorithm tests. */
export async function filterAreaEmission(source: Uint8Array, edge: number, checkpoint: Checkpoint = () => {}): Promise<Uint8Array> {
  if (!Number.isInteger(edge) || edge < 8 || source.byteLength !== edge * edge * 4) throw new Error("Invalid emission filter input.");
  const start = Math.floor(edge * 0.125), end = Math.floor(edge * 0.875);
  const kernels = Array.from({ length: start + 2 }, (_, index) => {
    const size = 5 + (index + 1) * 2;
    const half = Math.floor(size / 2), sigma = size / 4;
    const weights = new Float32Array(size);
    let sum = 0;
    for (let k = -half; k <= half; k++) { const value = Math.exp(-k * k / (2 * sigma * sigma)); weights[k + half] = value; sum += value; }
    for (let k = 0; k < size; k++) weights[k] = weights[k]! / sum;
    return { weights, half };
  });
  let input = source;
  for (let pass = 0; pass < 2; pass++) {
    const output = new Uint8Array(input.length);
    for (let y = 0; y < edge; y++) {
      if (y % 8 === 0) await checkpoint((pass + y / edge) / 2);
      for (let x = 0; x < edge; x++) {
        const distance = Math.max(0, start - x, start - y, x - end, y - end);
        const { weights, half } = kernels[distance]!;
        // Write transposed so the same loop handles the vertical pass. Native
        // processing rounds each pass to RGBA8 and leaves alpha unfiltered.
        const destination = (x * edge + y) * 4;
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let k = -half; k <= half; k++) sum += input[(y * edge + mirrorBlur(x + k, edge)) * 4 + c]! * weights[k + half]!;
          output[destination + c] = Math.max(0, Math.min(255, Math.round(sum)));
        }
        output[destination + 3] = input[(y * edge + x) * 4 + 3]!;
      }
    }
    input = output;
  }
  await checkpoint(1);
  return input;
}

export async function processAreaEmissionRgba(source: Uint8Array, width: number, height: number, checkpoint: Checkpoint): Promise<Uint8Array> {
  await checkpoint(0);
  const canonical = await resampleAreaEmissionSource(source, width, height, (value) => checkpoint(value * 0.1));
  const extended = extendSource(canonical);
  return filterAreaEmission(extended, AREA_EMISSION_EDGE, (progress) => checkpoint(0.1 + progress * 0.9));
}
