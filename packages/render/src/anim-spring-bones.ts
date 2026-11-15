import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import {
  animBoneAxisVector,
  animChainCurveAt,
  animWindGust,
  type AnimSpringBoneSettings,
  type AnimSpringBonesChange,
} from "@haptic/core";
import {
  actorRootOf,
  composeTrs,
  localMatrixOf,
  parentActorMatrix,
  readNodeTrs,
  storeRotation,
  turnAbout,
  TRS_LENGTH,
  type BoneNode,
} from "./anim-bone-modifiers";
import { isRigJointNode } from "./skeleton-preview";

/**
 * Spring Bones, Kawaii-style, on posed nodes after the clips blend. Every bone below the Root Bone is a particle that
 * follows its animated position (relative to its parent's simulated one) through a damped spring: Verlet integration
 * at a fixed 1/120 s step, stepped by each pose's tick time, in actor space (relative to the actor's root node).
 * Each step adds gravity and wind, pulls toward the pose (Stiffness), pushes out of the colliders, holds a Planar
 * Constraint, keeps each bone's length and limits its angle from the pose. The particles then become rotations, root
 * first. The actor's own movement reaches the chain as inertia, less its World Damping; a teleport resets it.
 *
 * A chain's state belongs to the posed rig and its Root Bone, so it keeps simulating across the states that name it.
 */

/** The fixed simulation step. */
export const SPRING_STEP_SECONDS = 1 / 120;
/** Ticks longer than this simulate only this long, so a stall never runs away. */
const MAX_TICK_SECONDS = 0.25;
const EPSILON = 1e-6;

interface Particle {
  /** Null for the tip past a last bone (Tip Length). */
  node: BoneNode | null;
  parent: number;
  children: number[];
  /** 0 at the root to 1 at the furthest tip, by length along the chain: where the curves are read. */
  t: number;
  pos: Vector3;
  prev: Vector3;
  anim: Vector3;
  length: number;
  /** A tip's place in its bone's own axes, from the pose. */
  tipLocal: Vector3;
}

interface SpringChain {
  signature: string;
  particles: Particle[];
  accumulator: number;
  time: number;
  /** The actor root's matrix at the last pose, for its movement since. */
  actor: Matrix | null;
  generation: number;
}

const chainsByRig = new WeakMap<object, Map<string, SpringChain>>();

function jointChildren(node: BoneNode): BoneNode[] {
  const children = (node as unknown as { getChildren?: () => unknown[] }).getChildren?.() ?? [];
  return children.filter((child): child is BoneNode =>
    !!child && typeof child === "object" && "position" in child && isRigJointNode(child as TransformNode));
}

function buildChain(root: BoneNode, settings: AnimSpringBoneSettings, signature: string): SpringChain {
  const excluded = new Set(settings.excludeBones);
  const particles: Particle[] = [];
  const add = (node: BoneNode | null, parent: number): number => {
    const index = particles.length;
    particles.push({
      node, parent, children: [], t: 0,
      pos: new Vector3(), prev: new Vector3(), anim: new Vector3(), length: 0, tipLocal: new Vector3(),
    });
    if (parent >= 0) particles[parent]!.children.push(index);
    return index;
  };
  const visit = (node: BoneNode, parent: number) => {
    const index = add(node, parent);
    const children = jointChildren(node).filter((child) => !excluded.has(child.name));
    for (const child of children) visit(child, index);
    if (children.length === 0 && settings.tipLength > 0) add(null, index);
  };
  visit(root, -1);
  return { signature, particles, accumulator: 0, time: 0, actor: null, generation: 0 };
}

const animated: Matrix[] = [];
const current: Matrix[] = [];
const rootParent = new Matrix();
const inverse = new Matrix();
const local = new Matrix();
const actorNow = new Matrix();
const actorDelta = new Matrix();
const worldToActor = new Matrix();
const deltaScale = new Vector3();
const deltaRotation = new Quaternion();
const deltaTranslation = new Vector3();
const partial = new Quaternion();
const turn = new Quaternion();
const gravity = new Vector3();
const wind = new Vector3();
const scratch = new Vector3();
const scratch2 = new Vector3();
const trs = new Float64Array(TRS_LENGTH);
const solved = new Float64Array(TRS_LENGTH);
const IDENTITY = Quaternion.Identity();

function matrixAt(list: Matrix[], index: number): Matrix {
  while (list.length <= index) list.push(new Matrix());
  return list[index]!;
}

/** The animated actor-space matrices and positions of the chain's bones and tips, and each bone's length. */
function readPose(chain: SpringChain, root: BoneNode, tipLength: number): void {
  const { particles } = chain;
  parentActorMatrix(root, rootParent);
  let longest = 0;
  const reach: number[] = [];
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]!;
    const m = matrixAt(animated, i);
    if (p.node) {
      readNodeTrs(p.node, trs);
      composeTrs(trs, local).multiplyToRef(p.parent < 0 ? rootParent : animated[p.parent]!, m);
      m.getTranslationToRef(p.anim);
    } else {
      // A tip continues its bone's direction (from its parent), or its Y axis for a lone bone.
      const bone = particles[p.parent]!;
      const boneMatrix = animated[p.parent]!;
      const along = bone.parent >= 0 ? bone.anim.subtract(particles[bone.parent]!.anim) : Vector3.TransformNormal(Vector3.UpReadOnly, boneMatrix);
      if (along.lengthSquared() < EPSILON) along.copyFrom(Vector3.UpReadOnly);
      p.anim.copyFrom(bone.anim).addInPlace(along.normalize().scaleInPlace(tipLength));
      boneMatrix.invertToRef(inverse);
      Vector3.TransformCoordinatesToRef(p.anim, inverse, p.tipLocal);
    }
    p.length = p.parent < 0 ? 0 : Vector3.Distance(p.anim, particles[p.parent]!.anim);
    reach[i] = p.parent < 0 ? 0 : reach[p.parent]! + p.length;
    longest = Math.max(longest, reach[i]!);
  }
  for (let i = 0; i < particles.length; i++) particles[i]!.t = longest > EPSILON ? reach[i]! / longest : 0;
}

function resetToPose(chain: SpringChain): void {
  for (const p of chain.particles) {
    p.pos.copyFrom(p.anim);
    p.prev.copyFrom(p.anim);
  }
  chain.accumulator = 0;
}

/** A collider in actor space this pose. */
interface PlacedCollider {
  kind: "sphere" | "capsule" | "plane";
  center: Vector3;
  a: Vector3;
  b: Vector3;
  axis: Vector3;
  radius: number;
}

function placeColliders(settings: AnimSpringBoneSettings, boneOf: (name: string) => BoneNode | null): PlacedCollider[] {
  const placed: PlacedCollider[] = [];
  const parent = new Matrix();
  const matrix = new Matrix();
  for (const collider of settings.colliders) {
    const node = boneOf(collider.bone);
    if (!node) continue;
    parentActorMatrix(node, parent);
    localMatrixOf(node, matrix);
    matrix.multiplyToRef(parent, matrix);
    const center = Vector3.TransformCoordinates(Vector3.FromArray(collider.offset), matrix);
    const axis = Vector3.TransformNormal(Vector3.FromArray(animBoneAxisVector(collider.axis, "y")), matrix);
    if (axis.lengthSquared() < EPSILON) axis.copyFrom(Vector3.UpReadOnly);
    axis.normalize();
    const half = axis.scale(collider.kind === "capsule" ? collider.length / 2 : 0);
    placed.push({ kind: collider.kind, center, a: center.subtract(half), b: center.add(half), axis, radius: collider.radius });
  }
  return placed;
}

/** Moves `pos` out of a collider it is within `radius` of. */
function pushOut(pos: Vector3, collider: PlacedCollider, radius: number): void {
  if (collider.kind === "plane") {
    const depth = Vector3.Dot(pos.subtractToRef(collider.center, scratch), collider.axis);
    if (depth < radius) pos.addInPlace(collider.axis.scale(radius - depth));
    return;
  }
  let nearest = collider.center;
  if (collider.kind === "capsule") {
    const ab = collider.b.subtractToRef(collider.a, scratch2);
    const span = ab.lengthSquared();
    const at = span > EPSILON ? Math.min(1, Math.max(0, Vector3.Dot(pos.subtract(collider.a), ab) / span)) : 0;
    nearest = collider.a.add(ab.scale(at));
  }
  const away = pos.subtractToRef(nearest, scratch);
  const reach = collider.radius + radius;
  const distance = away.length();
  if (distance >= reach) return;
  if (distance < EPSILON) away.copyFrom(Vector3.UpReadOnly);
  else away.scaleInPlace(1 / distance);
  pos.copyFrom(nearest).addInPlace(away.scaleInPlace(reach));
}

const PLANAR_AXIS = { x: "x", y: "y", z: "z" } as const;

function stepChain(chain: SpringChain, settings: AnimSpringBoneSettings, colliders: readonly PlacedCollider[], h: number): void {
  const { particles } = chain;
  const { curves } = settings;
  const root = particles[0]!;
  root.prev.copyFrom(root.anim);
  root.pos.copyFrom(root.anim);
  const gust = settings.windStrength > 0 ? animWindGust(settings.windSeed, chain.time) : 0;
  const force = gravity.add(wind.scale(gust)).scaleInPlace(h * h);
  const limit = (settings.limitDegrees * Math.PI) / 180;
  const planar = settings.planarConstraint === "none" ? null : PLANAR_AXIS[settings.planarConstraint];
  for (let i = 1; i < particles.length; i++) {
    const p = particles[i]!;
    const parent = particles[p.parent]!;
    const stiffness = Math.min(1, Math.max(0, settings.stiffness * animChainCurveAt(curves.stiffness, p.t)));
    const damping = Math.min(1, Math.max(0, settings.damping * animChainCurveAt(curves.damping, p.t)));
    const radius = Math.max(0, settings.radius * animChainCurveAt(curves.radius, p.t));
    // The pose, hung from where the parent is now.
    const target = parent.pos.add(p.anim.subtract(parent.anim));
    const next = p.pos.subtract(p.prev).scaleInPlace(1 - damping).addInPlace(p.pos).addInPlace(force);
    next.addInPlace(target.subtract(next).scaleInPlace(stiffness));
    p.prev.copyFrom(p.pos);
    p.pos.copyFrom(next);
    for (const collider of colliders) pushOut(p.pos, collider, radius);
    if (planar) p.pos[planar] = target[planar];
    const offset = p.pos.subtract(parent.pos);
    const length = offset.length();
    if (length < EPSILON) {
      p.pos.copyFrom(target);
      continue;
    }
    offset.scaleInPlace(p.length / length);
    const maxAngle = limit * animChainCurveAt(curves.limitAngle, p.t);
    if (limit > 0 && p.length > EPSILON) {
      const posed = p.anim.subtract(parent.anim);
      const angle = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(offset, posed) / (p.length * posed.length() || 1))));
      if (angle > maxAngle && angle > EPSILON) {
        // Turned back toward the pose's direction until within the limit.
        Quaternion.FromUnitVectorsToRef(offset.normalizeToNew(), posed.normalizeToNew(), turn);
        Quaternion.SlerpToRef(IDENTITY, turn, 1 - Math.max(0, maxAngle) / angle, turn);
        offset.applyRotationQuaternionInPlace(turn);
      }
    }
    p.pos.copyFrom(parent.pos).addInPlace(offset);
  }
}

/**
 * Steps the chain under `root` by the change's tick time and writes each bone's new local rotation through `write`
 * (the bone, its pose's local transform and the solved one). Called once per pose; a chain the rig did not simulate
 * last pose starts from its pose.
 */
export function applySpringBones(
  rig: object,
  root: BoneNode,
  change: AnimSpringBonesChange,
  generation: number,
  boneOf: (name: string) => BoneNode | null,
  write: (node: BoneNode, base: Float64Array, solved: Float64Array) => void,
): void {
  const settings = change.settings;
  let chains = chainsByRig.get(rig);
  if (!chains) {
    chains = new Map();
    chainsByRig.set(rig, chains);
  }
  const signature = JSON.stringify([settings.excludeBones, settings.tipLength > 0]);
  let chain = chains.get(change.bone);
  if (!chain || chain.signature !== signature || chain.particles.some((p) => p.node?.isDisposed?.())) {
    chain = buildChain(root, settings, signature);
    chains.set(change.bone, chain);
  }
  readPose(chain, root, settings.tipLength);
  // The actor's movement since the last pose: what a world-fixed point does in actor space.
  localMatrixOf(actorRootOf(root), actorNow);
  const fresh = !chain.actor || (chain.generation !== generation && chain.generation !== generation - 1);
  if (chain.generation !== generation) {
    if (fresh) {
      resetToPose(chain);
    } else {
      actorNow.invertToRef(inverse);
      chain.actor!.multiplyToRef(inverse, actorDelta);
      actorDelta.decompose(deltaScale, deltaRotation, deltaTranslation);
      const moved = deltaTranslation.length();
      const turned = 2 * Math.acos(Math.min(1, Math.abs(deltaRotation.w)));
      const teleported = (settings.teleportDistance > 0 && moved > settings.teleportDistance) ||
        (settings.teleportDegrees > 0 && turned > (settings.teleportDegrees * Math.PI) / 180);
      if (teleported) {
        resetToPose(chain);
      } else {
        // Inertia: the chain keeps its place in the world, less its World Damping.
        Quaternion.SlerpToRef(IDENTITY, deltaRotation, 1 - settings.worldDampingRotation, partial);
        const shift = deltaTranslation.scale(1 - settings.worldDampingLocation);
        for (let i = 1; i < chain.particles.length; i++) {
          const p = chain.particles[i]!;
          p.pos.applyRotationQuaternionInPlace(partial).addInPlace(shift);
          p.prev.applyRotationQuaternionInPlace(partial).addInPlace(shift);
        }
      }
    }
    chain.actor = (chain.actor ?? new Matrix()).copyFrom(actorNow);
    actorNow.invertToRef(worldToActor);
    Vector3.TransformNormalToRef(Vector3.FromArrayToRef(settings.gravity, 0, scratch), worldToActor, gravity);
    const direction = Vector3.FromArray(settings.windDirection);
    if (direction.lengthSquared() > EPSILON) direction.normalize();
    Vector3.TransformNormalToRef(direction.scaleInPlace(settings.windStrength), worldToActor, wind);
    const colliders = placeColliders(settings, boneOf);
    chain.accumulator += Math.min(MAX_TICK_SECONDS, Math.max(0, Number.isFinite(change.dtSeconds) ? change.dtSeconds : 0));
    while (chain.accumulator >= SPRING_STEP_SECONDS) {
      chain.accumulator -= SPRING_STEP_SECONDS;
      chain.time += SPRING_STEP_SECONDS;
      stepChain(chain, settings, colliders, SPRING_STEP_SECONDS);
    }
    chain.generation = generation;
  }
  writeRotations(chain, write);
}

/** Turns each bone, root first, so its children sit where the simulation put them. */
function writeRotations(chain: SpringChain, write: (node: BoneNode, base: Float64Array, solved: Float64Array) => void): void {
  const { particles } = chain;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]!;
    if (!p.node) continue;
    readNodeTrs(p.node, trs);
    const parentMatrix = p.parent < 0 ? rootParent : current[p.parent]!;
    const m = matrixAt(current, i);
    composeTrs(trs, local).multiplyToRef(parentMatrix, m);
    if (p.children.length === 0) continue;
    const origin = m.getTranslation();
    const from = new Vector3();
    const to = new Vector3();
    for (const c of p.children) {
      const child = particles[c]!;
      const at = child.node
        ? (readNodeTrs(child.node, trs), composeTrs(trs, local).multiply(m).getTranslation())
        : Vector3.TransformCoordinates(child.tipLocal, m);
      const posed = at.subtractInPlace(origin);
      const wanted = child.pos.subtract(origin);
      if (posed.lengthSquared() < EPSILON || wanted.lengthSquared() < EPSILON) continue;
      from.addInPlace(posed.normalize());
      to.addInPlace(wanted.normalize());
    }
    if (from.lengthSquared() < EPSILON || to.lengthSquared() < EPSILON) continue;
    Quaternion.FromUnitVectorsToRef(from.normalize(), to.normalize(), turn);
    turnAbout(m, turn, origin, m);
    parentMatrix.invertToRef(inverse);
    m.multiplyToRef(inverse, local);
    readNodeTrs(p.node, trs);
    storeRotation(local, trs, solved);
    write(p.node, trs, solved);
  }
}

/** The simulated positions of a rig's chain under `rootBone`, in actor space; for tests and the Preview. */
export function springChainPositions(rig: object, rootBone: string): Vector3[] {
  return chainsByRig.get(rig)?.get(rootBone)?.particles.map((p) => p.pos.clone()) ?? [];
}
