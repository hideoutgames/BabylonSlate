import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Material } from "@babylonjs/core/Materials/material";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { SmartArray, type SmartArrayNoDuplicate } from "@babylonjs/core/Misc/smartArray";
import { Node } from "@babylonjs/core/node";
import type { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import type { RenderingGroup } from "@babylonjs/core/Rendering/renderingGroup";
import { RenderingManager } from "@babylonjs/core/Rendering/renderingManager";
import type { Scene } from "@babylonjs/core/scene";
import type { Nullable } from "@babylonjs/core/types";
import { isAutoLodSelector } from "./model-lod";
import { journalFollows, openRenderChangeReader, RenderChange, type RenderChangeReader } from "./render-change-journal";

/**
 * Lean preparation of a world object pass: Babylon 9.29's `ObjectRenderer._prepareRenderingManager` with the answers
 * that almost never change kept per mesh between frames, each with a complete invalidation, and everything with a
 * reader still done every frame as Babylon does it.
 *
 * Kept per (renderer, mesh), refreshed when the Scene's render change journal names the mesh (Visibility, Enabled,
 * Material, Dispatch or Other; the journal names descendants and instances itself), on a journal overflow, or when the
 * Scene's LOD selector is replaced:
 * - Its LOD, where it is fixed: no selector or automatic LOD's (`isAutoLodSelector`), Babylon's own `getLOD`, and no
 *   LOD levels on the mesh or an instance's source (`addLODLevel`, `removeLODLevel`: `RenderChange.Dispatch`). The
 *   answer is the mesh, or an instance's source, whose `_currentLOD` is written each frame as `getLOD` writes it. A
 *   mesh with levels selects through Babylon's per-frame memo and the selector, as Babylon does.
 * - `isEnabled() && isVisible` (`RenderChange.Enabled`, `RenderChange.Visibility`).
 * - For the mesh its sub-meshes draw through (its LOD, or an instance acting as a regular mesh): each sub-mesh's root
 *   Material (`RenderChange.Material`: `_setMaterial`, `setMaterialForRenderPass`), its rendering group id and
 *   whether it is below full visibility or has vertex alpha (`RenderChange.Visibility`, `RenderChange.Dispatch`).
 *
 * Read every frame: `isBlocked`; readiness, from the fields `Mesh.isReady(false)` reads (`delayLoadState`, the node's
 * ready flag); the layer mask against the camera's; the sub-mesh array, its length and each element (a different one
 * rebuilds the mesh's sub-mesh answers); a MultiMaterial root's sub-material and the default material
 * (`SubMesh.getMaterial`, with its side effect); each group's `disableDepthPrePass`. Polled once per distinct Material
 * per prepare: whether its `needAlphaBlendingForMesh` and `needAlphaTestingForMesh` are Material's own, their answers for
 * the four mesh variants they can read (visibility below 1, vertex alpha), and `needDepthPrePass`. A Material that
 * replaces either method is asked per sub-mesh, as Babylon does.
 *
 * Still run every frame, as Babylon does: the billboard LOD's world matrix, `_preActivateForIntermediateRendering`,
 * the active-mesh push, `_wasActiveLastFrame`, `_activate` (instance registration), the instance and intermediate
 * flags, `_prepareSkeleton`, `_wasDispatched`, the queue pushes, `_renderingGroup`, the edges check, `_empty`,
 * `_postActivate`, the bounding-box renderer's reset and particle dispatch.
 *
 * A mesh the journal cannot follow (`journalFollows` false for it, an ancestor or an instance's source), whose class
 * replaces `isEnabled`, or whose LOD is not fixed takes Babylon's path for that mesh. A pass Babylon would prepare
 * otherwise (a custom render list, `winterIsComing`, frozen meshes, bounding boxes, a readiness callback, several
 * render passes, `maintainStateBetweenFrames`, no LOD camera) runs Babylon's function.
 *
 * Each prepare recomputes one in `SELF_CHECK_STRIDE` of its kept entries and heals any that differ, counting the field
 * (`heals`, `healedFields`). While `verifyLeanPreparation` is on, every pass runs Babylon's own preparation, which
 * draws, and then the lean one into a scratch rendering manager, and compares their queues element by element.
 */

/** Each prepare recomputes the kept entries at one position in this many of its list (a rotating slice). */
export const SELF_CHECK_STRIDE = 32;
/** Mismatch and heal descriptions kept in the diagnostics. */
const MAX_EXAMPLES = 8;

const TRANSPARENT = 0;
const ALPHA_TEST = 1;
const OPAQUE = 2;

/** How the lean preparation of one Scene's passes went, counted since its first pass (`leanPreparationDiagnostics`). */
export interface LeanPreparationWork {
  /** Passes prepared the lean way, and passes handed to Babylon's function. */
  passes: number;
  fallbacks: number;
  /** Meshes those passes visited, those that took Babylon's path for the mesh, and entries made afresh. */
  meshes: number;
  liveMeshes: number;
  refreshes: number;
  /** Journal overflows, each a refresh of every entry. */
  overflows: number;
  /** Entries recomputed by the rotating self-check, those that differed (healed), and which fields differed. */
  selfChecks: number;
  heals: number;
  healedFields: string[];
  /** While verifying: passes compared with Babylon's, passes it could not compare (edges), and passes that differed. */
  verifiedPasses: number;
  unverifiedPasses: number;
  mismatches: number;
  /** The first differences, described. */
  mismatchExamples: string[];
  /** While verifying: sub-meshes Babylon's preparation and the lean one queued (draws, before instancing). */
  babylonQueued: number;
  leanQueued: number;
}

type DataInfo = {
  _currentLOD: Map<Camera, [Nullable<AbstractMesh>, number]>;
  _wasActiveLastFrame: boolean;
  _isActiveIntermediate: boolean;
  _onlyForInstancesIntermediate: boolean;
  _actAsRegularMesh: boolean;
};
type MeshInternals = AbstractMesh & {
  _internalAbstractMeshDataInfo: DataInfo;
  _internalMeshDataInfo?: { _LODLevels?: Array<{ mesh: Nullable<Mesh> }> };
  _nodeDataStorage: { _isReady: boolean };
  _preActivateForIntermediateRendering(renderId: number): void;
  _activate(renderId: number, intermediateRendering: boolean): boolean;
  _postActivate(): void;
  _renderingGroup: Nullable<RenderingGroup>;
  _renderId: number;
  _edgesRenderer: Nullable<{ isEnabled: boolean }>;
  _currentLOD?: Nullable<AbstractMesh>;
};
type SubMeshInternals = SubMesh & { _wasDispatched: boolean; _renderingMesh: AbstractMesh };
type GroupInternals = RenderingGroup & {
  _opaqueSubMeshes: SmartArray<SubMesh>;
  _alphaTestSubMeshes: SmartArray<SubMesh>;
  _transparentSubMeshes: SmartArray<SubMesh>;
  _depthOnlySubMeshes: SmartArray<SubMesh>;
  _edgesRenderers: SmartArrayNoDuplicate<unknown>;
  _empty: boolean;
};
type ManagerInternals = RenderingManager & {
  _renderingGroups: Array<GroupInternals | undefined>;
  _disableDepthPrePass: boolean;
};
type Prepare = (passIndex?: number, winterIsComing?: boolean) => Nullable<AbstractMesh[]>;
type RendererInternals = ObjectRenderer & {
  _prepareRenderingManager: Prepare;
  _renderingManager: ManagerInternals;
  _activeMeshes: SmartArray<AbstractMesh>;
  _activeBoundingBoxes: SmartArray<unknown>;
  _defaultRenderListPrepared: boolean;
  _isFrozen: boolean;
  _renderPassIds: number[];
  _scene: Scene;
};
type SceneInternals = Scene & {
  _activeMeshesFrozen: boolean;
  _prepareSkeleton(mesh: AbstractMesh): void;
  getBoundingBoxRenderer?: () => { reset(): void } | undefined;
};

const STOCK_BLEND = Material.prototype.needAlphaBlendingForMesh;
const STOCK_TEST = Material.prototype.needAlphaTestingForMesh;
const STOCK_IS_READY = Mesh.prototype.isReady;
const INSTANCE_IS_READY = InstancedMesh.prototype.isReady;
const STOCK_IS_ENABLED = Node.prototype.isEnabled;

/** What Material's own `needAlphaBlendingForMesh` and `needAlphaTestingForMesh` read of a mesh, per variant. */
const VARIANT_MESHES = [
  { visibility: 1, hasVertexAlpha: false }, { visibility: 0.5, hasVertexAlpha: false },
  { visibility: 1, hasVertexAlpha: true }, { visibility: 0.5, hasVertexAlpha: true },
] as unknown as readonly AbstractMesh[];

function variantOf(mesh: AbstractMesh): number {
  return (mesh.visibility < 1 ? 1 : 0) | (mesh.hasVertexAlpha ? 2 : 0);
}

/** A Material's queue answers, polled once per prepare (`serial`). */
class MaterialPoll {
  serial = -1;
  stock = false;
  depth = false;
  readonly queues = [-1, -1, -1, -1];
}
const polls = new WeakMap<Material, MaterialPoll>();
/** Counts lean prepares: a poll from another prepare is read again. */
let serial = 0;

function pollOf(material: Material): MaterialPoll {
  let poll = polls.get(material);
  if (!poll) polls.set(material, (poll = new MaterialPoll()));
  return poll;
}

/** `RenderingGroup.dispatch`'s queue for `material` drawing `mesh` (of `variant`), leaving `poll.depth` current. */
function queueOf(material: Material, poll: MaterialPoll, variant: number, mesh: AbstractMesh): number {
  if (poll.serial !== serial) {
    poll.serial = serial;
    poll.stock = material.needAlphaBlendingForMesh === STOCK_BLEND && material.needAlphaTestingForMesh === STOCK_TEST;
    poll.depth = material.needDepthPrePass;
    const queues = poll.queues;
    queues[0] = queues[1] = queues[2] = queues[3] = -1;
  }
  if (!poll.stock) return material.needAlphaBlendingForMesh(mesh) ? TRANSPARENT : material.needAlphaTestingForMesh(mesh) ? ALPHA_TEST : OPAQUE;
  let queue = poll.queues[variant]!;
  if (queue < 0) {
    const like = VARIANT_MESHES[variant]!;
    queue = poll.queues[variant] = material.needAlphaBlendingForMesh(like) ? TRANSPARENT
      : material.needAlphaTestingForMesh(like) ? ALPHA_TEST : OPAQUE;
  }
  return queue;
}

/** One sub-mesh's kept dispatch answer: its root Material, unless that is resolved each frame (`live`). */
interface Item {
  subMesh: SubMesh;
  material: Nullable<Material>;
  poll: Nullable<MaterialPoll>;
  /** No root Material (the default one) or a MultiMaterial root: `SubMesh.getMaterial()` each frame. */
  live: boolean;
}

/** The kept dispatch answers of the mesh a mesh's sub-meshes draw through (`owner`). */
interface Dispatch {
  owner: AbstractMesh;
  subMeshes: SubMesh[];
  groupId: number;
  variant: number;
  items: Item[];
}

function buildDispatch(owner: AbstractMesh, passId: number): Dispatch {
  const subMeshes = owner.subMeshes;
  const items: Item[] = [];
  for (const subMesh of subMeshes) {
    const rendering = (subMesh as SubMeshInternals)._renderingMesh;
    const root = rendering.getMaterialForRenderPass(passId) ?? rendering.material;
    const live = !root || (root as unknown as { getSubMaterial?: unknown }).getSubMaterial !== undefined;
    items.push({ subMesh, material: live ? null : root, poll: live ? null : pollOf(root!), live });
  }
  return { owner, subMeshes, groupId: owner.renderingGroupId || 0, variant: variantOf(owner), items };
}

/** What differs between two dispatch answers for the same sub-mesh array, as heal field names. */
function dispatchDifferences(kept: Dispatch, fresh: Dispatch): string[] {
  const fields: string[] = [];
  if (kept.groupId !== fresh.groupId) fields.push("renderingGroup");
  if (kept.variant !== fresh.variant) fields.push("visibilityOrVertexAlpha");
  for (let index = 0; index < kept.items.length; index++) {
    const a = kept.items[index]!, b = fresh.items[index]!;
    if (a.material !== b.material || a.live !== b.live) { fields.push("material"); break; }
  }
  return fields;
}

interface Entry {
  /** Cleared when the journal names the mesh. */
  valid: boolean;
  /** The Scene's `epoch` it was made in. */
  epoch: number;
  /** Takes Babylon's path for the mesh every frame. */
  live: boolean;
  /** The fixed LOD (the mesh, or an instance's source). */
  lod: Nullable<AbstractMesh>;
  /** `isEnabled() && isVisible`. */
  shows: boolean;
  dispatch: Nullable<Dispatch>;
}

/** Whether the journal hears every write that decides `mesh`'s kept answers: its own, its ancestors', its source's. */
function followed(mesh: AbstractMesh): boolean {
  if (!journalFollows(mesh)) return false;
  if (mesh instanceof InstancedMesh && !journalFollows(mesh.sourceMesh)) return false;
  for (let node = mesh.parent; node; node = node.parent) if (!journalFollows(node)) return false;
  return true;
}

function levelCount(mesh: AbstractMesh): number {
  return (mesh as MeshInternals)._internalMeshDataInfo?._LODLevels?.length ?? 0;
}

/** The LOD `mesh` draws from every camera, or null when it is selected per camera and frame. */
function fixedLod(mesh: AbstractMesh, scene: Scene): Nullable<AbstractMesh> {
  const selector = scene.customLODSelector;
  if (selector && !isAutoLodSelector(selector)) return null;
  if (mesh instanceof InstancedMesh) {
    if (mesh.getLOD !== InstancedMesh.prototype.getLOD) return null;
    const source = mesh.sourceMesh;
    return levelCount(source) > 0 ? null : source;
  }
  if (mesh instanceof Mesh) return mesh.getLOD !== Mesh.prototype.getLOD || levelCount(mesh) > 0 ? null : mesh;
  return mesh.getLOD === AbstractMesh.prototype.getLOD ? mesh : null;
}

function makeEntry(mesh: AbstractMesh, scene: Scene, epoch: number): Entry {
  const lod = fixedLod(mesh, scene);
  const live = lod === null || mesh.isEnabled !== STOCK_IS_ENABLED || !followed(mesh);
  return { valid: true, epoch, live, lod, shows: live ? false : mesh.isEnabled() && mesh.isVisible, dispatch: null };
}

/** `mesh.isReady(completeCheck)` without the call where it is Babylon's own and cheap (`Mesh.isReady(false)`). */
function readyNow(mesh: MeshInternals, completeCheck: boolean): boolean {
  if (!completeCheck) {
    if (mesh.isReady === STOCK_IS_READY) return mesh.delayLoadState !== 2 && mesh._nodeDataStorage._isReady;
    if (mesh.isReady === INSTANCE_IS_READY) {
      const source = (mesh as unknown as InstancedMesh).sourceMesh as unknown as MeshInternals;
      if (source.isReady === STOCK_IS_READY) return source.delayLoadState !== 2 && source._nodeDataStorage._isReady;
    }
  }
  return mesh.isReady(completeCheck);
}

let verifying = false;

/**
 * Debugging aid: every lean pass runs Babylon's own preparation, which draws, and then the lean one into a scratch
 * rendering manager, and compares the queues element by element and in order (`LeanPreparationWork.mismatches`).
 */
export function verifyLeanPreparation(enabled: boolean): void {
  verifying = enabled;
}

/** The lean renderers of one Scene, their journal reader, and their work. */
class SceneLean {
  readonly renderers = new Set<RendererLean>();
  readonly reader: RenderChangeReader;
  /** Moves on a journal overflow or a replaced LOD selector: every entry is made afresh. */
  epoch = 0;
  selector: unknown;
  readonly work: LeanPreparationWork = {
    passes: 0, fallbacks: 0, meshes: 0, liveMeshes: 0, refreshes: 0, overflows: 0, selfChecks: 0, heals: 0,
    healedFields: [], verifiedPasses: 0, unverifiedPasses: 0, mismatches: 0, mismatchExamples: [], babylonQueued: 0,
    leanQueued: 0,
  };

  constructor(scene: Scene) {
    this.reader = openRenderChangeReader(scene, RenderChange.Visibility | RenderChange.Enabled | RenderChange.Material |
      RenderChange.Other | RenderChange.Dispatch);
    this.selector = scene.customLODSelector;
  }

  private readonly visit = (node: Node): void => {
    for (const renderer of this.renderers) {
      const entry = renderer.cache.get(node as AbstractMesh);
      if (entry) entry.valid = false;
    }
  };

  /** Reads what changed since the last prepare of any of the Scene's lean passes. */
  drain(scene: Scene): void {
    if (!this.reader.drain(this.visit)) { this.epoch++; this.work.overflows++; }
    if (scene.customLODSelector !== this.selector) { this.selector = scene.customLODSelector; this.epoch++; }
  }

  heal(fields: readonly string[]): void {
    this.work.heals++;
    for (const field of fields) if (!this.work.healedFields.includes(field)) this.work.healedFields.push(field);
  }
}

const scenes = new WeakMap<Scene, SceneLean>();

/** One lean renderer: its entries and Babylon's own function. */
class RendererLean {
  readonly cache = new WeakMap<AbstractMesh, Entry>();
  readonly renderer: RendererInternals;
  readonly scene: SceneLean;
  readonly original: Prepare;
  readonly pass: string;
  /** The list position the self-check recomputes this prepare, modulo `SELF_CHECK_STRIDE`. */
  checkPhase = 0;
  scratch: { manager: ManagerInternals; active: SmartArray<AbstractMesh>; boxes: SmartArray<unknown> } | undefined;

  constructor(renderer: RendererInternals, scene: SceneLean, original: Prepare, pass: string) {
    this.renderer = renderer;
    this.scene = scene;
    this.original = original;
    this.pass = pass;
  }
}

/** Whether Babylon's function prepares this pass: what the lean one does not repeat. */
function babylonOnly(renderer: RendererInternals, winterIsComing: boolean): boolean {
  const scene = renderer._scene as SceneInternals;
  return winterIsComing || !renderer.renderList || !!renderer.customIsReadyFunction || renderer.enableBoundingBoxRendering ||
    !renderer.renderMeshes || scene.getEngine().isWebGPU || (scene._activeMeshesFrozen && renderer._isFrozen) ||
    renderer._renderPassIds.length !== 1 || renderer._renderingManager.maintainStateBetweenFrames;
}

/**
 * Prepares `renderer`'s passes the lean way (see the file comment) until it is disposed. For a world view's object
 * and geometry passes in Play (`ForwardSceneFrameGraphOptions.leanPreparation`).
 */
export function attachLeanPreparation(objectRenderer: ObjectRenderer, pass: string): void {
  const renderer = objectRenderer as RendererInternals;
  if (Object.prototype.hasOwnProperty.call(renderer, "_prepareRenderingManager")) return;
  const scene = renderer._scene;
  let sceneLean = scenes.get(scene);
  if (!sceneLean) scenes.set(scene, (sceneLean = new SceneLean(scene)));
  const lean = new RendererLean(renderer, sceneLean, renderer._prepareRenderingManager, pass);
  sceneLean.renderers.add(lean);
  renderer._prepareRenderingManager = function (this: RendererInternals, passIndex = 0, winterIsComing = false) {
    return prepare(lean, passIndex, winterIsComing);
  };
  const dispose = renderer.dispose;
  renderer.dispose = function (this: RendererInternals) {
    sceneLean!.renderers.delete(lean);
    if (sceneLean!.renderers.size === 0 && scenes.get(scene) === sceneLean) {
      sceneLean!.reader.dispose();
      scenes.delete(scene);
    }
    dispose.call(this);
  };
}

/** The lean preparation of `scene`'s passes, or undefined before its first. */
export function leanPreparationDiagnostics(scene: Scene): LeanPreparationWork | undefined {
  const work = scenes.get(scene)?.work;
  return work ? { ...work, healedFields: [...work.healedFields], mismatchExamples: [...work.mismatchExamples] } : undefined;
}

function prepare(lean: RendererLean, passIndex: number, winterIsComing: boolean): Nullable<AbstractMesh[]> {
  const renderer = lean.renderer;
  const work = lean.scene.work;
  if (renderer.getCustomRenderList || !renderer.renderList) { work.fallbacks++; return lean.original.call(renderer, passIndex, winterIsComing); }
  // Babylon's own short-cut: the default list was prepared for this render already.
  if (renderer._defaultRenderListPrepared && !winterIsComing && !renderer._scene.getEngine().isWebGPU) return renderer.renderList;
  const scene = renderer._scene as SceneInternals;
  const camera = scene.activeCamera;
  const cameraForLOD = renderer.cameraForLOD ?? camera;
  if (babylonOnly(renderer, winterIsComing) || !cameraForLOD) {
    work.fallbacks++;
    return lean.original.call(renderer, passIndex, winterIsComing);
  }
  lean.scene.drain(scene);
  serial++;
  work.passes++;
  const list = renderer.renderList!;
  const checkLayerMask = renderer.forceLayerMaskCheck;
  if (verifying) return verifyPass(lean, passIndex, list, checkLayerMask, camera, cameraForLOD);
  renderer._defaultRenderListPrepared = true;
  renderer._renderingManager.reset();
  renderer._activeMeshes.reset();
  renderer._activeBoundingBoxes.reset();
  scene.getBoundingBoxRenderer?.()?.reset();
  prepareMeshes(lean, list, checkLayerMask, camera, cameraForLOD);
  dispatchParticles(renderer, scene);
  return list;
}

/** Babylon's particle dispatch at the end of `_prepareRenderingManager`. */
function dispatchParticles(renderer: RendererInternals, scene: Scene): void {
  if (!scene.particlesEnabled || !renderer.renderParticles) return;
  scene.onBeforeParticlesRenderingObservable.notifyObservers(scene);
  const systems = renderer.particleSystemList || scene.particleSystems;
  for (let index = 0; index < systems.length; index++) {
    const system = systems[index]!;
    const emitter = system.emitter as { position?: unknown; isEnabled?: () => boolean } | null;
    if (!system.isStarted() || !emitter || (emitter.position && !emitter.isEnabled!())) continue;
    renderer._renderingManager.dispatchParticles(system);
  }
  scene.onAfterParticlesRenderingObservable.notifyObservers(scene);
}

/** The mesh loop of `_prepareRenderingManager`, with the kept answers. */
function prepareMeshes(lean: RendererLean, list: AbstractMesh[], checkLayerMask: boolean, camera: Nullable<Camera>,
  cameraForLOD: Camera): void {
  const renderer = lean.renderer;
  const scene = renderer._scene as SceneInternals;
  const sceneLean = lean.scene;
  const work = sceneLean.work;
  const cache = lean.cache;
  const active = renderer._activeMeshes;
  const renderId = scene.getRenderId();
  const completeCheck = renderer.refreshRate === 0;
  const epoch = sceneLean.epoch;
  const phase = lean.checkPhase;
  lean.checkPhase = (phase + 1) % SELF_CHECK_STRIDE;
  const length = list.length;
  for (let index = 0; index < length; index++) {
    const mesh = list[index] as MeshInternals;
    if (!mesh || mesh.isBlocked) continue;
    work.meshes++;
    if (!readyNow(mesh, completeCheck)) {
      renderer.resetRefreshCounter();
      continue;
    }
    let entry = cache.get(mesh);
    if (!entry || !entry.valid || entry.epoch !== epoch) {
      entry = makeEntry(mesh, scene, epoch);
      cache.set(mesh, entry);
      work.refreshes++;
    } else if (index % SELF_CHECK_STRIDE === phase) entry = selfCheck(lean, mesh, entry, scene, epoch);
    if (entry.live) {
      work.liveMeshes++;
      prepareMeshLive(renderer, mesh, renderId, camera, cameraForLOD, checkLayerMask);
      continue;
    }
    const lod = entry.lod as MeshInternals;
    if (lod !== mesh) {
      // InstancedMesh.getLOD's write, which `_activate` registers the instance through.
      mesh._currentLOD = lod;
      if (lod.billboardMode !== 0) lod.computeWorldMatrix();
    }
    lod._preActivateForIntermediateRendering(renderId);
    if (!entry.shows || !mesh.subMeshes || (checkLayerMask && camera && (mesh.layerMask & camera.layerMask) === 0)) continue;
    active.push(mesh);
    lod._internalAbstractMeshDataInfo._wasActiveLastFrame = true;
    if (lod !== mesh) lod._activate(renderId, true);
    if (mesh._activate(renderId, true) && mesh.subMeshes.length) {
      let owner = lod;
      if (!mesh.isAnInstance) owner._internalAbstractMeshDataInfo._onlyForInstancesIntermediate = false;
      else if (mesh._internalAbstractMeshDataInfo._actAsRegularMesh) owner = mesh;
      owner._internalAbstractMeshDataInfo._isActiveIntermediate = true;
      scene._prepareSkeleton(owner);
      dispatchKept(renderer, entry, owner);
    }
    mesh._postActivate();
  }
}

/** `RenderingManager.dispatch` and `RenderingGroup.dispatch` of `owner`'s sub-meshes, with the kept answers. */
function dispatchKept(renderer: RendererInternals, entry: Entry, owner: MeshInternals): void {
  const manager = renderer._renderingManager;
  const groups = manager._renderingGroups;
  const passId = renderer._renderPassIds[0]!;
  const subMeshes = owner.subMeshes;
  let dispatch = entry.dispatch;
  if (!dispatch || dispatch.owner !== owner || dispatch.subMeshes !== subMeshes || dispatch.items.length !== subMeshes.length)
    entry.dispatch = dispatch = buildDispatch(owner, passId);
  for (let index = 0; index < subMeshes.length; index++) {
    const subMesh = subMeshes[index] as SubMeshInternals;
    let item = dispatch.items[index]!;
    if (item.subMesh !== subMesh) {
      entry.dispatch = dispatch = buildDispatch(owner, passId);
      item = dispatch.items[index]!;
    }
    subMesh._wasDispatched = true;
    const group = (groups[dispatch.groupId] ?? manager.getRenderingGroup(dispatch.groupId)) as GroupInternals;
    const material = item.live ? subMesh.getMaterial() : item.material;
    if (!material) continue;
    const poll = item.poll ?? pollOf(material);
    const queue = queueOf(material, poll, dispatch.variant, owner);
    if (queue === TRANSPARENT) group._transparentSubMeshes.push(subMesh);
    else {
      if (poll.depth && !group.disableDepthPrePass) group._depthOnlySubMeshes.push(subMesh);
      (queue === ALPHA_TEST ? group._alphaTestSubMeshes : group._opaqueSubMeshes).push(subMesh);
    }
    owner._renderingGroup = group;
    const edges = owner._edgesRenderer;
    if (edges && owner.isEnabled() && owner.isVisible && edges.isEnabled) group._edgesRenderers.pushNoDuplicate(edges);
    group._empty = false;
  }
}

/** Babylon 9.29's loop body for one mesh (`_prepareRenderingManager`), after its readiness. */
function prepareMeshLive(renderer: RendererInternals, mesh: MeshInternals, renderId: number, camera: Nullable<Camera>,
  cameraForLOD: Camera, checkLayerMask: boolean): void {
  const scene = renderer._scene as SceneInternals;
  const frameId = scene.getFrameId();
  const memo = mesh._internalAbstractMeshDataInfo._currentLOD.get(cameraForLOD);
  let lod: Nullable<MeshInternals>;
  if (!memo || memo[1] !== frameId) {
    lod = (scene.customLODSelector ? scene.customLODSelector(mesh, cameraForLOD) : mesh.getLOD(cameraForLOD)) as Nullable<MeshInternals>;
    if (!memo) mesh._internalAbstractMeshDataInfo._currentLOD.set(cameraForLOD, [lod, frameId]);
    else { memo[0] = lod; memo[1] = frameId; }
  } else lod = memo[0] as Nullable<MeshInternals>;
  if (!lod) return;
  if (lod !== mesh && lod.billboardMode !== 0) lod.computeWorldMatrix();
  lod._preActivateForIntermediateRendering(renderId);
  const masked = checkLayerMask && camera ? (mesh.layerMask & camera.layerMask) === 0 : false;
  if (!(mesh.isEnabled() && mesh.isVisible && mesh.subMeshes && !masked)) return;
  renderer._activeMeshes.push(mesh);
  lod._internalAbstractMeshDataInfo._wasActiveLastFrame = true;
  if (lod !== mesh) lod._activate(renderId, true);
  if (mesh._activate(renderId, true) && mesh.subMeshes.length) {
    if (!mesh.isAnInstance) lod._internalAbstractMeshDataInfo._onlyForInstancesIntermediate = false;
    else if (mesh._internalAbstractMeshDataInfo._actAsRegularMesh) lod = mesh;
    lod._internalAbstractMeshDataInfo._isActiveIntermediate = true;
    scene._prepareSkeleton(lod);
    for (let index = 0; index < lod.subMeshes.length; index++) renderer._renderingManager.dispatch(lod.subMeshes[index]!, lod);
  }
  mesh._postActivate();
}

/** Recomputes a kept entry and its dispatch answers; a difference is healed and counted. */
function selfCheck(lean: RendererLean, mesh: AbstractMesh, entry: Entry, scene: Scene, epoch: number): Entry {
  const work = lean.scene.work;
  work.selfChecks++;
  const fresh = makeEntry(mesh, scene, epoch);
  const fields: string[] = [];
  if (fresh.live !== entry.live) fields.push("live");
  if (fresh.lod !== entry.lod) fields.push("lod");
  if (fresh.shows !== entry.shows) fields.push("enabledOrVisible");
  const kept = entry.dispatch;
  if (kept && kept.owner.subMeshes === kept.subMeshes && kept.subMeshes.length === kept.items.length) {
    const rebuilt = buildDispatch(kept.owner, lean.renderer._renderPassIds[0]!);
    fields.push(...dispatchDifferences(kept, rebuilt));
    fresh.dispatch = rebuilt;
  }
  if (fields.length === 0) return entry;
  lean.scene.heal(fields);
  lean.cache.set(mesh, fresh);
  return fresh;
}

// ---- Verifier ----

/** The per-mesh state a preparation writes, read back so a second preparation starts where the first did. */
type Saved = {
  mesh: MeshInternals;
  flags: [boolean, boolean, boolean, boolean];
  renderId: number;
  group: Nullable<RenderingGroup>;
  currentLod: Nullable<AbstractMesh> | undefined;
  memo: [Nullable<AbstractMesh>, number] | undefined;
  memoValue: [Nullable<AbstractMesh>, number] | undefined;
};

function touchedBy(list: AbstractMesh[]): MeshInternals[] {
  const touched: MeshInternals[] = [];
  const add = (mesh: AbstractMesh) => {
    touched.push(mesh as MeshInternals);
    for (const level of (mesh as MeshInternals)._internalMeshDataInfo?._LODLevels ?? []) if (level.mesh) touched.push(level.mesh as unknown as MeshInternals);
  };
  for (const mesh of list) {
    if (!mesh) continue;
    add(mesh);
    if (mesh instanceof InstancedMesh) add(mesh.sourceMesh);
  }
  return touched;
}

function save(touched: readonly MeshInternals[], camera: Camera): Saved[] {
  return touched.map((mesh) => {
    const info = mesh._internalAbstractMeshDataInfo;
    const memo = info._currentLOD.get(camera);
    return {
      mesh, flags: [info._wasActiveLastFrame, info._isActiveIntermediate, info._onlyForInstancesIntermediate, info._actAsRegularMesh],
      renderId: mesh._renderId, group: mesh._renderingGroup, currentLod: mesh._currentLOD, memo,
      memoValue: memo ? [memo[0], memo[1]] : undefined,
    };
  });
}

function restore(saved: readonly Saved[], camera: Camera): void {
  for (const state of saved) {
    const mesh = state.mesh;
    const info = mesh._internalAbstractMeshDataInfo;
    [info._wasActiveLastFrame, info._isActiveIntermediate, info._onlyForInstancesIntermediate, info._actAsRegularMesh] = state.flags;
    mesh._renderId = state.renderId;
    mesh._renderingGroup = state.group;
    if (mesh instanceof InstancedMesh) mesh._currentLOD = state.currentLod;
    if (!state.memo) info._currentLOD.delete(camera);
    else {
      state.memo[0] = state.memoValue![0];
      state.memo[1] = state.memoValue![1];
      info._currentLOD.set(camera, state.memo);
    }
  }
}

const QUEUES = ["_opaqueSubMeshes", "_alphaTestSubMeshes", "_transparentSubMeshes", "_depthOnlySubMeshes"] as const;

function describe(subMesh: SubMesh | AbstractMesh | undefined): string {
  if (!subMesh) return "none";
  if (subMesh instanceof AbstractMesh) return `"${subMesh.name}"`;
  return `"${subMesh.getMesh().name}" sub-mesh ${subMesh.getMesh().subMeshes.indexOf(subMesh)}`;
}

/** Babylon's preparation draws; the lean one runs into scratch and must queue the same, in order. */
function verifyPass(lean: RendererLean, passIndex: number, list: AbstractMesh[], checkLayerMask: boolean,
  camera: Nullable<Camera>, cameraForLOD: Camera): Nullable<AbstractMesh[]> {
  const renderer = lean.renderer;
  const work = lean.scene.work;
  const touched = touchedBy(list);
  const before = save(touched, cameraForLOD);
  const result = lean.original.call(renderer, passIndex, false);
  if (touched.some((mesh) => mesh._edgesRenderer)) { work.unverifiedPasses++; return result; }
  const after = save(touched, cameraForLOD);
  restore(before, cameraForLOD);
  const manager = renderer._renderingManager;
  const scratch = lean.scratch ??= {
    manager: new RenderingManager(renderer._scene) as ManagerInternals, active: new SmartArray<AbstractMesh>(256),
    boxes: new SmartArray<unknown>(32),
  };
  scratch.manager._disableDepthPrePass = manager._disableDepthPrePass;
  manager._renderingGroups.forEach((group, id) => {
    if (group) scratch.manager.getRenderingGroup(id).disableDepthPrePass = group.disableDepthPrePass;
  });
  const active = renderer._activeMeshes;
  const boxes = renderer._activeBoundingBoxes;
  const meshPrototype = Mesh.prototype as unknown as { _registerInstanceForRenderId: (...args: unknown[]) => unknown };
  const register = meshPrototype._registerInstanceForRenderId;
  renderer._renderingManager = scratch.manager;
  renderer._activeMeshes = scratch.active;
  renderer._activeBoundingBoxes = scratch.boxes;
  // Babylon's preparation registered this pass's instances; the lean one must not register them twice.
  meshPrototype._registerInstanceForRenderId = function (this: unknown) { return this; };
  try {
    scratch.manager.reset();
    scratch.active.reset();
    prepareMeshes(lean, list, checkLayerMask, camera, cameraForLOD);
  } finally {
    meshPrototype._registerInstanceForRenderId = register;
    renderer._renderingManager = manager;
    renderer._activeMeshes = active;
    renderer._activeBoundingBoxes = boxes;
    restore(after, cameraForLOD);
  }
  work.verifiedPasses++;
  const differences: string[] = [];
  const count = Math.max(manager._renderingGroups.length, scratch.manager._renderingGroups.length);
  for (let id = 0; id < count; id++) {
    const expected = manager._renderingGroups[id];
    const actual = scratch.manager._renderingGroups[id];
    for (const queue of QUEUES) {
      const a = expected?.[queue], b = actual?.[queue];
      const length = Math.max(a?.length ?? 0, b?.length ?? 0);
      if (queue !== "_depthOnlySubMeshes") { work.babylonQueued += a?.length ?? 0; work.leanQueued += b?.length ?? 0; }
      for (let index = 0; index < length; index++) {
        const x = index < (a?.length ?? 0) ? a!.data[index] : undefined;
        const y = index < (b?.length ?? 0) ? b!.data[index] : undefined;
        if (x !== y) {
          differences.push(`${lean.pass} group ${id} ${queue.slice(1)}[${index}] of ${a?.length ?? 0}/${b?.length ?? 0}: Babylon ${describe(x)}, lean ${describe(y)}`);
          break;
        }
      }
    }
  }
  const activeLength = Math.max(active.length, scratch.active.length);
  for (let index = 0; index < activeLength; index++) {
    const x = index < active.length ? active.data[index] : undefined;
    const y = index < scratch.active.length ? scratch.active.data[index] : undefined;
    if (x !== y) { differences.push(`${lean.pass} active meshes[${index}] of ${active.length}/${scratch.active.length}: Babylon ${describe(x)}, lean ${describe(y)}`); break; }
  }
  if (differences.length) {
    work.mismatches++;
    for (const difference of differences) if (work.mismatchExamples.length < MAX_EXAMPLES) work.mismatchExamples.push(difference);
    // Make every entry afresh: Babylon's preparation drew this pass.
    lean.scene.epoch++;
  }
  return result;
}
