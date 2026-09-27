import type { Flags, MeshoptSimplifier } from "meshoptimizer/simplifier";

/**
 * Screen size (projected bounding-sphere diameter / viewport height) below
 * which each generated level starts, before the quality distance scale.
 */
export const AUTO_LOD_SCREEN_SIZES = [0.5, 0.25, 0.125] as const;
/** Deforming meshes are measured in bind pose, so they keep ratio floors. */
const DEFORMING_TRIANGLE_RATIOS = [0.5, 0.25, 0.125] as const;
/** Static meshes are error-driven down to this fraction of their triangles. */
const MIN_TRIANGLE_FRACTION = 0.01;
const MIN_LEVEL_TRIANGLES = 64;
/** A level must remove at least this fraction of the previous level's triangles. */
const MIN_REDUCTION = 0.2;
/**
 * meshoptimizer's quadric estimate can understate the true deviation by up to
 * about 1.6×, so a 1 px estimate keeps levels within about 2 px at their
 * switch point on a 1080 px view.
 */
const ERROR_PIXELS = 1;
const REFERENCE_HEIGHT = 1080;
/** Normal and UV error weights; 1 would trade away more position quality. */
const NORMAL_WEIGHT = 0.5;
const UV_WEIGHT = 0.5;

/** One mesh's simplification input: shared vertex streams and per-submesh index ranges. */
export type LodSimplifyInput = {
  positions: Float32Array;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  /** Triangle indices of each submesh, referencing the shared vertex streams. */
  ranges: Uint32Array[];
  deforming: boolean;
};

export type LodLevelIndices = {
  screenSize: number;
  /** Simplified indices of each input submesh, in input order. */
  ranges: Uint32Array[];
  triangles: number;
};

type Simplifier = typeof MeshoptSimplifier;

function attributeStream(input: LodSimplifyInput): { data: Float32Array; stride: number; weights: number[] } | null {
  const vertexCount = input.positions.length / 3;
  const normals = input.normals?.length === vertexCount * 3 ? input.normals : null;
  const uvs = input.uvs?.length === vertexCount * 2 ? input.uvs : null;
  if (!normals && !uvs) return null;
  const stride = (normals ? 3 : 0) + (uvs ? 2 : 0);
  const data = new Float32Array(vertexCount * stride);
  const weights: number[] = [];
  if (normals) weights.push(NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT);
  if (uvs) {
    // Weight UVs against their own range so tiled and atlas UVs both stay put.
    const range = [0, 1].map((axis) => {
      let min = Infinity;
      let max = -Infinity;
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        const value = uvs[vertex * 2 + axis]!;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      return Math.max(max - min, 1e-3);
    });
    weights.push(UV_WEIGHT / range[0]!, UV_WEIGHT / range[1]!);
  }
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    let offset = vertex * stride;
    if (normals) {
      data[offset++] = normals[vertex * 3]!;
      data[offset++] = normals[vertex * 3 + 1]!;
      data[offset++] = normals[vertex * 3 + 2]!;
    }
    if (uvs) {
      data[offset++] = uvs[vertex * 2]!;
      data[offset] = uvs[vertex * 2 + 1]!;
    }
  }
  return { data, stride, weights };
}

/**
 * Cascaded levels over the source vertices: each level simplifies the previous
 * one, spending only the remaining error budget, so levels stay within their
 * pixel budget and later levels are cheaper to compute.
 */
export function simplifyLevels(simplifier: Simplifier, input: LodSimplifyInput): LodLevelIndices[] {
  const scale = simplifier.getScale(input.positions, 3);
  const attributes = attributeStream(input);
  const flags: Flags[] = ["LockBorder", "ErrorAbsolute"];
  // Deforming meshes keep better triangle shapes under skinning and morphs.
  if (input.deforming) flags.push("Regularize");
  const sourceTriangles = input.ranges.reduce((total, range) => total + range.length / 3, 0);
  const floor = Math.max(MIN_LEVEL_TRIANGLES, Math.ceil(sourceTriangles * MIN_TRIANGLE_FRACTION));
  const levels: LodLevelIndices[] = [];
  let current = input.ranges;
  let currentTriangles = sourceTriangles;
  let spentError = 0;
  for (const [level, screenSize] of AUTO_LOD_SCREEN_SIZES.entries()) {
    const budget = (ERROR_PIXELS / (screenSize * REFERENCE_HEIGHT)) * scale;
    const error = budget - spentError;
    if (error <= 0) continue;
    const targetTriangles = input.deforming
      ? Math.floor(sourceTriangles * DEFORMING_TRIANGLE_RATIOS[level]!)
      : floor;
    let worst = 0;
    const ranges = current.map((range) => {
      if (range.length === 0 || range.length % 3 !== 0) return range;
      // Share the target across submeshes in proportion to their triangles.
      const share = Math.floor((targetTriangles * range.length) / (3 * currentTriangles)) * 3;
      const target = Math.min(range.length, Math.max(3, share));
      const [indices, reached] = attributes
        ? simplifier.simplifyWithAttributes(range, input.positions, 3, attributes.data, attributes.stride,
          attributes.weights, null, target, error, flags)
        : simplifier.simplify(range, input.positions, 3, target, error, flags);
      worst = Math.max(worst, reached);
      return indices;
    });
    const triangles = ranges.reduce((total, range) => total + range.length / 3, 0);
    // A later level has a larger error budget and may still reduce enough.
    if (triangles > currentTriangles * (1 - MIN_REDUCTION)) continue;
    levels.push({ screenSize, ranges, triangles });
    current = ranges;
    currentTriangles = triangles;
    spentError += worst;
    // A static level at its floor has no triangles left to remove.
    if (!input.deforming && triangles <= floor) break;
  }
  return levels;
}
