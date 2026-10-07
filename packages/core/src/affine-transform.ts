import type { Quat, Transform, Vec3 } from "./math-rng";
import type { SerializedActor } from "./scene";

/**
 * Affine transform in Babylon's row-vector layout (`Matrix.Compose`): entries
 * 0–8 are the rows of the linear part (the images of the local X, Y and Z
 * axes) and 9–11 the translation. A child's world matrix is
 * `local × parentWorld`, as Babylon parenting and the editor's authored
 * hierarchy compose it.
 */
export type AffineTransform = Float64Array;

/** Relative dot product above which two basis axes count as oblique (sheared). */
export const AFFINE_SHEAR_TOLERANCE = 1e-6;

/** Axis length below which a basis row counts as collapsed. */
const DEGENERATE_LENGTH = 1e-12;

export function createAffineTransform(): AffineTransform {
  return new Float64Array(12);
}

/** `Matrix.Compose(scale, rotation, position)`; the quaternion is used as given. */
export function composeAffineTransform(
  transform: Transform,
  out: AffineTransform = createAffineTransform(),
): AffineTransform {
  const { x, y, z, w } = transform.rotation;
  rotationBasis(x, y, z, w, out);
  const { x: sx, y: sy, z: sz } = transform.scale;
  out[0] = out[0]! * sx; out[1] = out[1]! * sx; out[2] = out[2]! * sx;
  out[3] = out[3]! * sy; out[4] = out[4]! * sy; out[5] = out[5]! * sy;
  out[6] = out[6]! * sz; out[7] = out[7]! * sz; out[8] = out[8]! * sz;
  out[9] = transform.position.x;
  out[10] = transform.position.y;
  out[11] = transform.position.z;
  return out;
}

/** `local × parent` (Babylon `local.multiply(parent)`); `out` may alias either input. */
export function multiplyAffineTransforms(
  local: AffineTransform,
  parent: AffineTransform,
  out: AffineTransform = createAffineTransform(),
): AffineTransform {
  const p0 = parent[0]!, p1 = parent[1]!, p2 = parent[2]!;
  const p3 = parent[3]!, p4 = parent[4]!, p5 = parent[5]!;
  const p6 = parent[6]!, p7 = parent[7]!, p8 = parent[8]!;
  const p9 = parent[9]!, p10 = parent[10]!, p11 = parent[11]!;
  for (let row = 0; row < 12; row += 3) {
    const a = local[row]!, b = local[row + 1]!, c = local[row + 2]!;
    const translation = row === 9;
    out[row] = a * p0 + b * p3 + c * p6 + (translation ? p9 : 0);
    out[row + 1] = a * p1 + b * p4 + c * p7 + (translation ? p10 : 0);
    out[row + 2] = a * p2 + b * p5 + c * p8 + (translation ? p11 : 0);
  }
  return out;
}

/** Inverse of `matrix` into `out` (may alias); false, leaving `out` unchanged, when singular. */
export function invertAffineTransform(
  matrix: AffineTransform,
  out: AffineTransform = createAffineTransform(),
): boolean {
  const a0 = matrix[0]!, a1 = matrix[1]!, a2 = matrix[2]!;
  const b0 = matrix[3]!, b1 = matrix[4]!, b2 = matrix[5]!;
  const c0 = matrix[6]!, c1 = matrix[7]!, c2 = matrix[8]!;
  // The inverse's columns are the cofactor rows b×c, c×a and a×b over det.
  const bc0 = b1 * c2 - b2 * c1, bc1 = b2 * c0 - b0 * c2, bc2 = b0 * c1 - b1 * c0;
  const ca0 = c1 * a2 - c2 * a1, ca1 = c2 * a0 - c0 * a2, ca2 = c0 * a1 - c1 * a0;
  const ab0 = a1 * b2 - a2 * b1, ab1 = a2 * b0 - a0 * b2, ab2 = a0 * b1 - a1 * b0;
  const det = a0 * bc0 + a1 * bc1 + a2 * bc2;
  if (!Number.isFinite(det) || det === 0) return false;
  const inv = 1 / det;
  const t0 = matrix[9]!, t1 = matrix[10]!, t2 = matrix[11]!;
  out[0] = bc0 * inv; out[1] = ca0 * inv; out[2] = ab0 * inv;
  out[3] = bc1 * inv; out[4] = ca1 * inv; out[5] = ab1 * inv;
  out[6] = bc2 * inv; out[7] = ca2 * inv; out[8] = ab2 * inv;
  out[9] = -(t0 * out[0]! + t1 * out[3]! + t2 * out[6]!);
  out[10] = -(t0 * out[1]! + t1 * out[4]! + t2 * out[7]!);
  out[11] = -(t0 * out[2]! + t1 * out[5]! + t2 * out[8]!);
  return true;
}

/**
 * Whether two non-collapsed axes of a row-major 3×3 basis (rows `stride`
 * apart, so a Babylon `Matrix.m` passes 4) are oblique: the shear that
 * nonuniform parent scale and an oblique child rotation produce, which no
 * translation-rotation-scale pose represents.
 */
export function affineBasisHasShear(values: ArrayLike<number>, stride = 3): boolean {
  for (let i = 0; i < 2; i++) {
    for (let j = i + 1; j < 3; j++) {
      const a = i * stride, b = j * stride;
      const ax = values[a]!, ay = values[a + 1]!, az = values[a + 2]!;
      const bx = values[b]!, by = values[b + 1]!, bz = values[b + 2]!;
      const lengths = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz);
      if (!(lengths > DEGENERATE_LENGTH * DEGENERATE_LENGTH)) continue;
      if (Math.abs(ax * bx + ay * by + az * bz) / lengths > AFFINE_SHEAR_TOLERANCE) return true;
    }
  }
  return false;
}

/**
 * Ids of attached actors whose authored world matrix (`local × parentWorld`,
 * as the editor viewport composes it) is sheared, which runtime world poses
 * can only approximate. Cyclic or dangling attachments are skipped.
 */
export function shearedActorIds(
  actors: readonly Pick<SerializedActor, "id" | "parentId" | "transform">[],
): string[] {
  const byId = new Map(actors.map((actor) => [actor.id, actor]));
  const worlds = new Map<string, AffineTransform | null>();
  const world = (actor: Pick<SerializedActor, "id" | "parentId" | "transform">): AffineTransform | null => {
    const cached = worlds.get(actor.id);
    if (cached !== undefined) return cached;
    // A cycle reached through this actor resolves to null.
    worlds.set(actor.id, null);
    const [px, py, pz] = actor.transform.position;
    const [rx, ry, rz, rw] = actor.transform.rotation;
    const [sx, sy, sz] = actor.transform.scale;
    let matrix: AffineTransform | null = composeAffineTransform({
      position: { x: px, y: py, z: pz },
      rotation: { x: rx, y: ry, z: rz, w: rw },
      scale: { x: sx, y: sy, z: sz },
    });
    if (actor.parentId) {
      const parent = byId.get(actor.parentId);
      const parentWorld = parent ? world(parent) : null;
      matrix = parentWorld ? multiplyAffineTransforms(matrix, parentWorld, matrix) : null;
    }
    worlds.set(actor.id, matrix);
    return matrix;
  };
  const sheared: string[] = [];
  for (const actor of actors) {
    if (!actor.parentId) continue;
    const matrix = world(actor);
    if (matrix && affineBasisHasShear(matrix)) sheared.push(actor.id);
  }
  return sheared;
}

const basisScratch = new Float64Array(9);
const referenceScratch = new Float64Array(9);
const lengths = new Float64Array(3);
const alignment = new Float64Array(3);
const signs = new Float64Array(3);

/**
 * Decompose `matrix` into `out`. Translation is always exact. A shear-free
 * basis decomposes exactly: each scale magnitude is its axis length, and the
 * signs follow `preferredSigns` when given, otherwise `reference` (the
 * rotation expected without reflection, such as parent rotation × local
 * rotation, returned unchanged when the axes match it), as long as their
 * product matches the basis orientation. Under shear the result is an
 * approximation: scale keeps each axis's world length and rotation is the
 * nearest proper rotation (polar decomposition) to the sign-corrected unit
 * axes. A collapsed axis takes its direction from the other two (or the
 * rotation from `reference`). Returns true when the basis is sheared.
 */
export function decomposeAffineTransform(
  matrix: AffineTransform,
  reference: Quat,
  out: Transform,
  preferredSigns?: Vec3,
): boolean {
  out.position.x = matrix[9]!;
  out.position.y = matrix[10]!;
  out.position.z = matrix[11]!;
  let qx = 0, qy = 0, qz = 0, qw = 1;
  const referenceLength = Math.hypot(reference.x, reference.y, reference.z, reference.w);
  if (Math.abs(referenceLength - 1) < 1e-12) {
    // Keep an already unit reference bit-for-bit.
    ({ x: qx, y: qy, z: qz, w: qw } = reference);
  } else if (referenceLength > 0) {
    qx = reference.x / referenceLength;
    qy = reference.y / referenceLength;
    qz = reference.z / referenceLength;
    qw = reference.w / referenceLength;
  }
  const referenceBasis = referenceScratch;
  rotationBasis(qx, qy, qz, qw, referenceBasis);
  let collapsed = 0;
  for (let axis = 0; axis < 3; axis++) {
    const row = axis * 3;
    const x = matrix[row]!, y = matrix[row + 1]!, z = matrix[row + 2]!;
    const length = Math.hypot(x, y, z);
    lengths[axis] = length;
    alignment[axis] = 1;
    if (!(length > DEGENERATE_LENGTH)) {
      collapsed += 1;
      continue;
    }
    alignment[axis] =
      (x * referenceBasis[row]! + y * referenceBasis[row + 1]! + z * referenceBasis[row + 2]!) / length;
  }
  const det =
    matrix[0]! * (matrix[4]! * matrix[8]! - matrix[5]! * matrix[7]!) +
    matrix[1]! * (matrix[5]! * matrix[6]! - matrix[3]! * matrix[8]!) +
    matrix[2]! * (matrix[3]! * matrix[7]! - matrix[4]! * matrix[6]!);
  const mismatched = () => det !== 0 && (det < 0) !== (signs[0]! * signs[1]! * signs[2]! < 0);
  for (let axis = 0; axis < 3; axis++) {
    const preferred = preferredSigns
      ? (axis === 0 ? preferredSigns.x : axis === 1 ? preferredSigns.y : preferredSigns.z)
      : alignment[axis]!;
    signs[axis] = preferred < 0 ? -1 : 1;
  }
  if (preferredSigns && mismatched()) {
    // Preferred signs that contradict the orientation fall back to the reference.
    for (let axis = 0; axis < 3; axis++) signs[axis] = alignment[axis]! < 0 ? -1 : 1;
  }
  if (mismatched()) {
    // Reflect the axis least aligned with the reference.
    let flip = 0;
    for (let axis = 1; axis < 3; axis++)
      if (Math.abs(alignment[axis]!) < Math.abs(alignment[flip]!)) flip = axis;
    signs[flip] = -signs[flip]!;
  }
  out.scale.x = signs[0]! * lengths[0]!;
  out.scale.y = signs[1]! * lengths[1]!;
  out.scale.z = signs[2]! * lengths[2]!;
  const sheared = affineBasisHasShear(matrix);
  if (collapsed > 1 || (collapsed === 0 && !sheared &&
    signs[0]! * alignment[0]! > 1 - 1e-12 &&
    signs[1]! * alignment[1]! > 1 - 1e-12 &&
    signs[2]! * alignment[2]! > 1 - 1e-12)) {
    out.rotation.x = qx;
    out.rotation.y = qy;
    out.rotation.z = qz;
    out.rotation.w = qw;
    return sheared;
  }
  const basis = basisScratch;
  let missing = -1;
  for (let axis = 0; axis < 3; axis++) {
    const row = axis * 3;
    if (!(lengths[axis]! > DEGENERATE_LENGTH)) {
      missing = axis;
      continue;
    }
    const inverse = 1 / (signs[axis]! * lengths[axis]!);
    basis[row] = matrix[row]! * inverse;
    basis[row + 1] = matrix[row + 1]! * inverse;
    basis[row + 2] = matrix[row + 2]! * inverse;
  }
  if (missing >= 0) {
    // A proper rotation's rows satisfy r[i] = r[i+1] × r[i+2] (cyclic).
    const a = ((missing + 1) % 3) * 3, b = ((missing + 2) % 3) * 3, row = missing * 3;
    basis[row] = basis[a + 1]! * basis[b + 2]! - basis[a + 2]! * basis[b + 1]!;
    basis[row + 1] = basis[a + 2]! * basis[b]! - basis[a]! * basis[b + 2]!;
    basis[row + 2] = basis[a]! * basis[b + 1]! - basis[a + 1]! * basis[b]!;
    const length = Math.hypot(basis[row]!, basis[row + 1]!, basis[row + 2]!);
    if (length > DEGENERATE_LENGTH) for (let i = row; i < row + 3; i++) basis[i] = basis[i]! / length;
  }
  if (sheared) nearestRotation(basis);
  quaternionFromBasis(basis, out.rotation);
  // Keep the reference's hemisphere so interpolation does not take the long way.
  if (out.rotation.x * qx + out.rotation.y * qy + out.rotation.z * qz + out.rotation.w * qw < 0) {
    out.rotation.x = -out.rotation.x;
    out.rotation.y = -out.rotation.y;
    out.rotation.z = -out.rotation.z;
    out.rotation.w = -out.rotation.w;
  }
  return sheared;
}

/** Row-major basis of a quaternion, as `Matrix.Compose` with unit scale. */
function rotationBasis(x: number, y: number, z: number, w: number, out: Float64Array): void {
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy;
  out[3] = xy - wz; out[4] = 1 - (xx + zz); out[5] = yz + wx;
  out[6] = xz + wy; out[7] = yz - wx; out[8] = 1 - (xx + yy);
}

/** Orthogonal polar factor of a positive-determinant 3×3 basis, in place (Newton iteration). */
function nearestRotation(basis: Float64Array): void {
  const next = referenceScratch;
  for (let iteration = 0; iteration < 32; iteration++) {
    const a0 = basis[0]!, a1 = basis[1]!, a2 = basis[2]!;
    const b0 = basis[3]!, b1 = basis[4]!, b2 = basis[5]!;
    const c0 = basis[6]!, c1 = basis[7]!, c2 = basis[8]!;
    // The inverse transpose's rows are b×c, c×a and a×b over the determinant.
    const bc0 = b1 * c2 - b2 * c1, bc1 = b2 * c0 - b0 * c2, bc2 = b0 * c1 - b1 * c0;
    const ca0 = c1 * a2 - c2 * a1, ca1 = c2 * a0 - c0 * a2, ca2 = c0 * a1 - c1 * a0;
    const ab0 = a1 * b2 - a2 * b1, ab1 = a2 * b0 - a0 * b2, ab2 = a0 * b1 - a1 * b0;
    const det = a0 * bc0 + a1 * bc1 + a2 * bc2;
    if (!(det > 0)) return;
    const half = 0.5 / det;
    next[0] = 0.5 * a0 + bc0 * half; next[1] = 0.5 * a1 + bc1 * half; next[2] = 0.5 * a2 + bc2 * half;
    next[3] = 0.5 * b0 + ca0 * half; next[4] = 0.5 * b1 + ca1 * half; next[5] = 0.5 * b2 + ca2 * half;
    next[6] = 0.5 * c0 + ab0 * half; next[7] = 0.5 * c1 + ab1 * half; next[8] = 0.5 * c2 + ab2 * half;
    let change = 0;
    for (let i = 0; i < 9; i++) {
      change = Math.max(change, Math.abs(next[i]! - basis[i]!));
      basis[i] = next[i]!;
    }
    if (change < 1e-14) return;
  }
}

/** `Quaternion.FromRotationMatrix` for a row-major rotation basis, normalized. */
function quaternionFromBasis(basis: Float64Array, out: Quat): void {
  // Babylon reads m_ij from the transposed row layout.
  const m11 = basis[0]!, m12 = basis[3]!, m13 = basis[6]!;
  const m21 = basis[1]!, m22 = basis[4]!, m23 = basis[7]!;
  const m31 = basis[2]!, m32 = basis[5]!, m33 = basis[8]!;
  const trace = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
  }
  const length = Math.hypot(x, y, z, w) || 1;
  out.x = x / length;
  out.y = y / length;
  out.z = z / length;
  out.w = w / length;
}
