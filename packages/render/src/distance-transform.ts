/**
 * Babylon-free, so the water contact worker (`water-contact.worker.ts`) can import it without bundling the engine.
 */
const INF = 1e20;

/**
 * Squared Euclidean distance transform (Felzenszwalb-Huttenlocher), in cell units, in place.
 * Seeds may carry a non-zero squared offset, e.g. a vertical gap, which the transform preserves.
 */
export function distanceTransform<T extends Float32Array | Float64Array>(grid: T, width: number, height: number, region?: DistanceRegion): T {
  const size = Math.max(width, height);
  if (edtF.length < size) { edtF = new Float64Array(size); edtD = new Float64Array(size); edtV = new Int32Array(size); edtZ = new Float64Array(size + 1); }
  const f = edtF, d = edtD;
  // Only `region`'s cells are wanted: columns keep the rows inside it, then only its rows run, for its columns.
  const x0 = region?.x0 ?? 0, z0 = region?.z0 ?? 0, x1 = region?.x1 ?? width, z1 = region?.z1 ?? height, cap = region?.cap ?? Infinity;
  // Columns, then rows. A line without any seed (every value at or beyond INF) stays as it is: it would come out as
  // INF plus a squared offset far below INF's precision, which callers clamp to their range anyway. With a `cap`, a
  // row whose every column distance is beyond it ends beyond it too, and is left as it is for the same reason.
  for (let x = 0; x < width; x++) {
    let seeded = false;
    for (let i = 0, j = x; i < height; i++, j += width) { const value = grid[j]!; f[i] = value; if (value < INF) seeded = true; }
    if (!seeded) continue;
    lowerEnvelope(height, z0, z1);
    for (let i = z0, j = z0 * width + x; i < z1; i++, j += width) grid[j] = d[i]!;
  }
  for (let y = z0; y < z1; y++) {
    const row = y * width;
    let near = false;
    for (let i = 0; i < width; i++) { const value = grid[row + i]!; f[i] = value; if (value <= cap) near = true; }
    if (!near) continue;
    lowerEnvelope(width, x0, x1);
    for (let i = x0; i < x1; i++) grid[row + i] = d[i]!;
  }
  return grid;
}

/**
 * The cells of a `distanceTransform` a caller reads ([x0, x1) × [z0, z1)); others are left unfinished. `cap` (squared
 * cells) is the largest distance the caller tells apart: anything beyond it may be left at any value beyond it.
 */
export type DistanceRegion = { x0: number; z0: number; x1: number; z1: number; cap?: number };

/** Scratch lines of `distanceTransform`, grown on demand and shared (allocation-free once grown). */
let edtF = new Float64Array(0), edtD = new Float64Array(0), edtV = new Int32Array(0), edtZ = new Float64Array(1);

/**
 * One line of the transform: the lower envelope of parabolas rooted at `edtF`'s first `n` values, evaluated into
 * `edtD` for positions [from, to).
 */
function lowerEnvelope(n: number, from: number, to: number): void {
  const f = edtF, d = edtD, v = edtV, z = edtZ;
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) { k--; s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = from; q < to; q++) {
    while (z[k + 1]! < q) k++;
    d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
  }
}
