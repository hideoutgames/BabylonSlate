import type { QuatTuple, SkeletonBone, SkeletonPayload, SkeletonRestChannel, Vec3Tuple } from "./skeleton-payload";

/** A 4×4 matrix in glTF's column-major order. */
export type Matrix4 = number[];

export function trsMatrix(position: Vec3Tuple, rotation: QuatTuple, scale: Vec3Tuple): Matrix4 {
  const [x, y, z, w] = rotation;
  const [sx, sy, sz] = scale;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    position[0], position[1], position[2], 1,
  ];
}

/** `a × b`: `b` applied first, as a parent's matrix times its child's. */
export function multiplyMatrices(a: Matrix4, b: Matrix4): Matrix4 {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!;
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** Translation, rotation and scale of an affine matrix; a mirrored one gets a negative X scale. */
export function decomposeMatrix(m: Matrix4): { position: Vec3Tuple; rotation: QuatTuple; scale: Vec3Tuple } {
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  const determinant =
    m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) -
    m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) +
    m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!);
  if (determinant < 0) sx = -sx;
  const ix = sx === 0 ? 0 : 1 / sx, iy = sy === 0 ? 0 : 1 / sy, iz = sz === 0 ? 0 : 1 / sz;
  const r00 = m[0]! * ix, r10 = m[1]! * ix, r20 = m[2]! * ix;
  const r01 = m[4]! * iy, r11 = m[5]! * iy, r21 = m[6]! * iy;
  const r02 = m[8]! * iz, r12 = m[9]! * iz, r22 = m[10]! * iz;
  const trace = r00 + r11 + r22;
  let rotation: QuatTuple;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    rotation = [(r21 - r12) * s, (r02 - r20) * s, (r10 - r01) * s, 0.25 / s];
  } else if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
    rotation = [0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  } else if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
    rotation = [(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
    rotation = [(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s];
  }
  const length = Math.hypot(...rotation) || 1;
  return {
    position: [m[12]!, m[13]!, m[14]!],
    rotation: rotation.map((value) => value / length) as QuatTuple,
    scale: [sx, sy, sz],
  };
}

/** How an imported rig relates to a Skeleton it matches. */
export type SkeletonRelation =
  /** The same bones. */
  | "same"
  /** Some of the Skeleton's bones: the rig joins it. */
  | "subset"
  /** All of the Skeleton's bones and more: the rig joins it and adds its extra bones. */
  | "superset";

export interface SkeletonMatch {
  relation: SkeletonRelation;
  /**
   * The Skeleton's bones once the rig joins: its own, with posed channels the rig knows the rest of filled in, then
   * the rig's extra bones.
   */
  bones: SkeletonBone[];
  /** Whether `bones` differs from the Skeleton's, so the Skeleton must be saved. */
  changed: boolean;
}

/** Rest translations agree within this fraction of the rigs' largest bone offset. */
const POSITION_TOLERANCE = 1e-3;
/** Rest rotations agree when 1 − |q₁·q₂| is at most this (about half a degree). */
const ROTATION_TOLERANCE = 1e-5;
const SCALE_TOLERANCE = 1e-3;

function isPosed(bone: SkeletonBone, channel: SkeletonRestChannel): boolean {
  return bone.posed?.includes(channel) ?? false;
}

function restAgrees(a: SkeletonBone, b: SkeletonBone, positionTolerance: number): boolean {
  const known = (channel: SkeletonRestChannel) => !isPosed(a, channel) && !isPosed(b, channel);
  const dot = a.rotation[0] * b.rotation[0] + a.rotation[1] * b.rotation[1] + a.rotation[2] * b.rotation[2] + a.rotation[3] * b.rotation[3];
  return (
    (!known("position") ||
      Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]) <= positionTolerance) &&
    (!known("rotation") || 1 - Math.abs(dot) <= ROTATION_TOLERANCE) &&
    (!known("scale") ||
      a.scale.every((value, axis) => Math.abs(value - b.scale[axis]!) <= SCALE_TOLERANCE * Math.max(1, Math.abs(value))))
  );
}

/** The Skeleton's bone with the channels it only has a pose for taken from the rig's rest, where the rig has one. */
function fillPosedRest(bone: SkeletonBone, rig: SkeletonBone): SkeletonBone {
  if (!bone.posed) return bone;
  const posed = bone.posed.filter((channel) => isPosed(rig, channel));
  const filled: SkeletonBone = { ...bone };
  for (const channel of bone.posed) {
    if (isPosed(rig, channel)) continue;
    if (channel === "rotation") filled.rotation = [...rig.rotation];
    else filled[channel] = [...rig[channel]];
  }
  if (posed.length > 0) filled.posed = posed;
  else delete filled.posed;
  return filled;
}

/** A rig without its only root bone: the armature node a converter turned into a joint. Its children become roots. */
function withoutArmature(bones: readonly SkeletonBone[]): SkeletonBone[] | null {
  const roots = bones.filter((bone) => bone.parent === null);
  if (roots.length !== 1) return null;
  const armature = roots[0]!;
  const children = bones.filter((bone) => bone.parent === armature.name);
  if (children.length === 0) return null;
  const above = trsMatrix(armature.position, armature.rotation, armature.scale);
  return bones.flatMap((bone) => {
    if (bone === armature) return [];
    if (bone.parent !== armature.name) return [bone];
    // A composed rest is only as known as both parts.
    const posed = [...new Set([...(armature.posed?.length ? ["position", "rotation", "scale"] as const : []), ...(bone.posed ?? [])])];
    const root: SkeletonBone = { ...bone, parent: null, ...decomposeMatrix(multiplyMatrices(above, trsMatrix(bone.position, bone.rotation, bone.scale))) };
    if (posed.length > 0) root.posed = posed;
    return [root];
  });
}

function compareRigs(skeleton: readonly SkeletonBone[], rig: readonly SkeletonBone[]): SkeletonRelation | null {
  const skeletonByName = new Map(skeleton.map((bone) => [bone.name, bone]));
  const rigNames = new Set(rig.map((bone) => bone.name));
  const shared = rig.filter((bone) => skeletonByName.has(bone.name));
  const relation: SkeletonRelation | null =
    shared.length === rig.length && shared.length === skeleton.length ? "same"
      : shared.length === rig.length ? "subset"
        : skeleton.every((bone) => rigNames.has(bone.name)) ? "superset"
          : null;
  // One shared bone says nothing about the rest of two rigs.
  if (!relation || (relation !== "same" && shared.length < 2)) return null;
  let reach = 0;
  for (const bone of [...skeleton, ...rig]) reach = Math.max(reach, Math.hypot(...bone.position));
  const positionTolerance = POSITION_TOLERANCE * Math.max(reach, 1e-3);
  for (const bone of shared) {
    const other = skeletonByName.get(bone.name)!;
    if (other.parent !== bone.parent || !restAgrees(other, bone, positionTolerance)) return null;
  }
  return relation;
}

/**
 * Whether an imported rig fits a Skeleton: the same bone names and parents in any order, the same rest pose within a
 * small tolerance, and one side may have an extra root (an armature node) the other lacks.
 */
export function matchSkeletonBones(skeleton: readonly SkeletonBone[], rig: readonly SkeletonBone[]): SkeletonMatch | null {
  if (skeleton.length === 0 || rig.length === 0) return null;
  const skeletonNames = new Set(skeleton.map((bone) => bone.name));
  const rigNames = new Set(rig.map((bone) => bone.name));
  const trials: Array<[readonly SkeletonBone[], readonly SkeletonBone[]]> = [[skeleton, rig]];
  const rigRoot = rig.filter((bone) => bone.parent === null);
  const skeletonRoot = skeleton.filter((bone) => bone.parent === null);
  const strippedRig = rigRoot.length === 1 && !skeletonNames.has(rigRoot[0]!.name) ? withoutArmature(rig) : null;
  if (strippedRig) trials.push([skeleton, strippedRig]);
  const strippedSkeleton = skeletonRoot.length === 1 && !rigNames.has(skeletonRoot[0]!.name) ? withoutArmature(skeleton) : null;
  if (strippedSkeleton) trials.push([strippedSkeleton, rig]);
  for (const [index, [skeletonBones, rigBones]] of trials.entries()) {
    const relation = compareRigs(skeletonBones, rigBones);
    if (!relation) continue;
    const rigByName = new Map(rigBones.map((bone) => [bone.name, bone]));
    // Roots are compared in the scene's space only when neither side dropped an armature, so only then fill them.
    const direct = index === 0;
    let changed = false;
    const bones = skeleton.map((bone) => {
      const rigBone = rigByName.get(bone.name);
      if (!rigBone || !bone.posed || (bone.parent === null && !direct)) return bone;
      const filled = fillPosedRest(bone, rigBone);
      if (filled !== bone && (filled.posed?.length ?? 0) !== bone.posed.length) changed = true;
      return filled;
    });
    if (relation !== "superset") return { relation, bones: changed ? bones : [...skeleton], changed };
    const extra = rigBones.filter((bone) => !skeletonNames.has(bone.name));
    return { relation, bones: [...bones, ...extra], changed: true };
  }
  return null;
}

const RELATION_ORDER: Record<SkeletonRelation, number> = { same: 0, subset: 1, superset: 2 };

/** The Skeleton an imported rig joins: the closest match, the earliest listed among equals. */
export function findMatchingSkeleton<T extends { guid: string; payload: SkeletonPayload }>(
  skeletons: readonly T[],
  rig: readonly SkeletonBone[],
): (SkeletonMatch & { skeleton: T }) | null {
  let best: (SkeletonMatch & { skeleton: T }) | null = null;
  for (const skeleton of skeletons) {
    const match = matchSkeletonBones(skeleton.payload.bones, rig);
    if (match && (!best || RELATION_ORDER[match.relation] < RELATION_ORDER[best.relation])) best = { ...match, skeleton };
  }
  return best;
}
