/**
 * Per-pixel blend ownership (`WATER_OWNERSHIP_DEFINE`): which of a blending water surface's participants owns a pixel,
 * evaluated in the Water Cut from the participants' footprints, so the seam is exact at any grid cell size.
 *
 * The per-vertex ownership margin (`slateWaterBlend.z`) is interpolated linearly across the surface's triangles. Global
 * Water and spectrum Oceans grade their grids around the camera, so away from it a cell can span the whole blend band
 * or a whole neighbour: there the interpolated seam misses the neighbour's own, which leaves gaps (and overlaps, where
 * both draw and their depth pre-passes fight). For bodies whose footprints are analytic (Global Water Volume, Ocean,
 * Lake, Puddle), level (turned about the vertical only) and few, the cut evaluates `evaluateWaterBlend`'s ownership per
 * pixel instead: each participant's bank distance, coverage φ = smoothstep(−R/2, R/2, distance) × its vertical fade,
 * shares φ × Π(1 − φ of each higher class) normalised, and the margin own share − the strongest other's. Which surfaces
 * qualify depends only on the bodies and their neighbourhoods (kinds, count, levelness), never on the camera, so moving
 * it or regrading a grid writes uniforms and compiles nothing. Every other surface keeps the per-vertex margin.
 */
import { waterBlendVerticalTolerance, type WaterBlendIndex } from "@haptic/core";

export const WATER_OWNERSHIP_DEFINE = "SLATE_WATER_OWNERSHIP";
/** Participants the per-pixel ownership evaluates: the surface itself and up to three neighbours. */
export const WATER_OWNERSHIP_PARTICIPANTS = 4;
/**
 * Per participant k: `slateWaterOwnA{k}` (world position X, Z; scale X, Z), `slateWaterOwnB{k}` (the world directions
 * of local X and Z in X/Z), `slateWaterOwnC{k}` (footprint: 0 open water, 1 box, 2 ellipse; half width; half length;
 * vertical fade, 0 for an empty slot); `slateWaterOwnClass` (the four blend classes) and `slateWaterOwnInfo` (x: half
 * the Blend Distance).
 */
export const WATER_OWNERSHIP_UNIFORMS = [
  ...Array.from({ length: WATER_OWNERSHIP_PARTICIPANTS }, (_, k) => [`slateWaterOwnA${k}`, `slateWaterOwnB${k}`, `slateWaterOwnC${k}`]).flat(),
  "slateWaterOwnClass", "slateWaterOwnInfo",
];
/** Floats `blendOwnership` writes: the uniforms above in order, four per vector. */
export const WATER_OWNERSHIP_FLOATS = WATER_OWNERSHIP_UNIFORMS.length * 4;

const footprintCode = (kind: string) => kind === "global" ? 0 : kind === "ocean" ? 1 : kind === "lake" || kind === "puddle" ? 2 : -1;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The per-pixel ownership inputs of body `self` in `index` into `out`, or null when it does not qualify: a footprint the
 * cut cannot evaluate (a river), a body turned out of level, or more neighbours than `WATER_OWNERSHIP_PARTICIPANTS`
 * leaves room for. Neighbours are the index's (within the Blend Distance and the vertical tolerance), so the answer
 * changes only when bodies are added, removed, moved or edited, never with the camera.
 */
export function blendOwnership(index: WaterBlendIndex, self: number, out: Float32Array | null): Float32Array | null {
  const neighbours = index.neighbours(self);
  if (!neighbours.length || neighbours.length + 1 > WATER_OWNERSHIP_PARTICIPANTS || index.distance <= 0) return null;
  const list = [self, ...neighbours];
  for (const i of list) {
    const prepared = index.bodies[i]!, q = prepared.transform.rotation;
    if (footprintCode(prepared.body.kind) < 0) return null;
    // Turned about the vertical only: local up stays world up (the rotated Y axis has no X or Z part).
    const upX = 2 * (q.x * q.y - q.w * q.z), upZ = 2 * (q.y * q.z + q.w * q.x);
    if (Math.abs(upX) > 1e-6 || Math.abs(upZ) > 1e-6) return null;
  }
  const data = out ?? new Float32Array(WATER_OWNERSHIP_FLOATS);
  data.fill(0);
  const own = index.bodies[self]!, tolerance = waterBlendVerticalTolerance(index.distance);
  const classes = WATER_OWNERSHIP_PARTICIPANTS * 12;
  for (let k = 0; k < list.length; k++) {
    const prepared = index.bodies[list[k]!]!, { position, rotation: q, scale } = prepared.transform, body = prepared.body;
    const o = k * 12;
    data[o] = position.x; data[o + 1] = position.z; data[o + 2] = Math.abs(scale.x) || 1e-6; data[o + 3] = Math.abs(scale.z) || 1e-6;
    // The world X/Z directions of local X and Z (a turn about the vertical).
    data[o + 4] = 1 - 2 * (q.y * q.y + q.z * q.z); data[o + 5] = 2 * (q.x * q.z - q.w * q.y);
    data[o + 6] = 2 * (q.x * q.z + q.w * q.y); data[o + 7] = 1 - 2 * (q.x * q.x + q.y * q.y);
    data[o + 8] = footprintCode(body.kind); data[o + 9] = body.width / 2; data[o + 10] = body.length / 2;
    // A level body's rest surface is its own height everywhere: the vertical fade between two is constant.
    data[o + 11] = 1 - smoothstep(tolerance, 2 * tolerance, Math.abs(position.y - own.transform.position.y));
    data[classes + k] = prepared.blendClass;
  }
  data[classes + 4] = index.distance / 2;
  return data;
}

/** Bank distance in world metres of participant `k` at world X/Z: the cut's `swOwnEdge`, as `waterFootprint` and `waterBankDistance` give it. */
function ownEdge(data: Float32Array, k: number, x: number, z: number): number {
  const o = k * 12, sx = data[o + 2]!, sz = data[o + 3]!, kind = data[o + 8]!, hw = data[o + 9]!, hl = data[o + 10]!;
  if (kind < 0.5) return 1e6;
  const dx = x - data[o]!, dz = z - data[o + 1]!;
  const lx = (dx * data[o + 4]! + dz * data[o + 5]!) / sx, lz = (dx * data[o + 6]! + dz * data[o + 7]!) / sz;
  if (kind < 1.5) {
    const ex = hw - Math.abs(lx), ez = hl - Math.abs(lz);
    return ex < ez ? ex * sx : ez * sz;
  }
  const radius = Math.hypot(lx / hw, lz / hl), gx = lx / (hw * hw), gz = lz / (hl * hl), gradient = Math.hypot(gx, gz);
  if (gradient <= 1e-6) return Math.min(hw, hl) * sx;
  return (1 - radius) * radius / gradient / Math.hypot(gx / gradient / sx, gz / gradient / sz);
}

/** The per-pixel margin the cut computes at world X/Z (own share − the strongest other's; −1 where nobody has water). */
export function blendOwnershipAt(data: Float32Array, x: number, z: number): number {
  const classes = WATER_OWNERSHIP_PARTICIPANTS * 12, half = data[classes + 4]!;
  const phi: number[] = [];
  for (let k = 0; k < WATER_OWNERSHIP_PARTICIPANTS; k++) phi.push(smoothstep(-half, half, ownEdge(data, k, x, z)) * data[k * 12 + 11]!);
  const raw = phi.map((value, a) => {
    let share = value;
    for (let b = 0; b < WATER_OWNERSHIP_PARTICIPANTS; b++) if (b !== a && data[classes + b]! > data[classes + a]! + 0.5) share *= 1 - phi[b]!;
    return share;
  });
  const total = raw.reduce((sum, value) => sum + value, 0);
  return total > 0 ? (raw[0]! - Math.max(raw[1]!, raw[2]!, raw[3]!)) / total : -1;
}

/**
 * The cut's GLSL-shaped ownership (`swOwnership(p)`, the margin `blendOwnershipAt` computes at world X/Z `p`), unrolled
 * over the participants. `bind` translates it for WGSL.
 */
export function ownershipSource(): string {
  const n = WATER_OWNERSHIP_PARTICIPANTS, k = Array.from({ length: n }, (_, i) => i), c = "xyzw";
  const phi = k.map((i) => `  float swOwnPhi${i} = smoothstep(-swOwnHalf, swOwnHalf, swOwnEdge(U.slateWaterOwnA${i}, U.slateWaterOwnB${i}, U.slateWaterOwnC${i}, p)) * U.slateWaterOwnC${i}.w;`);
  const raw = k.map((a) => `  float swOwnRaw${a} = swOwnPhi${a}${k.filter((b) => b !== a).map((b) =>
    ` * mix(1.0, 1.0 - swOwnPhi${b}, step(U.slateWaterOwnClass.${c[a]} + 0.5, U.slateWaterOwnClass.${c[b]}))`).join("")};`);
  return `
float swOwnEdge(vec4 a, vec4 b, vec4 c, vec2 p) {
  if (c.x < 0.5) { return 1000000.0; }
  vec2 d = p - a.xy;
  vec2 l = vec2(dot(d, b.xy), dot(d, b.zw)) / a.zw;
  if (c.x < 1.5) {
    float ex = c.y - abs(l.x);
    float ez = c.z - abs(l.y);
    if (ex < ez) { return ex * a.z; }
    return ez * a.w;
  }
  float r = length(l / c.yz);
  vec2 g = l / (c.yz * c.yz);
  float gl = length(g);
  if (gl <= 0.000001) { return min(c.y, c.z) * a.z; }
  return (1.0 - r) * r / gl / length(g / gl / a.zw);
}
float swOwnership(vec2 p) {
  float swOwnHalf = U.slateWaterOwnInfo.x;
${phi.join("\n")}
${raw.join("\n")}
  float swOwnTotal = ${k.map((i) => `swOwnRaw${i}`).join(" + ")};
  if (swOwnTotal <= 0.0) { return -1.0; }
  return (swOwnRaw0 - max(swOwnRaw1, max(swOwnRaw2, swOwnRaw3))) / swOwnTotal;
}
`;
}
