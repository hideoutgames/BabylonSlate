/** A bounded heightfield with four paint weights per vertex, in local X/Z space. */
export interface LandscapeProperties {
  width: number;
  depth: number;
  subdivisions: number;
  heights: number[];
  weights: number[];
  materialGuid: string | null;
  collisionsEnabled: boolean;
}

export type LandscapeBrushTool = "raise" | "lower" | "smooth" | "flatten" | "paint";
export interface LandscapeBrush {
  tool: LandscapeBrushTool;
  radius: number;
  strength: number;
  falloff: number;
  height: number;
  layer: number;
}

function finite(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

/** Clamps one vertex's four layer weights and rescales them to sum to one (`target` may be `source`). Normalizing its own output can still move the last bits. */
function normalizeVertexWeights(source: ArrayLike<unknown>, target: number[], vertex: number): void {
  const at = vertex * 4;
  let sum = 0;
  for (let layer = 0; layer < 4; layer++) {
    const weight = finite(source[at + layer], layer === 0 ? 1 : 0, 0, 1);
    target[at + layer] = weight;
    sum += weight;
  }
  for (let layer = 0; layer < 4; layer++) target[at + layer] = sum > 0
    ? target[at + layer]! / sum : layer === 0 ? 1 : 0;
}

export function parseLandscapeProperties(value: unknown): LandscapeProperties {
  const p = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const subdivisions = Math.round(finite(p.subdivisions, 64, 4, 256));
  const count = (subdivisions + 1) ** 2;
  const heights = Array.isArray(p.heights) ? p.heights : [];
  const weights = Array.isArray(p.weights) ? p.weights : [];
  const normalizedWeights = new Array<number>(count * 4);
  for (let i = 0; i < count; i++) normalizeVertexWeights(weights, normalizedWeights, i);
  return {
    width: finite(p.width, 64, 1, 4096),
    depth: finite(p.depth, 64, 1, 4096),
    subdivisions,
    heights: Array.from({ length: count }, (_, i) => finite(heights[i], 0, -10000, 10000)),
    weights: normalizedWeights,
    materialGuid: typeof p.materialGuid === "string" && p.materialGuid ? p.materialGuid : null,
    collisionsEnabled: p.collisionsEnabled === true,
  };
}

/** Authored terrain triangles shared by runtime physics and editor Drop queries. */
export function landscapeCollisionMesh(value: unknown) {
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).collisionsEnabled !== true) return null;
  const data = parseLandscapeProperties(value);
  const side = data.subdivisions + 1;
  const positions = new Float32Array(side * side * 3);
  const triangleCorners = data.subdivisions * data.subdivisions * 6;
  const indices = side * side <= 0x10000 ? new Uint16Array(triangleCorners) : new Uint32Array(triangleCorners);
  let corner = 0;
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    const a = z * side + x;
    positions[a * 3] = x * data.width / data.subdivisions - data.width / 2;
    positions[a * 3 + 1] = data.heights[a]!;
    positions[a * 3 + 2] = z * data.depth / data.subdivisions - data.depth / 2;
    if (x < data.subdivisions && z < data.subdivisions) {
      const b = a + side;
      // Match the rendered heightfield's diagonal and upward-facing winding.
      indices.set([a, a + 1, b, a + 1, b + 1, b], corner);
      corner += 6;
    }
  }
  return { kind: "mesh" as const, positions, indices };
}

/** The vertices a dab changes, computed from the untouched heightfield: `heights[n]` for non-paint tools, `weights[4n..4n+3]` for paint. */
interface SculptPatch {
  indices: number[];
  heights: number[];
  weights: number[];
}

/** `null` for a dab that cannot apply (non-finite or non-positive brush). */
function sculptPatch(terrain: LandscapeProperties, x: number, z: number, brush: LandscapeBrush): SculptPatch | null {
  if (![x, z, brush.radius, brush.strength].every(Number.isFinite) || brush.radius <= 0 || brush.strength <= 0) return null;
  const side = terrain.subdivisions + 1;
  const stepX = terrain.width / terrain.subdivisions;
  const stepZ = terrain.depth / terrain.subdivisions;
  const minX = Math.max(0, Math.ceil((x - brush.radius + terrain.width / 2) / stepX));
  const maxX = Math.min(side - 1, Math.floor((x + brush.radius + terrain.width / 2) / stepX));
  const minZ = Math.max(0, Math.ceil((z - brush.radius + terrain.depth / 2) / stepZ));
  const maxZ = Math.min(side - 1, Math.floor((z + brush.radius + terrain.depth / 2) / stepZ));
  const falloff = finite(brush.falloff, 0.5, 0.001, 1);
  const patch: SculptPatch = { indices: [], heights: [], weights: [] };
  for (let iz = minZ; iz <= maxZ; iz++) for (let ix = minX; ix <= maxX; ix++) {
    const distance = Math.hypot(ix * stepX - terrain.width / 2 - x, iz * stepZ - terrain.depth / 2 - z);
    if (distance >= brush.radius) continue;
    const t = Math.min(1, (1 - distance / brush.radius) / falloff);
    const amount = brush.strength * t * t * (3 - 2 * t);
    const index = iz * side + ix;
    const current = terrain.heights[index]!;
    patch.indices.push(index);
    if (brush.tool === "paint") {
      const layer = Math.round(finite(brush.layer, 0, 0, 3));
      const blend = Math.min(1, amount);
      for (let l = 0; l < 4; l++) patch.weights.push(terrain.weights[index * 4 + l]! * (1 - blend) + (l === layer ? blend : 0));
    } else if (brush.tool === "smooth") {
      let sum = 0; let count = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = ix + dx; const nz = iz + dz;
        if (nx >= 0 && nx < side && nz >= 0 && nz < side) { sum += terrain.heights[nz * side + nx]!; count++; }
      }
      patch.heights.push(current + (sum / count - current) * Math.min(1, amount));
    } else if (brush.tool === "flatten") {
      patch.heights.push(current + (finite(brush.height, 0, -10000, 10000) - current) * Math.min(1, amount));
    } else {
      patch.heights.push(Math.max(-10000, Math.min(10000, current + (brush.tool === "lower" ? -amount : amount))));
    }
  }
  return patch;
}

function writePatch(patch: SculptPatch, paint: boolean, heights: number[], weights: number[]): void {
  for (let n = 0; n < patch.indices.length; n++) {
    const index = patch.indices[n]!;
    if (paint) for (let l = 0; l < 4; l++) weights[index * 4 + l] = patch.weights[n * 4 + l]!;
    else heights[index] = patch.heights[n]!;
  }
}

/** Each dab is immutable, allowing an entire drag to share one undo entry. */
export function sculptLandscape(
  terrain: LandscapeProperties,
  x: number,
  z: number,
  brush: LandscapeBrush,
): LandscapeProperties {
  const patch = sculptPatch(terrain, x, z, brush);
  if (!patch?.indices.length) return terrain;
  const paint = brush.tool === "paint";
  const heights = terrain.heights.slice();
  const weights = paint ? terrain.weights.slice() : terrain.weights;
  writePatch(patch, paint, heights, weights);
  return { ...terrain, heights, weights };
}

/**
 * One drag's dabs applied to a single working heightfield. After every dab
 * `snapshot()` equals the document a host would have produced by re-parsing
 * the previous result before each `sculptLandscape` (`{ ...sculptLandscape(
 * parseLandscapeProperties(previous), ... ) }`), bit for bit, without
 * re-parsing and copying the whole terrain per dab.
 *
 * The equivalence includes a quirk of that chain: every parse clamps heights
 * and re-normalizes weights, and normalizing weights that are already
 * normalized can still move their last bits (some vertices never settle). So
 * each dab first repeats the parse for the vertices a parse could still change,
 * which are those the previous dab wrote and those whose weights have not yet
 * reached a fixed point; the rest are provably untouched by it.
 */
export class LandscapeSculptSession {
  private readonly terrain: LandscapeProperties;
  /** Vertices whose clamp/normalization the next parse could still change. */
  private readonly pending: Uint32Array;
  private pendingCount: number;
  private readonly isPending: Uint8Array;
  private dabs = 0;

  constructor(properties: unknown) {
    this.terrain = parseLandscapeProperties(properties);
    const count = (this.terrain.subdivisions + 1) ** 2;
    this.pending = new Uint32Array(count);
    this.isPending = new Uint8Array(count).fill(1);
    // The first reparse checks every vertex; those already at a fixed point drop out.
    for (let i = 0; i < count; i++) this.pending[i] = i;
    this.pendingCount = count;
  }

  /** Applies one dab at local `(x, z)`; the brush has the same meaning as for `sculptLandscape`. */
  dab(x: number, z: number, brush: LandscapeBrush): void {
    // The first dab sculpts the constructor's parse; every later one re-parses the previous result.
    if (this.dabs++ > 0) this.reparse();
    const patch = sculptPatch(this.terrain, x, z, brush);
    if (!patch) return;
    writePatch(patch, brush.tool === "paint", this.terrain.heights, this.terrain.weights);
    for (const index of patch.indices) if (!this.isPending[index]) {
      this.isPending[index] = 1;
      this.pending[this.pendingCount++] = index;
    }
  }

  /** The terrain after the dabs so far, as plain data that later dabs do not change. */
  snapshot(): LandscapeProperties {
    return { ...this.terrain, heights: this.terrain.heights.slice(), weights: this.terrain.weights.slice() };
  }

  private reparse(): void {
    const { heights, weights } = this.terrain;
    let kept = 0;
    for (let n = 0; n < this.pendingCount; n++) {
      const vertex = this.pending[n]!;
      heights[vertex] = finite(heights[vertex], 0, -10000, 10000);
      const at = vertex * 4;
      const w0 = weights[at]!; const w1 = weights[at + 1]!; const w2 = weights[at + 2]!; const w3 = weights[at + 3]!;
      normalizeVertexWeights(weights, weights, vertex);
      if (w0 !== weights[at] || w1 !== weights[at + 1] || w2 !== weights[at + 2] || w3 !== weights[at + 3]) this.pending[kept++] = vertex;
      else this.isPending[vertex] = 0;
    }
    this.pendingCount = kept;
  }
}

/** Resample a heightfield when its resolution changes, preserving the authored shape. */
export function resizeLandscape(terrain: LandscapeProperties, subdivisions: number): LandscapeProperties {
  const next = parseLandscapeProperties({ ...terrain, subdivisions, heights: [], weights: [] });
  const oldSide = terrain.subdivisions + 1;
  const side = next.subdivisions + 1;
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    const sx = x / next.subdivisions * terrain.subdivisions;
    const sz = z / next.subdivisions * terrain.subdivisions;
    const x0 = Math.floor(sx); const z0 = Math.floor(sz);
    const x1 = Math.min(x0 + 1, oldSide - 1); const z1 = Math.min(z0 + 1, oldSide - 1);
    const tx = sx - x0; const tz = sz - z0;
    const sample = (data: number[], stride: number, channel: number) =>
      data[(z0 * oldSide + x0) * stride + channel]! * (1 - tx) * (1 - tz) +
      data[(z0 * oldSide + x1) * stride + channel]! * tx * (1 - tz) +
      data[(z1 * oldSide + x0) * stride + channel]! * (1 - tx) * tz +
      data[(z1 * oldSide + x1) * stride + channel]! * tx * tz;
    next.heights[z * side + x] = sample(terrain.heights, 1, 0);
    for (let layer = 0; layer < 4; layer++) next.weights[(z * side + x) * 4 + layer] = sample(terrain.weights, 4, layer);
  }
  return next;
}
