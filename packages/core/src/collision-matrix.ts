/**
 * Project Collision Matrix: which named collision layers collide. Row `i` is
 * a 32-bit mask of the layers layer `i` collides with. Colliders whose
 * Collides With is "project" take their mask from the rows of their layer;
 * "custom" colliders keep their own mask.
 */

const ALL_LAYERS = 0xffffffff;

/** Where a collider's Collides With mask comes from. Missing is "custom", so older documents keep their masks. */
export type CollisionMaskSource = "project" | "custom";

export function parseCollisionMaskSource(value: unknown): CollisionMaskSource {
  return value === "project" ? "project" : "custom";
}

const bit = (row: number, index: number) => ((row >>> index) & 1) === 1;

/**
 * One row per named layer, symmetric: two layers collide only when both rows
 * agree, as the physics test needs both colliders to accept each other. Bits
 * past the named layers stay set, so an unnamed layer still collides with all.
 */
export function normalizeCollisionMatrix(value: unknown, layerCount: number): number[] {
  const count = Math.max(0, Math.min(32, Math.floor(layerCount)));
  const source = Array.isArray(value) ? value : [];
  const rows = Array.from({ length: count }, (_, index) => {
    const raw = source[index];
    return typeof raw === "number" && Number.isInteger(raw) ? raw >>> 0 : ALL_LAYERS;
  });
  const unnamed = count >= 32 ? 0 : (ALL_LAYERS << count) >>> 0;
  return rows.map((row, i) => {
    let next = unnamed;
    for (let j = 0; j < count; j += 1) {
      if (bit(row, j) && bit(rows[j]!, i)) next = (next | (1 << j)) >>> 0;
    }
    return next;
  });
}

/** Whether layers `a` and `b` (bit indices) collide under the matrix. */
export function collisionMatrixAllows(matrix: readonly number[], a: number, b: number): boolean {
  return bit(matrix[a] ?? ALL_LAYERS, b) && bit(matrix[b] ?? ALL_LAYERS, a);
}

/** The matrix with the pair `a`/`b` set to collide or not, on both rows. */
export function setCollisionMatrixPair(
  matrix: readonly number[],
  a: number,
  b: number,
  collides: boolean,
): number[] {
  return matrix.map((row, index) => {
    const other = index === a ? b : index === b ? a : -1;
    if (other < 0) return row;
    return (collides ? row | (1 << other) : row & ~(1 << other)) >>> 0;
  });
}

/**
 * The mask a collider uses. A "project" collider ORs the matrix rows of every
 * layer bit it sits on (layer 0 collides with nothing); without a matrix, or
 * for a "custom" collider, its own mask stands.
 */
export function resolveCollisionMask(
  layer: number,
  mask: number,
  source: CollisionMaskSource,
  matrix: readonly number[] | undefined,
): number {
  if (source !== "project" || !matrix) return mask >>> 0;
  let resolved = 0;
  for (let index = 0; index < 32; index += 1) {
    if (bit(layer >>> 0, index)) resolved = (resolved | (matrix[index] ?? ALL_LAYERS)) >>> 0;
  }
  return resolved;
}
