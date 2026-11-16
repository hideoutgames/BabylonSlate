import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { AnimFootPlacementChange, AnimTwoBoneIkChange } from "@haptic/core";
import {
  actorRootOf,
  composeTrs,
  ikChainOf,
  localMatrixOf,
  parentActorMatrix,
  readNodeTrs,
  storeRotation,
  turnAbout,
  twoBoneIkLocalTrs,
  TRANSLATION,
  TRS_LENGTH,
  WRITE_ROTATION,
  WRITE_TRANSLATION,
  type BoneNode,
} from "./anim-bone-modifiers";
import { isColliderVisualTree } from "./collider-visual";
import { isEditorHelperMesh } from "./helper-mesh";
import { intersectLandscapeChunk } from "./landscape-mesh";
import { isSkyboxMesh } from "./skybox";

/**
 * Foot Placement on posed nodes, after the clips blend. Cosmetic like the other skeletal controls: render traces each
 * foot down against the scene's drawn meshes (not the actor's own), drops the pelvis by the lowest foot's drop, puts
 * each foot at the height of its ground by Two Bone IK (keeping its rotation relative to the actor), and turns it to
 * the ground's slope. Heights are measured from the actor's own ground plane (its root's XZ plane), so a foot the
 * animation lifts stays lifted by as much above uneven ground.
 */

/** Writes a bone's solved local transform (blended with `base` by the change's alpha) on `channels`. */
export type BoneWrite = (node: BoneNode, base: Float64Array, solved: Float64Array, channels: number) => void;

const rootMatrix = new Matrix();
const worldToActor = new Matrix();
const parentMatrix = new Matrix();
const local = new Matrix();
const actorMatrix = new Matrix();
const inverse = new Matrix();
const base = new Float64Array(TRS_LENGTH);
const solved = new Float64Array(TRS_LENGTH);
const ikBases = [new Float64Array(TRS_LENGTH), new Float64Array(TRS_LENGTH), new Float64Array(TRS_LENGTH)] as const;
const ikSolved = [new Float64Array(TRS_LENGTH), new Float64Array(TRS_LENGTH), new Float64Array(TRS_LENGTH)] as const;
const turn = new Quaternion();

/**
 * Whether a mesh is ground a foot can stand on: drawn, solid, not a helper and not the actor's own. Skinned meshes are
 * not ground: a trace meets their triangles in the bind pose, not as drawn.
 */
function isGround(mesh: AbstractMesh, actorRoot: unknown): boolean {
  return mesh.isEnabled() &&
    mesh.isVisible &&
    mesh.visibility > 0 &&
    !(mesh instanceof LinesMesh) &&
    mesh.getTotalVertices() > 0 &&
    !mesh.skeleton &&
    !mesh.infiniteDistance &&
    !isSkyboxMesh(mesh) &&
    !isEditorHelperMesh(mesh) &&
    !isColliderVisualTree(mesh) &&
    !mesh.isDescendantOf(actorRoot as TransformNode) &&
    mesh !== actorRoot;
}

// One Foot Placement's traces: the ground meshes their box meets, and each one's inverse world matrix.
const candidates: AbstractMesh[] = [];
const inverses: Matrix[] = [];
const traceMin = new Vector3();
const traceMax = new Vector3();
const localRay = new Ray(Vector3.Zero(), Vector3.Down(), 1);

/** Whether a mesh's world bounds, brought up to date, miss the box from `min` to `max`. Unsynced bounds miss nothing. */
function boundsMiss(mesh: AbstractMesh, min: Vector3, max: Vector3): boolean {
  if (mesh.doNotSyncBoundingInfo) return false;
  const { minimumWorld: lo, maximumWorld: hi } = mesh.getBoundingInfo().boundingBox;
  return lo.x > max.x || hi.x < min.x || lo.y > max.y || hi.y < min.y || lo.z > max.z || hi.z < min.z;
}

/** Adds `mesh` to the candidates when it is ground; its world matrix is current. */
function addCandidate(mesh: AbstractMesh, actorRoot: unknown, count: number): number {
  if (!isGround(mesh, actorRoot)) return count;
  candidates[count] = mesh;
  while (inverses.length <= count) inverses.push(new Matrix());
  mesh.getWorldMatrix().invertToRef(inverses[count]!);
  return count + 1;
}

/**
 * One rendered frame's world bounds of a scene's meshes, packed (min xyz, max xyz per mesh; infinite where bounds are
 * not kept in sync or not finite), shared by the frame's Foot Placements. Dropped before each render and when a mesh
 * leaves the scene; retaken when the scene's mesh count changed (Babylon announces a new mesh only later).
 */
interface SharedBounds {
  meshes: AbstractMesh[];
  bounds: Float64Array;
  count: number;
  /** `scene.meshes.length` when taken. */
  sceneMeshes: number;
  valid: boolean;
}

const sharedBounds = new WeakMap<Scene, SharedBounds>();

/**
 * Lets the scene's Foot Placements share one snapshot of its meshes' world bounds per rendered frame, so each costs a
 * few comparisons per mesh rather than bringing every mesh's bounds up to date: for Play's scene, where many actors
 * place their feet each frame. A mesh that moves into a trace after the frame's snapshot is found the next frame. A
 * scene that never shares brings each mesh up to date for each Foot Placement. Returns the undo.
 */
export function shareFootPlacementBounds(scene: Scene): () => void {
  const shared: SharedBounds = { meshes: [], bounds: new Float64Array(0), count: 0, sceneMeshes: 0, valid: false };
  const drop = () => {
    shared.valid = false;
    shared.meshes.length = 0;
    shared.count = 0;
  };
  const observers = [scene.onBeforeRenderObservable.add(drop), scene.onMeshRemovedObservable.add(drop)] as const;
  sharedBounds.set(scene, shared);
  let undone = false;
  const undo = () => {
    if (undone) return;
    undone = true;
    scene.onBeforeRenderObservable.remove(observers[0]);
    scene.onMeshRemovedObservable.remove(observers[1]);
    if (sharedBounds.get(scene) === shared) sharedBounds.delete(scene);
    drop();
  };
  scene.onDisposeObservable.addOnce(undo);
  return undo;
}

function snapshotBounds(scene: Scene, shared: SharedBounds): void {
  const meshes = scene.meshes;
  if (shared.bounds.length < meshes.length * 6) shared.bounds = new Float64Array(meshes.length * 6);
  const { bounds } = shared;
  let count = 0;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i]!;
    if (!mesh.subMeshes?.length) continue;
    mesh.computeWorldMatrix();
    const at = count * 6;
    const { minimumWorld: lo, maximumWorld: hi } = mesh.getBoundingInfo().boundingBox;
    if (mesh.doNotSyncBoundingInfo || !Number.isFinite(lo.x + lo.y + lo.z + hi.x + hi.y + hi.z)) {
      bounds.fill(-Infinity, at, at + 3);
      bounds.fill(Infinity, at + 3, at + 6);
    } else {
      bounds[at] = lo.x; bounds[at + 1] = lo.y; bounds[at + 2] = lo.z;
      bounds[at + 3] = hi.x; bounds[at + 4] = hi.y; bounds[at + 5] = hi.z;
    }
    shared.meshes[count++] = mesh;
  }
  shared.meshes.length = count;
  shared.count = count;
  shared.sceneMeshes = meshes.length;
  shared.valid = true;
}

/**
 * The ground meshes whose world bounds meet the box from `min` to `max` (every trace's), into `candidates` with their
 * inverse world matrices; returns how many. The bounds test comes first, so the scene's other meshes cost one box test
 * each (against the frame's shared snapshot where the scene shares one). A mesh whose bounds are not kept in sync, or
 * are not finite, is not ruled out by them.
 */
function gatherGround(scene: Scene, actorRoot: unknown, min: Vector3, max: Vector3): number {
  let count = 0;
  const shared = sharedBounds.get(scene);
  if (shared) {
    if (!shared.valid || shared.sceneMeshes !== scene.meshes.length) snapshotBounds(scene, shared);
    const { bounds, meshes } = shared;
    for (let i = 0; i < shared.count; i++) {
      const at = i * 6;
      if (bounds[at]! > max.x || bounds[at + 3]! < min.x || bounds[at + 1]! > max.y || bounds[at + 4]! < min.y ||
        bounds[at + 2]! > max.z || bounds[at + 5]! < min.z) continue;
      const mesh = meshes[i]!;
      if (mesh.isDisposed()) continue;
      mesh.computeWorldMatrix();
      if (boundsMiss(mesh, min, max)) continue;
      count = addCandidate(mesh, actorRoot, count);
    }
    return count;
  }
  const meshes = scene.meshes;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i]!;
    if (!mesh.subMeshes?.length) continue;
    mesh.computeWorldMatrix();
    if (boundsMiss(mesh, min, max)) continue;
    count = addCandidate(mesh, actorRoot, count);
  }
  return count;
}

const instanceMatrix = new Matrix();
const instanceWorld = new Matrix();
const instanceInverse = new Matrix();
/** What a thin-instanced mesh's pick reads beyond its public API (Babylon 9.29 internals, as `Scene.pickWithRay` reads them). */
type ThinInstanceData = { _thinInstanceDataStorage: { matrixData: Float32Array | null } };

/**
 * The nearest hit of a world-space ray on a pickable thin-instanced mesh's instances, as `Scene.pickWithRay` tests
 * them: from the instances' current matrices, the hit naming its instance (its normal turns with it).
 */
function nearestInstanceHit(mesh: Mesh, ray: Ray, nearest: PickingInfo | null): PickingInfo | null {
  const matrices = (mesh as unknown as ThinInstanceData)._thinInstanceDataStorage.matrixData;
  if (!matrices) return nearest;
  const raw = mesh.rawBoundingInfo;
  const world = mesh.getWorldMatrix();
  const count = Math.min(mesh.thinInstanceCount, matrices.length >> 4);
  for (let index = 0; index < count; index++) {
    Matrix.FromArrayToRef(matrices, index << 4, instanceMatrix);
    instanceMatrix.multiplyToRef(world, instanceWorld);
    instanceWorld.invertToRef(instanceInverse);
    Ray.TransformToRef(ray, instanceInverse, localRay);
    if (raw && (!localRay.intersectsSphere(raw.boundingSphere, 0) || !localRay.intersectsBox(raw.boundingBox, 0))) continue;
    const info = mesh.intersects(localRay, false, undefined, false, instanceWorld, true);
    if (!info.hit || (nearest && !(info.distance < nearest.distance))) continue;
    info.thinInstanceIndex = index;
    nearest = info;
  }
  return nearest;
}

/** The nearest of the first `count` candidates a world-space ray meets within its length, or null. */
function nearestHit(ray: Ray, count: number): PickingInfo | null {
  let nearest: PickingInfo | null = null;
  for (let i = 0; i < count; i++) {
    const mesh = candidates[i]!;
    // As `Scene.pickWithRay` passes it: the ray in the mesh's own space; the hit answers in world units.
    Ray.TransformToRef(ray, inverses[i]!, localRay);
    const bounds = mesh.getBoundingInfo();
    if (!localRay.intersectsSphere(bounds.boundingSphere, 0) || !localRay.intersectsBox(bounds.boundingBox, 0)) continue;
    if ((mesh as Mesh).hasThinInstances && (mesh as Mesh).thinInstanceEnablePicking) {
      nearest = nearestInstanceHit(mesh as Mesh, ray, nearest);
      continue;
    }
    // A landscape chunk tests only the cells under the trace.
    const info = intersectLandscapeChunk(mesh as Mesh, localRay, mesh.getWorldMatrix()) ??
      mesh.intersects(localRay, false, undefined, false, mesh.getWorldMatrix());
    if (info.hit && (!nearest || info.distance < nearest.distance)) nearest = info;
  }
  return nearest;
}

/** A bone's place relative to the actor's root. */
function actorPosition(node: BoneNode, out: Vector3): Vector3 {
  parentActorMatrix(node, parentMatrix);
  readNodeTrs(node, base);
  composeTrs(base, local).multiplyToRef(parentMatrix, actorMatrix);
  return actorMatrix.getTranslationToRef(out);
}

interface FootTrace {
  /** The ground's height in the actor's axes, and its normal there; null where the trace hit nothing. */
  height: number | null;
  normal: Vector3;
  /** The foot's animated place, relative to the actor's root. */
  animated: Vector3;
}

/**
 * Traces below each foot: from Trace Up above it to Trace Down below, along the actor's down axis, against the ground
 * gathered once for all of them.
 */
function traceFeet(scene: Scene, feet: readonly BoneNode[], change: AnimFootPlacementChange): FootTrace[] {
  const root = actorRootOf(feet[0]!);
  localMatrixOf(root, rootMatrix);
  rootMatrix.invertToRef(worldToActor);
  const up = Vector3.TransformNormal(Vector3.UpReadOnly, rootMatrix);
  if (up.lengthSquared() < 1e-12) up.copyFrom(Vector3.UpReadOnly);
  up.normalize();
  const down = up.negate();
  const length = change.traceUp + change.traceDown;
  const rays = feet.map((foot) => {
    const animated = actorPosition(foot, new Vector3());
    const origin = Vector3.TransformCoordinates(animated, rootMatrix).addInPlace(up.scale(change.traceUp));
    return { animated, ray: new Ray(origin, down, length) };
  });
  let count = 0;
  if (length > 0) {
    traceMin.setAll(Infinity);
    traceMax.setAll(-Infinity);
    for (const { ray } of rays) {
      traceMin.minimizeInPlace(ray.origin);
      traceMax.maximizeInPlace(ray.origin);
      const end = ray.origin.add(down.scale(length));
      traceMin.minimizeInPlace(end);
      traceMax.maximizeInPlace(end);
    }
    count = gatherGround(scene, root, traceMin, traceMax);
  }
  const traces = rays.map(({ animated, ray }): FootTrace => {
    const hit = count > 0 ? nearestHit(ray, count) : null;
    if (!hit?.hit || !hit.pickedPoint) return { height: null, normal: Vector3.Up(), animated };
    const point = Vector3.TransformCoordinates(hit.pickedPoint, worldToActor);
    const normal = hit.getNormal(true, true) ?? up;
    const actorNormal = Vector3.TransformNormal(normal, worldToActor).normalize();
    // A surface facing away is the underside of something: stand on its plane all the same, upright.
    return { height: point.y, normal: actorNormal.y > 0.2 ? actorNormal : Vector3.Up(), animated };
  });
  // The candidates are this call's: hold no mesh past it.
  candidates.length = 0;
  return traces;
}

/** Lowers `pelvis` by `drop` along the actor's up axis, through its parent's axes. */
function dropPelvis(pelvis: BoneNode, drop: number, write: BoneWrite): void {
  parentActorMatrix(pelvis, parentMatrix);
  parentMatrix.invertToRef(inverse);
  const shift = Vector3.TransformNormal(new Vector3(0, drop, 0), inverse);
  readNodeTrs(pelvis, base);
  solved.set(base);
  solved[TRANSLATION] = base[TRANSLATION]! + shift.x;
  solved[TRANSLATION + 1] = base[TRANSLATION + 1]! + shift.y;
  solved[TRANSLATION + 2] = base[TRANSLATION + 2]! + shift.z;
  write(pelvis, base, solved, WRITE_TRANSLATION);
}

/** Turns a placed foot so its up axis (in the actor's axes) follows the ground's normal. */
function alignFoot(foot: BoneNode, normal: Vector3, write: BoneWrite): void {
  parentActorMatrix(foot, parentMatrix);
  readNodeTrs(foot, base);
  composeTrs(base, local).multiplyToRef(parentMatrix, actorMatrix);
  Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, normal, turn);
  turnAbout(actorMatrix, turn, actorMatrix.getTranslation(), actorMatrix);
  parentMatrix.invertToRef(inverse);
  actorMatrix.multiplyToRef(inverse, local);
  storeRotation(local, base, solved);
  write(foot, base, solved, WRITE_ROTATION);
}

/**
 * Places the feet of `change` on the ground of `scene`. `boneOf` finds a bone by name; `write` blends and writes each
 * bone's change. Feet whose leg is not two bones under a parent, or that the rig lacks, are left as posed.
 */
export function applyFootPlacement(scene: Scene, change: AnimFootPlacementChange, boneOf: (name: string) => BoneNode | null, write: BoneWrite): void {
  const feet = change.feet.map(boneOf).filter((foot): foot is BoneNode => foot !== null && ikChainOf(foot) !== null);
  if (feet.length === 0) return;
  const traces = traceFeet(scene, feet, change);
  const lowest = Math.min(0, ...traces.map((trace) => trace.height ?? 0));
  const pelvis = change.pelvisBone ? boneOf(change.pelvisBone) : null;
  if (pelvis && lowest < 0) dropPelvis(pelvis, lowest, write);
  feet.forEach((foot, index) => {
    const trace = traces[index]!;
    const height = trace.height ?? 0;
    const chain = ikChainOf(foot)!;
    const bones = [chain.root, chain.joint, chain.end] as const;
    bones.forEach((bone, i) => readNodeTrs(bone, ikBases[i]!));
    const effector = trace.animated.add(new Vector3(0, height, 0));
    const ik: AnimTwoBoneIkChange = {
      kind: "twoBoneIk", bone: foot.name, alpha: 1, effector: [effector.x, effector.y, effector.z], effectorSpace: "actor",
      jointTargetSpace: "actor", maxStretch: 1, keepEffectorRotation: true,
    };
    const writes = twoBoneIkLocalTrs(chain, ik, ikBases, ikSolved);
    if (writes) bones.forEach((bone, i) => write(bone, ikBases[i]!, ikSolved[i]!, writes[i]!));
    if (change.alignToGround && trace.height !== null && trace.normal.y < 0.9999) alignFoot(foot, trace.normal, write);
  });
}

/** The scene a posed node is in, for its traces. */
export function sceneOfNode(node: BoneNode): Scene | null {
  const scene = (node as unknown as { getScene?: () => Scene }).getScene?.();
  return scene ?? null;
}
