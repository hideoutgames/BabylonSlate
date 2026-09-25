/** A bounded heightfield with four paint weights per vertex, in local X/Z space. */
export interface LandscapeProperties {
  width: number;
  depth: number;
  subdivisions: number;
  heights: number[];
  weights: number[];
  materialGuid: string | null;
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

export function parseLandscapeProperties(value: unknown): LandscapeProperties {
  const p = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const subdivisions = Math.round(finite(p.subdivisions, 64, 4, 256));
  const count = (subdivisions + 1) ** 2;
  const heights = Array.isArray(p.heights) ? p.heights : [];
  const weights = Array.isArray(p.weights) ? p.weights : [];
  const normalizedWeights = new Array<number>(count * 4);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let layer = 0; layer < 4; layer++) {
      const weight = finite(weights[i * 4 + layer], layer === 0 ? 1 : 0, 0, 1);
      normalizedWeights[i * 4 + layer] = weight;
      sum += weight;
    }
    for (let layer = 0; layer < 4; layer++) normalizedWeights[i * 4 + layer] = sum > 0
      ? normalizedWeights[i * 4 + layer]! / sum : layer === 0 ? 1 : 0;
  }
  return {
    width: finite(p.width, 64, 1, 4096),
    depth: finite(p.depth, 64, 1, 4096),
    subdivisions,
    heights: Array.from({ length: count }, (_, i) => finite(heights[i], 0, -10000, 10000)),
    weights: normalizedWeights,
    materialGuid: typeof p.materialGuid === "string" && p.materialGuid ? p.materialGuid : null,
  };
}

/** Each dab is immutable, allowing an entire drag to share one undo entry. */
export function sculptLandscape(
  terrain: LandscapeProperties,
  x: number,
  z: number,
  brush: LandscapeBrush,
): LandscapeProperties {
  if (![x, z, brush.radius, brush.strength].every(Number.isFinite) || brush.radius <= 0 || brush.strength <= 0) return terrain;
  const side = terrain.subdivisions + 1;
  const stepX = terrain.width / terrain.subdivisions;
  const stepZ = terrain.depth / terrain.subdivisions;
  const minX = Math.max(0, Math.ceil((x - brush.radius + terrain.width / 2) / stepX));
  const maxX = Math.min(side - 1, Math.floor((x + brush.radius + terrain.width / 2) / stepX));
  const minZ = Math.max(0, Math.ceil((z - brush.radius + terrain.depth / 2) / stepZ));
  const maxZ = Math.min(side - 1, Math.floor((z + brush.radius + terrain.depth / 2) / stepZ));
  const heights = terrain.heights.slice();
  const weights = brush.tool === "paint" ? terrain.weights.slice() : terrain.weights;
  const falloff = finite(brush.falloff, 0.5, 0.001, 1);
  let changed = false;
  for (let iz = minZ; iz <= maxZ; iz++) for (let ix = minX; ix <= maxX; ix++) {
    const distance = Math.hypot(ix * stepX - terrain.width / 2 - x, iz * stepZ - terrain.depth / 2 - z);
    if (distance >= brush.radius) continue;
    const t = Math.min(1, (1 - distance / brush.radius) / falloff);
    const amount = brush.strength * t * t * (3 - 2 * t);
    const index = iz * side + ix;
    const current = terrain.heights[index]!;
    if (brush.tool === "paint") {
      const layer = Math.round(finite(brush.layer, 0, 0, 3));
      const blend = Math.min(1, amount);
      for (let l = 0; l < 4; l++) weights[index * 4 + l] = terrain.weights[index * 4 + l]! * (1 - blend) + (l === layer ? blend : 0);
    } else if (brush.tool === "smooth") {
      let sum = 0; let count = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = ix + dx; const nz = iz + dz;
        if (nx >= 0 && nx < side && nz >= 0 && nz < side) { sum += terrain.heights[nz * side + nx]!; count++; }
      }
      heights[index] = current + (sum / count - current) * Math.min(1, amount);
    } else if (brush.tool === "flatten") {
      heights[index] = current + (finite(brush.height, 0, -10000, 10000) - current) * Math.min(1, amount);
    } else {
      heights[index] = Math.max(-10000, Math.min(10000, current + (brush.tool === "lower" ? -amount : amount)));
    }
    changed = true;
  }
  return changed ? { ...terrain, heights, weights } : terrain;
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
