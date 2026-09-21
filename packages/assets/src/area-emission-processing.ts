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

/** Reproduce the native mirrored sampler and 12.5% border; source rows are top-first. */
function extendSource(source: Uint8Array, width: number, height: number): Uint8Array {
  const edge = AREA_EMISSION_EDGE;
  const result = new Uint8Array(edge * edge * 4);
  for (let y = 0; y < edge; y++) {
    const sy = (1 - ((y + 0.5) / edge - 0.125) / 0.75) * height - 0.5;
    const iy = Math.floor(sy), fy = sy - iy;
    const ya = mirrorTexel(iy, height), yb = mirrorTexel(iy + 1, height);
    for (let x = 0; x < edge; x++) {
      const sx = ((x + 0.5) / edge - 0.125) / 0.75 * width - 0.5;
      const ix = Math.floor(sx), fx = sx - ix;
      const xa = mirrorTexel(ix, width), xb = mirrorTexel(ix + 1, width);
      for (let c = 0; c < 4; c++) {
        const top = source[(ya * width + xa) * 4 + c]! * (1 - fx) + source[(ya * width + xb) * 4 + c]! * fx;
        const bottom = source[(yb * width + xa) * 4 + c]! * (1 - fx) + source[(yb * width + xb) * 4 + c]! * fx;
        result[(y * edge + x) * 4 + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
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
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || source.byteLength !== width * height * 4) throw new Error("Invalid emission source pixels.");
  await checkpoint(0);
  return filterAreaEmission(extendSource(source, width, height), AREA_EMISSION_EDGE, checkpoint);
}
