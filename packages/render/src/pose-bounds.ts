import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Geometry } from "@babylonjs/core/Meshes/geometry";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import type { Nullable } from "@babylonjs/core/types";
import { hasMeshLatticeDeformer } from "./lattice-deformer-binding";
import { clearDynamicMaterialBounds, updateDynamicMaterialBounds } from "./material-bounds";
import { posedBox, skinnedBoneBoxes } from "./skinned-bounds";

/**
 * Bounds that follow the pose of a Scene's skinned meshes, so a cull can trust them.
 *
 * A skinned mesh's vertices are posed on the GPU, and its bounds held them only as authored: a character's bounds
 * stood where its rest pose was, so no cull could use them and every pass drew every character, behind the camera
 * and outside every shadow cascade too. A followed mesh's bounds are taken from its skeleton instead
 * (`skinned-bounds.ts`): the box of the vertices each bone moves, moved by that bone's skinning matrix, joined. They
 * hold every posed vertex, whatever the pose, at a few dozen operations a bone.
 *
 * - `followPose` takes a mesh whose pose is its skeleton's alone and whose vertex data the CPU holds unchanged. A
 *   mesh with morph targets, a baked vertex animation or a lattice is not followed (those move vertices past any
 *   bone's box), nor one skinned on the CPU, whose vertex buffer changes.
 * - `updatePoseBounds` brings every followed mesh's bounds to its skeleton's pose, once an Engine frame, before the
 *   frame's first cull. Babylon computes a skeleton's matrices only for a mesh a cull kept, so they are computed here.
 *   A mesh's bounds are also taken as it is followed, for a cull of the same frame.
 * - The bounds go through `updateDynamicMaterialBounds`, which keeps a Material's padding on them and reapplies them
 *   when a Material is assigned. A mesh of several submeshes, which is culled by each one's bounds, gives every one
 *   the mesh's; LOD levels, which draw in their master's place, are held by their master's bounds.
 */

/** The boxes of one geometry posed by one skeleton: the mesh's own, or one of its LOD levels'. */
interface Part {
  mesh: Mesh;
  /** What the boxes were taken from: another geometry, or other vertices, takes them again. */
  geometry: Nullable<Geometry>;
  vertices: number;
  boxes: Float32Array;
}

interface Followed {
  mesh: Mesh;
  skeleton: Skeleton;
  parts: Part[];
  /** The skeleton's matrices were computed since the bounds were last taken. */
  dirty: boolean;
  computed: Nullable<Observer<Skeleton>>;
}

const followed = new WeakMap<AbstractMesh, Followed>();
/** Scenes whose meshes are not followed (`setScenePoseBounds`). */
const unfollowing = new WeakSet<Scene>();
const scenes = new WeakMap<Scene, { entries: Set<Followed>; frame: number }>();
/** Per geometry, the boxes taken for a skeleton of so many bones and a mesh of so many influences: actors share geometry. */
const geometryBoxes = new WeakMap<Geometry, { bones: number; influences: number; vertices: number; boxes: Float32Array | null }>();
const min = new Vector3(), max = new Vector3(), partMin = new Vector3(), partMax = new Vector3();

/** The vertex data of `kind` the CPU holds for `mesh`, or null. */
function held(mesh: Mesh, kind: string): ArrayLike<number> | null {
  return mesh.isVerticesDataPresent(kind) ? mesh.getVerticesData(kind) : null;
}

/** Per bone of `skeleton` (and its closing identity), the box of the vertices of `mesh` it moves; null when it cannot be known. */
function boxesOf(mesh: Mesh, skeleton: Skeleton): Float32Array | null {
  const geometry = mesh.geometry;
  if (!geometry) return null;
  // Babylon's matrices end with an identity, which an index one past the last bone reads.
  const bones = skeleton.bones.length + 1, influences = mesh.numBoneInfluencers, vertices = mesh.getTotalVertices();
  const known = geometryBoxes.get(geometry);
  if (known && known.bones === bones && known.influences === influences && known.vertices === vertices) return known.boxes;
  const boxes = take(mesh, bones, influences);
  geometryBoxes.set(geometry, { bones, influences, vertices, boxes });
  return boxes;
}

function take(mesh: Mesh, bones: number, influences: number): Float32Array | null {
  // A buffer its owner rewrites (CPU skinning, an edited mesh) holds other vertices tomorrow.
  if (mesh.getVertexBuffer(VertexBuffer.PositionKind)?.isUpdatable()) return null;
  const positions = held(mesh, VertexBuffer.PositionKind);
  const joints = held(mesh, VertexBuffer.MatricesIndicesKind), weights = held(mesh, VertexBuffer.MatricesWeightsKind);
  if (!positions || !joints || !weights) return null;
  const vertices = Math.floor(positions.length / 3);
  if (!vertices || joints.length < vertices * 4 || weights.length < vertices * 4) return null;
  const jointSets = [joints], weightSets = [weights];
  // More than four influences a vertex: the extra set must be there too, or some of the pose is unknown.
  if (influences > 4) {
    const extraJoints = held(mesh, VertexBuffer.MatricesIndicesExtraKind), extraWeights = held(mesh, VertexBuffer.MatricesWeightsExtraKind);
    if (!extraJoints || !extraWeights || extraJoints.length < vertices * 4 || extraWeights.length < vertices * 4) return null;
    jointSets.push(extraJoints);
    weightSets.push(extraWeights);
  }
  return skinnedBoneBoxes(positions, jointSets, weightSets, bones);
}

/** Whether something other than its skeleton moves `mesh`'s vertices, or its skeleton moves them on the CPU. */
function posedOtherwise(mesh: Mesh): boolean {
  return !!mesh.morphTargetManager || !!mesh.bakedVertexAnimationManager || !mesh.computeBonesUsingShaders || hasMeshLatticeDeformer(mesh);
}

/**
 * The parts `mesh`'s bounds must hold: itself and its LOD levels, each drawn in its place by the same skeleton. Null
 * when one cannot be boxed, or is posed otherwise.
 */
function partsOf(mesh: Mesh, skeleton: Skeleton): Part[] | null {
  const parts: Part[] = [];
  for (const part of [mesh, ...mesh.getLODLevels().map((level) => level.mesh)]) {
    // A null level hides the mesh at that distance: it draws nothing.
    if (!part) continue;
    if ((part !== mesh && part.skeleton !== skeleton) || posedOtherwise(part)) return null;
    const boxes = boxesOf(part, skeleton);
    if (!boxes) return null;
    parts.push({ mesh: part, geometry: part.geometry, vertices: part.getTotalVertices(), boxes });
  }
  return parts;
}

/** Whether `entry`'s parts are still what its mesh draws, each with the vertices its boxes were taken from. */
function partsHold(entry: Followed): boolean {
  const levels = entry.mesh.getLODLevels();
  let index = 1;
  for (const level of levels) {
    if (!level.mesh) continue;
    if (entry.parts[index]?.mesh !== level.mesh) return false;
    index += 1;
  }
  if (index !== entry.parts.length) return false;
  for (const part of entry.parts) if (part.mesh.geometry !== part.geometry || part.mesh.getTotalVertices() !== part.vertices) return false;
  return true;
}

function release(entry: Followed): void {
  entry.skeleton.onBeforeComputeObservable.remove(entry.computed);
  followed.delete(entry.mesh);
  scenes.get(entry.mesh.getScene())?.entries.delete(entry);
}

/**
 * Whether `scene`'s skinned meshes may be followed: they may unless turned off, as a proof's reference run does
 * before the Scene has any, so that every one stays drawn whatever the view.
 */
export function setScenePoseBounds(scene: Scene, enabled: boolean): void {
  if (enabled) unfollowing.delete(scene);
  else unfollowing.add(scene);
}

/**
 * Has `mesh`'s bounds follow its skeleton's pose from the next `updatePoseBounds` on, and returns whether they do.
 * An instance and a LOD level answer for their source and master, whose bounds are theirs. Asked again for a followed
 * mesh, it answers the same.
 */
export function followPose(mesh: AbstractMesh): boolean {
  if (mesh instanceof InstancedMesh) return followPose(mesh.sourceMesh);
  if (!(mesh instanceof Mesh)) return false;
  if (mesh._masterMesh) return followPose(mesh._masterMesh);
  if (followed.has(mesh)) return true;
  const skeleton = mesh.skeleton;
  if (!skeleton || mesh.isDisposed() || posedOtherwise(mesh) || unfollowing.has(mesh.getScene())) return false;
  const parts = partsOf(mesh, skeleton);
  if (!parts) return false;
  const entry: Followed = { mesh, skeleton, parts, dirty: true, computed: null };
  // Babylon notifies as it computes the matrices: the bounds are stale from then.
  entry.computed = skeleton.onBeforeComputeObservable.add(() => { entry.dirty = true; });
  followed.set(mesh, entry);
  const scene = mesh.getScene();
  let state = scenes.get(scene);
  if (!state) scenes.set(scene, (state = { entries: new Set(), frame: -1 }));
  state.entries.add(entry);
  mesh.onDisposeObservable.addOnce(() => release(entry));
  // At once: a cull may trust its bounds before the next frame's update.
  pose(entry);
  return true;
}

/** Whether `mesh`'s bounds follow its pose: a followed mesh, an instance of one or a LOD level of one. */
export function followsPose(mesh: AbstractMesh): boolean {
  const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
  return followed.has(source instanceof Mesh && source._masterMesh ? source._masterMesh : source);
}

/**
 * Brings the bounds of `scene`'s followed meshes, and of their instances, to their skeletons' poses. Call before a
 * cull: the first call of an Engine frame does the work, for every cull of the frame (animations pose once a frame,
 * before the Scene's before-render work). A mesh that is hidden is left for the frame that shows it, and one whose
 * skeleton did not move since is left as it is.
 *
 * A mesh that lost what it was followed for (its skeleton, its vertex data, or it gained another pose) is let go:
 * its bounds are as authored again and it is drawn whatever the view, as before it was followed.
 */
export function updatePoseBounds(scene: Scene): void {
  const state = scenes.get(scene);
  if (!state?.entries.size) return;
  const frame = scene.getEngine().frameId;
  if (state.frame === frame) return;
  state.frame = frame;
  for (const entry of state.entries) {
    const mesh = entry.mesh;
    if (mesh.skeleton !== entry.skeleton || posedOtherwise(mesh)) {
      unfollow(entry);
      continue;
    }
    if (!partsHold(entry)) {
      const parts = partsOf(mesh, entry.skeleton);
      if (!parts) {
        unfollow(entry);
        continue;
      }
      entry.parts = parts;
      entry.dirty = true;
    }
    // Nothing culls a hidden mesh; its instances draw on.
    if (!mesh.instances.length && (!mesh.isVisible || !mesh.isEnabled())) continue;
    pose(entry);
  }
}

/** Computes `entry`'s skeleton's matrices and, if they changed since its bounds were taken, takes them again. */
function pose(entry: Followed): void {
  // Whatever the render id: Babylon's own check would take last frame's matrices for this frame's, where no render
  // came between.
  entry.skeleton.prepare(true);
  if (!entry.dirty) return;
  const matrices = entry.skeleton.getTransformMatrices(entry.mesh);
  if (!matrices || !join(entry.parts, matrices)) return;
  entry.dirty = false;
  apply(entry.mesh);
}

/** The box of every part posed by `matrices`, into `min` and `max`; false when no part has one. */
function join(parts: readonly Part[], matrices: ArrayLike<number>): boolean {
  let any = false;
  for (const part of parts) {
    if (!posedBox(part.boxes, matrices, partMin, partMax)) continue;
    if (any) {
      min.minimizeInPlace(partMin);
      max.maximizeInPlace(partMax);
    } else {
      min.copyFrom(partMin);
      max.copyFrom(partMax);
      any = true;
    }
  }
  return any;
}

/** Gives `mesh`, each of its submeshes and each of its instances the box `min` to `max`, in the mesh's own space. */
function apply(mesh: Mesh): void {
  updateDynamicMaterialBounds(mesh, min, max);
  const bounds = mesh.getBoundingInfo();
  // A mesh of several submeshes is culled by each one's bounds: all get the mesh's, which hold every vertex.
  if (mesh.subMeshes.length > 1) for (const subMesh of mesh.subMeshes) if (subMesh.getBoundingInfo() !== bounds) subMesh.setBoundingInfo(bounds);
  for (const instance of mesh.instances)
    instance.getBoundingInfo().reConstruct(bounds.boundingBox.minimum, bounds.boundingBox.maximum, instance.getWorldMatrix());
}

/** Lets `entry`'s mesh go: its bounds as authored again, and drawn whatever the view. */
function unfollow(entry: Followed): void {
  release(entry);
  const mesh = entry.mesh;
  if (mesh.isDisposed()) return;
  mesh.alwaysSelectAsActiveMesh = true;
  if (!mesh.geometry) return;
  clearDynamicMaterialBounds(mesh);
  for (const subMesh of mesh.subMeshes) subMesh.refreshBoundingInfo();
  for (const instance of mesh.instances) {
    instance.alwaysSelectAsActiveMesh = true;
    instance.refreshBoundingInfo(false, false);
  }
}
