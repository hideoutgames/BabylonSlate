/**
 * Bounds that follow a skinned mesh's pose, without skinning its vertices on the CPU.
 *
 * A skinned vertex is drawn at a weighted mean of where each of its bones would put it: Σ wᵢ · (Mᵢ · p), the weights
 * positive and summing to one (a sum short of one scales the homogeneous coordinate with the rest, so the projected
 * point is the same mean with the weights normalised). It therefore lies inside the hull of those places. So the box of
 * every vertex a bone moves (`skinnedBoneBoxes`, once per geometry), moved by that bone's skinning matrix and joined
 * over the bones (`posedBox`, once per pose), holds every posed vertex, whatever the pose: a few dozen operations a
 * bone in place of a matrix blend a vertex.
 */

/** Floats of a bone's box: its minimum corner, then its maximum. */
const BOX = 6;

/**
 * Per bone, the box of the vertices it moves, in the space the vertices are authored in: `bones` boxes of
 * (min x, y, z, max x, y, z). A bone that moves no vertex keeps an empty box (its minimum above its maximum).
 * `joints` and `weights` are the vertex buffers of each influence set (four influences a vertex), the extra set after
 * the first where the mesh has one. Null when an index names no bone of the skeleton.
 */
export function skinnedBoneBoxes(
  positions: ArrayLike<number>, joints: ReadonlyArray<ArrayLike<number>>, weights: ReadonlyArray<ArrayLike<number>>, bones: number,
): Float32Array | null {
  const boxes = new Float32Array(bones * BOX);
  for (let bone = 0; bone < bones; bone += 1) {
    boxes.fill(Number.POSITIVE_INFINITY, bone * BOX, bone * BOX + 3);
    boxes.fill(Number.NEGATIVE_INFINITY, bone * BOX + 3, bone * BOX + BOX);
  }
  const vertices = Math.floor(positions.length / 3);
  for (let set = 0; set < joints.length; set += 1) {
    const indices = joints[set]!, influence = weights[set]!;
    for (let vertex = 0; vertex < vertices; vertex += 1) {
      for (let slot = 0; slot < 4; slot += 1) {
        // A weight of zero moves nothing, whatever its index (exporters leave unused slots at bone 0).
        if (!(influence[vertex * 4 + slot]! > 0)) continue;
        const bone = indices[vertex * 4 + slot]!;
        if (!(bone >= 0 && bone < bones) || !Number.isInteger(bone)) return null;
        const at = bone * BOX;
        for (let axis = 0; axis < 3; axis += 1) {
          const value = positions[vertex * 3 + axis]!;
          // Rounded outwards: a box of 32-bit floats must still hold a 64-bit position.
          if (value < boxes[at + axis]!) boxes[at + axis] = below(value);
          if (value > boxes[at + 3 + axis]!) boxes[at + 3 + axis] = above(value);
        }
      }
    }
  }
  return boxes;
}

const rounded = new Float32Array(1), roundedBits = new Int32Array(rounded.buffer);
/** The smallest positive 32-bit float. */
const TINY = 2 ** -149;
/** The largest 32-bit float not above `value`. */
function below(value: number): number {
  rounded[0] = value;
  if (!(rounded[0] > value)) return rounded[0];
  if (rounded[0] === 0) return -TINY;
  // The next float towards minus infinity: one bit less of a positive float's magnitude, one more of a negative one's.
  roundedBits[0]! += rounded[0] > 0 ? -1 : 1;
  return rounded[0];
}
/** The smallest 32-bit float not below `value`. */
function above(value: number): number {
  rounded[0] = value;
  if (!(rounded[0] < value)) return rounded[0];
  if (rounded[0] === 0) return TINY;
  roundedBits[0]! += rounded[0] > 0 ? 1 : -1;
  return rounded[0];
}

/**
 * The box of a pose, into `min` and `max`: each bone's box (`skinnedBoneBoxes`) moved by its skinning matrix
 * (`matrices`: sixteen floats a bone, as Babylon stores a matrix, the matrix a vertex's position is multiplied by),
 * joined. A moved box is taken by its centre and half extents, which gives the box of its eight corners. Widened by
 * `margin` of its size on every side, for the 32-bit arithmetic the GPU poses with. False, and nothing written, when
 * no bone moves a vertex or a matrix is not finite.
 */
export function posedBox(
  boxes: Float32Array, matrices: ArrayLike<number>, min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }, margin = 1e-4,
): boolean {
  let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY, minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY, maxZ = Number.NEGATIVE_INFINITY;
  const bones = Math.min(boxes.length / BOX, Math.floor(matrices.length / 16));
  for (let bone = 0; bone < bones; bone += 1) {
    const at = bone * BOX;
    if (!(boxes[at]! <= boxes[at + 3]!)) continue;
    const cx = (boxes[at]! + boxes[at + 3]!) / 2, cy = (boxes[at + 1]! + boxes[at + 4]!) / 2, cz = (boxes[at + 2]! + boxes[at + 5]!) / 2;
    const ex = (boxes[at + 3]! - boxes[at]!) / 2, ey = (boxes[at + 4]! - boxes[at + 1]!) / 2, ez = (boxes[at + 5]! - boxes[at + 2]!) / 2;
    const m = bone * 16;
    const x = cx * matrices[m]! + cy * matrices[m + 4]! + cz * matrices[m + 8]! + matrices[m + 12]!;
    const y = cx * matrices[m + 1]! + cy * matrices[m + 5]! + cz * matrices[m + 9]! + matrices[m + 13]!;
    const z = cx * matrices[m + 2]! + cy * matrices[m + 6]! + cz * matrices[m + 10]! + matrices[m + 14]!;
    const hx = ex * Math.abs(matrices[m]!) + ey * Math.abs(matrices[m + 4]!) + ez * Math.abs(matrices[m + 8]!);
    const hy = ex * Math.abs(matrices[m + 1]!) + ey * Math.abs(matrices[m + 5]!) + ez * Math.abs(matrices[m + 9]!);
    const hz = ex * Math.abs(matrices[m + 2]!) + ey * Math.abs(matrices[m + 6]!) + ez * Math.abs(matrices[m + 10]!);
    if (!(Number.isFinite(x + y + z) && Number.isFinite(hx + hy + hz))) return false;
    if (x - hx < minX) minX = x - hx; if (x + hx > maxX) maxX = x + hx;
    if (y - hy < minY) minY = y - hy; if (y + hy > maxY) maxY = y + hy;
    if (z - hz < minZ) minZ = z - hz; if (z + hz > maxZ) maxZ = z + hz;
  }
  if (!(minX <= maxX)) return false;
  const padX = (maxX - minX) * margin, padY = (maxY - minY) * margin, padZ = (maxZ - minZ) * margin;
  min.x = minX - padX; min.y = minY - padY; min.z = minZ - padZ;
  max.x = maxX + padX; max.y = maxY + padY; max.z = maxZ + padZ;
  return true;
}
