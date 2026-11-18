import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { Material } from "@babylonjs/core/Materials/material";
import type { Plane } from "@babylonjs/core/Maths/math.plane";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { ISmartArrayLike, SmartArray } from "@babylonjs/core/Misc/smartArray";
import type { Node } from "@babylonjs/core/node";
import type { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { RenderingGroup } from "@babylonjs/core/Rendering/renderingGroup";
import type { RenderingManager } from "@babylonjs/core/Rendering/renderingManager";
import type { Scene } from "@babylonjs/core/scene";
import { observeSortedPasses, sceneDrawBatcher, setPresortedPass } from "./draw-batching";
import { layerDrawableMeshes, layerDrawableMeshRevision } from "./layer-drawable-meshes";
import { journalFollows, openRenderChangeReader, RenderChange, type RenderChangeReader } from "./render-change-journal";
import { isRevealPending, revealPendingRevision } from "./reveal-pending";
import { sceneReadinessRevision } from "./scene-readiness-signal";

/**
 * A Scene Layer's retained draw list: what its objects pass draws, kept between frames, so that Babylon's per-frame
 * work for the layer (the mesh loop, the camera's cull, the objects pass's list preparation, dispatch and sorts) sees
 * only the meshes the layer's draw batcher actually draws (each batch's mesh and each draw made on its own), not every
 * visual. The visuals stay real meshes in `scene.meshes` for everything else (picking, bounds, parenting, probes).
 *
 * The list holds, for each rendering group, the opaque, alpha-tested and blended submeshes exactly as Babylon would hand
 * them to the batcher: its dispatch order (the drawable list's order, `layer-drawable-meshes.ts`, each mesh's submeshes
 * in order) sorted by the group's compare functions with Babylon's stable sort (the blended ones by `alphaIndex`, then
 * back to front as `TransparentDepthPrePass` sorts them). Each drawable mesh keeps what the cull and the objects pass
 * would answer for it: whether it draws (ready, enabled, visible, `visibility`, layer mask, frustum, not hidden until
 * ready, with submeshes) and in which list each of its submeshes goes.
 *
 * What changes is heard, not compared, except where nothing can hear it:
 * - World matrices: before the list is read, each drawable mesh's `computeWorldMatrix()` is called, as Babylon's mesh
 *   loop calls it. It is Babylon's own test (the mesh's and its ancestors' dirty flags and parent links), so a write of
 *   any kind, by any writer, is caught, and exactly the moved meshes (and the descendants they move) are recomputed.
 *   Each recompute notes `Transform` in the render change journal.
 * - The render change journal (all kinds): a mesh it names is read again. `Transform` moves its frustum answer and its
 *   distance to the camera; `Style` alone changes nothing here (a style that crosses full opacity marks the readiness
 *   revision); any other kind asks its readiness again too.
 * - The drawable list's rebuilds (members added, removed or reordered), the readiness revision, the reveal revision,
 *   the camera (view, projection, eye, layer mask) and the renderer's and groups' settings: each reads what it moves.
 * - Polled every frame, as no write point reaches them: each drawable mesh's `alphaIndex`, rendering group, layer mask,
 *   `alwaysSelectAsActiveMesh` and alpha-test sort keys (`compareAlphaTestDraws`: sorting metadata and name), and each
 *   drawing mesh's submeshes, their Materials and which list each Material puts them in (blending, alpha testing, depth
 *   pre-pass). A mesh the journal cannot hear (`journalFollows` false) and one that was not ready are read again every
 *   frame, as Babylon asks them every frame.
 *
 * A blended list whose members only moved keeps its order when each moved member still sits between its neighbours
 * (Babylon's compare, ties by dispatch order, which is what its stable sort keeps); any other change rebuilds the list
 * from dispatch order and sorts it with the group's compare, as Babylon does.
 *
 * Anything the list cannot represent exactly takes Babylon's full path for that frame, counted by reason
 * (`LayerDrawListWork.fallbacks`): the frame graph draws more than the objects pass from the cull (post-process
 * geometry, outlines, water, spatial effects, occlusion), no batcher, frozen active meshes, particle systems,
 * instances, LOD, skeletons, edges, depth pre-passes of opaque or alpha-tested draws, and renderer settings Babylon's
 * preparation reads otherwise (custom render functions or lists, bounding boxes, order-independent transparency).
 *
 * Every `CHECK_INTERVAL`th frame, and every `VERIFY_INTERVAL`th while `verifyLayerDrawLists` is on, the frame takes
 * Babylon's full path and the sorted lists it hands the batcher are compared with the retained ones, list by list in
 * order: a difference is healed (the next frame reads everything anew) and counted in `heals`, or while verifying in
 * `mismatches`.
 */

/** Every this many layer frames, Babylon's full path draws and its lists are compared with the retained ones. */
const CHECK_INTERVAL = 32;
/** While verifying, every this many layer frames (the others draw from the retained lists). */
const VERIFY_INTERVAL = 4;
const MAX_MISMATCH_DETAILS = 4;

/** Why a frame took Babylon's full path. */
export type LayerDrawListFallback =
  | "graph" | "batcher" | "frozen" | "particles" | "renderer" | "camera"
  | "instances" | "lod" | "skeleton" | "edges" | "depthPrePass";

/**
 * How a layer's draw list was kept: frames drawn from it, frames on Babylon's full path (by reason) and checked frames;
 * full reads, meshes read again and lists rebuilt; and what the checks found (`heals`, `mismatches` while verifying,
 * with the first differences described).
 */
export interface LayerDrawListWork {
  retainedFrames: number;
  fallbackFrames: number;
  fallbacks: Partial<Record<LayerDrawListFallback, number>>;
  checkedFrames: number;
  fullReads: number;
  rereads: number;
  relists: number;
  /** Blended lists whose moved members all kept their places, so they were not sorted again. */
  keptOrders: number;
  heals: number;
  mismatches: number;
  mismatchDetails: string[];
}

let verifies = false;

/**
 * Debugging aid: every `VERIFY_INTERVAL`th frame of each Scene Layer takes Babylon's full path, and the lists it sorts
 * must equal the retained ones (`LayerDrawListWork.mismatches`).
 */
export function verifyLayerDrawLists(enabled: boolean): void {
  verifies = enabled;
}

type SortCompare = (a: SubMesh, b: SubMesh) => number;
/** Babylon 9.29 internals the list reads and writes. */
type GroupInternals = {
  _opaqueSubMeshes: SmartArray<SubMesh>;
  _alphaTestSubMeshes: SmartArray<SubMesh>;
  _transparentSubMeshes: SmartArray<SubMesh>;
  _depthOnlySubMeshes: SmartArray<SubMesh>;
  _opaqueSortCompareFn: SortCompare | null;
  _alphaTestSortCompareFn: SortCompare | null;
  _transparentSortCompareFn: SortCompare | null;
  _empty: boolean;
  disableDepthPrePass: boolean;
};
type ManagerInternals = RenderingManager & { _renderingGroups: Array<RenderingGroup | undefined>; maintainStateBetweenFrames: boolean };
type RendererInternals = {
  _renderingManager: ManagerInternals;
  _activeMeshes: SmartArray<AbstractMesh>;
  _activeBoundingBoxes: SmartArray<unknown>;
  _prepareRenderingManager: (passIndex?: number, winterIsComing?: boolean) => unknown;
};
type CameraInternals = Camera & { _updateFrustumPlanes(): void; _frustumPlanes: Plane[] };
type SortMetadata = { sortingGroupId?: unknown; sortingLayerKey?: unknown; tilemapLayer?: { ordinal?: unknown } } | null | undefined;

const OPAQUE = 0, ALPHA_TEST = 1, BLENDED = 2;
const KIND_NAMES = ["opaque", "alpha-tested", "blended"] as const;

/** A drawing mesh's submesh, in the list its Material puts it. */
interface Part {
  subMesh: SubMesh;
  material: Material;
  /** Its list: rendering group × 4 + kind. */
  key: number;
  /** What its Material answered: blends, alpha-tests, draws a depth pre-pass. */
  blends: boolean;
  tests: boolean;
  depth: boolean;
  /** Its place in its list's dispatch order and in its sorted list, as last listed. */
  seq: number;
  at: number;
}

interface Entry {
  mesh: AbstractMesh;
  ready: boolean;
  /** Whether the cull and the objects pass draw it now. */
  member: boolean;
  /** Its submeshes as last read (whatever their Material), and the parts a member draws. */
  subMeshes: SubMesh[];
  parts: Part[];
  /** What the list cannot represent about it (as a member), or null. */
  blocker: LayerDrawListFallback | null;
  /** Read again every frame: the journal cannot hear its writes. */
  polled: boolean;
  alphaIndex: number;
  group: number;
  layerMask: number;
  always: boolean;
  sortGroup: unknown;
  sortLayer: unknown;
  ordinal: unknown;
  name: string;
  /** The frame it was last found in the drawable list (`syncEntries`). */
  seen: number;
}

interface List {
  group: number;
  kind: number;
  parts: Part[];
  subMeshes: SubMesh[];
  dirty: boolean;
}

const NO_CANDIDATES: AbstractMesh[] = [];

/** One Scene Layer's retained draw list (see the module comment). */
export class LayerDrawList {
  private readonly scene: Scene;
  private readonly reader: RenderChangeReader;
  private readonly restoreCandidates: () => void;
  private readonly drawableCandidates: () => ISmartArrayLike<AbstractMesh>;
  private readonly work: LayerDrawListWork = {
    retainedFrames: 0, fallbackFrames: 0, fallbacks: {}, checkedFrames: 0, fullReads: 0, rereads: 0, relists: 0, keptOrders: 0,
    heals: 0, mismatches: 0, mismatchDetails: [],
  };
  /** The objects pass it fills, its graph and camera, and whether the graph's cull feeds nothing else. */
  private renderer: ObjectRenderer | null = null;
  private graph: FrameGraph | null = null;
  private camera: () => Camera | undefined = () => undefined;
  private objectsOnly = false;
  private readonly entries = new Map<AbstractMesh, Entry>();
  private readonly lists = new Map<number, List>();
  private readonly named = new Map<AbstractMesh, number>();
  private readonly notReady = new Set<Entry>();
  private readonly polled = new Set<Entry>();
  private readonly moved: Part[] = [];
  /** Members the list cannot represent. */
  private blocked = 0;
  private valid = false;
  private drawableRevision = -1;
  private readinessRevision = -1;
  private revealRevision = -1;
  private readonly cameraKey = new Float64Array(36);
  private readonly settings: unknown[] = [];
  private planes: Plane[] | null = null;
  private eye: Vector3 = Vector3.Zero();
  private stamp = 0;
  private sinceCheck = 0;
  /** This render draws from the retained lists (`retaining`) or checks them against Babylon's (`checking`). */
  private retaining = false;
  private checking = false;
  /** The group arrays it filled this render, unmarked after the pass. */
  private readonly installed: object[] = [];
  /** The meshes the batcher drew last frame: Babylon's mesh loop and the cull's output while retaining. */
  readonly outputMeshes: AbstractMesh[] = [];
  private readonly candidates: ISmartArrayLike<AbstractMesh> = { data: this.outputMeshes, length: 0 };
  private readonly expected = new Map<number, SubMesh[]>();
  private readonly captured = new Map<number, SubMesh[]>();
  private readonly arrayKeys = new Map<object, number>();

  constructor(scene: Scene) {
    this.scene = scene;
    this.reader = openRenderChangeReader(scene);
    const candidates = scene.getActiveMeshCandidates;
    this.drawableCandidates = () => candidates.call(scene);
    scene.getActiveMeshCandidates = () => this.meshLoopCandidates();
    this.restoreCandidates = () => { scene.getActiveMeshCandidates = candidates; };
    observeSortedPasses(scene, this.capture);
  }

  /** What the list did since it was made (`LayerDrawListWork`), as a copy. */
  get drawWork(): LayerDrawListWork {
    return { ...this.work, fallbacks: { ...this.work.fallbacks }, mismatchDetails: [...this.work.mismatchDetails] };
  }

  /** Whether the render in progress draws from the retained lists: the cull then reads no mesh. */
  retainsFrame(): boolean {
    return this.retaining && this.scene.frameGraph === this.graph;
  }

  /**
   * Fills `renderer` (the graph's objects pass) from now on; `objectsOnly` when nothing but it reads the graph's cull.
   * The objects pass's list preparation installs the retained lists on a frame that draws from them.
   */
  attach(graph: FrameGraph, renderer: ObjectRenderer, camera: () => Camera | undefined, objectsOnly: boolean): void {
    this.graph = graph;
    this.renderer = renderer;
    this.camera = camera;
    this.objectsOnly = objectsOnly;
    this.valid = false;
    const internals = renderer as unknown as RendererInternals;
    const prepare = internals._prepareRenderingManager;
    internals._prepareRenderingManager = (passIndex = 0, winterIsComing = false) => {
      this.unmarkInstalled();
      if (this.renderer === renderer && this.retaining) return this.install(renderer);
      const result = prepare.call(renderer, passIndex, winterIsComing);
      if (this.renderer === renderer && this.checking) this.keyArrays(renderer);
      return result;
    };
    renderer.onAfterRenderingManagerRenderObservable.add(() => {
      if (this.renderer !== renderer) return;
      this.unmarkInstalled();
      if (this.checking) this.compare();
    });
  }

  dispose(): void {
    this.reader.dispose();
    this.restoreCandidates();
    observeSortedPasses(this.scene, null);
    this.unmarkInstalled();
    this.renderer = null;
    this.graph = null;
    this.entries.clear();
    this.lists.clear();
    this.notReady.clear();
    this.polled.clear();
    this.outputMeshes.length = 0;
  }

  /**
   * The mesh loop's candidates, asked once per render after the before-render observers: keeps the list up to date
   * and decides whether this render draws from it (the batcher's last outputs) or takes Babylon's full path (the
   * drawable meshes).
   */
  private meshLoopCandidates(): ISmartArrayLike<AbstractMesh> {
    this.retaining = false;
    this.checking = false;
    const renderer = this.renderer;
    if (!renderer || !this.graph || this.scene.frameGraph !== this.graph) return this.drawableCandidates();
    const blocker = this.passBlocker(renderer);
    if (blocker) {
      this.fallBack(blocker);
      // Nothing is kept meanwhile: the list is read anew once it may draw again.
      this.valid = false;
      this.moved.length = 0;
      this.reader.drain(ignore);
      return this.drawableCandidates();
    }
    const camera = this.camera() as CameraInternals;
    const meshes = layerDrawableMeshes(this.scene) ?? NO_CANDIDATES;
    // Babylon's own test for every drawable mesh: the moved ones (and what they move) are recomputed, as its mesh loop
    // would, and the journal hears them.
    for (let index = 0; index < meshes.length; index += 1) meshes[index]!.computeWorldMatrix();
    this.update(renderer, camera, meshes);
    const blocked = this.firstBlocker();
    if (blocked) {
      this.fallBack(blocked);
      // The entries stay up to date; their lists are sorted again once the list may draw.
      for (const part of this.moved) this.mark(part.key);
      this.moved.length = 0;
      return this.drawableCandidates();
    }
    this.relist(renderer, meshes);
    this.sinceCheck += 1;
    if (this.sinceCheck >= (verifies ? VERIFY_INTERVAL : CHECK_INTERVAL)) {
      this.sinceCheck = 0;
      this.checking = true;
      this.work.checkedFrames += 1;
      this.keepExpected();
      return this.drawableCandidates();
    }
    this.retaining = true;
    this.work.retainedFrames += 1;
    const outputs = sceneDrawBatcher(this.scene)!.outputs(), kept = this.outputMeshes;
    // By index: a renderer observing the list (the cull's output is its render list) hears no push.
    for (let index = 0; index < outputs.length; index += 1) kept[index] = outputs[index]!;
    kept.length = outputs.length;
    this.candidates.length = outputs.length;
    return this.candidates;
  }

  private fallBack(reason: LayerDrawListFallback): void {
    this.work.fallbackFrames += 1;
    this.work.fallbacks[reason] = (this.work.fallbacks[reason] ?? 0) + 1;
  }

  /** What makes the whole frame take Babylon's full path, whatever its meshes. */
  private passBlocker(renderer: ObjectRenderer): LayerDrawListFallback | null {
    const scene = this.scene;
    if (!this.objectsOnly) return "graph";
    if (!sceneDrawBatcher(scene) || scene._activeMeshesFrozenButKeepClipping) return "batcher";
    if (scene._activeMeshesFrozen) return "frozen";
    if (renderer.renderParticles && scene.particlesEnabled && scene.particleSystems.length > 0) return "particles";
    const manager = (renderer as unknown as RendererInternals)._renderingManager;
    if (renderer.customRenderFunction || !renderer.renderMeshes || renderer.getCustomRenderList || renderer.enableBoundingBoxRendering ||
      renderer.options.numPasses !== 1 || manager.maintainStateBetweenFrames || scene.useOrderIndependentTransparency || scene.customLODSelector)
      return "renderer";
    if (!this.camera()) return "camera";
    return null;
  }

  private firstBlocker(): LayerDrawListFallback | null {
    if (this.blocked === 0) return null;
    for (const entry of this.entries.values()) if (entry.member && entry.blocker) return entry.blocker;
    return null;
  }

  /** Brings every entry up to date with what changed since the last render. */
  private update(renderer: ObjectRenderer, camera: CameraInternals, meshes: readonly AbstractMesh[]): void {
    const scene = this.scene;
    this.planes = null;
    this.eye = camera.globalPosition;
    const cameraMoved = this.readCamera(camera);
    const settingsChanged = this.readSettings(renderer);
    const readiness = sceneReadinessRevision(scene), reveal = revealPendingRevision(scene), drawable = layerDrawableMeshRevision(scene);
    const named = this.named;
    named.clear();
    const heard = this.reader.drain(this.visit);
    const full = !this.valid || !heard || settingsChanged || readiness !== this.readinessRevision || reveal !== this.revealRevision;
    this.readinessRevision = readiness;
    this.revealRevision = reveal;
    this.stamp += 1;
    if (full) {
      this.readAll(renderer, meshes);
      this.drawableRevision = drawable;
      this.valid = true;
      named.clear();
      return;
    }
    if (drawable !== this.drawableRevision) {
      this.drawableRevision = drawable;
      this.syncEntries(renderer, meshes);
    }
    if (cameraMoved) {
      // The frustum and every distance to the camera: no readiness answer moves.
      for (const entry of this.entries.values()) this.reread(renderer, entry, false);
      this.markAll();
    } else {
      for (const [mesh, kinds] of named) {
        const entry = this.entries.get(mesh);
        // Style alone moves neither membership nor list (crossing full opacity marks the readiness revision).
        if (!entry || !(kinds & ~RenderChange.Style)) continue;
        // Babylon's readiness reads no pose.
        this.reread(renderer, entry, (kinds & ~(RenderChange.Transform | RenderChange.Style)) !== 0);
      }
    }
    named.clear();
    // Babylon asks a mesh that was not ready every frame, and one the journal cannot hear changes unheard.
    for (const entry of [...this.notReady]) this.reread(renderer, entry, true);
    for (const entry of this.polled) this.reread(renderer, entry, true);
    for (const entry of this.entries.values()) this.poll(renderer, entry);
  }

  private readonly visit = (node: Node, kinds: number): void => {
    if (!(node instanceof AbstractMesh)) return;
    this.named.set(node, (this.named.get(node) ?? 0) | kinds);
  };

  /** Whether the camera's view, projection, eye or layer mask changed since the last render (the key is kept). */
  private readCamera(camera: Camera): boolean {
    const key = this.cameraKey, view = camera.getViewMatrix().m, projection = camera.getProjectionMatrix().m, eye = camera.globalPosition;
    let changed = false;
    const put = (at: number, value: number) => {
      if (key[at] !== value && !(Number.isNaN(value) && Number.isNaN(key[at]))) { key[at] = value; changed = true; }
    };
    for (let index = 0; index < 16; index += 1) { put(index, view[index]!); put(16 + index, projection[index]!); }
    put(32, eye.x); put(33, eye.y); put(34, eye.z); put(35, camera.layerMask);
    return changed;
  }

  /** Whether the renderer's or its groups' settings the list reads changed since the last render. */
  private readSettings(renderer: ObjectRenderer): boolean {
    const values = this.settings;
    let at = 0, changed = false;
    const put = (value: unknown) => {
      if (at >= values.length || values[at] !== value) { values[at] = value; changed = true; }
      at += 1;
    };
    put(this.scene.skipFrustumClipping);
    put(renderer.forceLayerMaskCheck);
    put(renderer.customIsReadyFunction);
    put(renderer.refreshRate);
    const groups = (renderer as unknown as RendererInternals)._renderingManager._renderingGroups;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index] as unknown as GroupInternals | undefined;
      put(group); put(group?._opaqueSortCompareFn); put(group?._alphaTestSortCompareFn); put(group?._transparentSortCompareFn); put(group?.disableDepthPrePass);
    }
    if (values.length !== at) { values.length = at; changed = true; }
    return changed;
  }

  private frustum(): Plane[] {
    if (!this.planes) {
      const camera = this.camera() as CameraInternals;
      camera._updateFrustumPlanes();
      this.planes = camera._frustumPlanes;
    }
    return this.planes;
  }

  /** Reads every drawable mesh anew: a lost journal, a readiness or reveal change, or new renderer settings. */
  private readAll(renderer: ObjectRenderer, meshes: readonly AbstractMesh[]): void {
    this.entries.clear();
    this.notReady.clear();
    this.polled.clear();
    this.blocked = 0;
    for (const mesh of meshes) this.entries.set(mesh, this.create(renderer, mesh));
    this.markAll();
    this.work.fullReads += 1;
  }

  /** The drawable list changed: new meshes are read, gone ones dropped, and every list follows its new order. */
  private syncEntries(renderer: ObjectRenderer, meshes: readonly AbstractMesh[]): void {
    const stamp = this.stamp;
    for (const mesh of meshes) {
      const entry = this.entries.get(mesh);
      if (entry) entry.seen = stamp;
      else this.entries.set(mesh, this.create(renderer, mesh));
    }
    for (const [mesh, entry] of this.entries) {
      if (entry.seen === stamp) continue;
      this.forget(entry);
      this.entries.delete(mesh);
    }
    this.markAll();
  }

  private create(renderer: ObjectRenderer, mesh: AbstractMesh): Entry {
    const entry: Entry = {
      mesh, ready: false, member: false, subMeshes: [], parts: [], blocker: null, polled: !journalFollows(mesh),
      alphaIndex: 0, group: 0, layerMask: 0, always: false, sortGroup: undefined, sortLayer: undefined, ordinal: undefined, name: "",
      seen: this.stamp,
    };
    if (entry.polled) this.polled.add(entry);
    this.read(renderer, entry, true);
    return entry;
  }

  private forget(entry: Entry): void {
    if (entry.member && entry.blocker) this.blocked -= 1;
    this.notReady.delete(entry);
    this.polled.delete(entry);
    entry.member = false;
  }

  /**
   * Reads `entry` again (its readiness too when `askReady`); its lists follow when what it draws changed, and a moved
   * blended member's distance is updated (`moved`) for the order check.
   */
  private reread(renderer: ObjectRenderer, entry: Entry, askReady: boolean): void {
    this.work.rereads += 1;
    const wasMember = entry.member, before = entry.parts;
    entry.parts = [];
    this.read(renderer, entry, askReady);
    if (wasMember !== entry.member || !sameParts(before, entry.parts)) {
      for (const part of before) this.mark(part.key);
      for (const part of entry.parts) this.mark(part.key);
      return;
    }
    // The same draws: the parts the lists hold stay, and a blended one whose sort keys moved is checked in its place.
    entry.parts = before;
    for (const part of before) {
      if ((part.key & 3) !== BLENDED) continue;
      const subMesh = part.subMesh, alphaIndex = subMesh._alphaIndex, distance = subMesh._distanceToCamera;
      setBlendKeys(subMesh, this.eye);
      if (subMesh._alphaIndex !== alphaIndex || !Object.is(subMesh._distanceToCamera, distance)) this.moved.push(part);
    }
  }

  /** What the cull and the objects pass answer for `entry`'s mesh now (its readiness kept unless `askReady`). */
  private read(renderer: ObjectRenderer, entry: Entry, askReady: boolean): void {
    const mesh = entry.mesh;
    if (entry.member && entry.blocker) this.blocked -= 1;
    this.keepPolled(entry);
    if (askReady) {
      // The cull's test, then the objects pass's (`customIsReadyFunction` or `isReady(refreshRate === 0)`).
      entry.ready = mesh.isReady() && (renderer.customIsReadyFunction
        ? renderer.customIsReadyFunction(mesh, renderer.refreshRate, false)
        : renderer.refreshRate !== 0 || mesh.isReady(true));
      if (entry.ready) this.notReady.delete(entry);
      else this.notReady.add(entry);
    }
    const camera = this.camera()!;
    const subMeshes = mesh.subMeshes;
    entry.subMeshes.length = 0;
    if (subMeshes) for (const subMesh of subMeshes) entry.subMeshes.push(subMesh);
    // The cull's test (the objects pass repeats its layer mask, enabled and visible tests), then the hidden-mesh filter.
    entry.member = entry.ready && !mesh.isBlocked && mesh.isEnabled() && !mesh.scaling.hasAZeroComponent && mesh.isVisible &&
      mesh.visibility > 0 && (mesh.layerMask & camera.layerMask) !== 0 &&
      (this.scene.skipFrustumClipping || mesh.alwaysSelectAsActiveMesh || mesh.isInFrustum(this.frustum())) &&
      !isRevealPending(mesh) && !!subMeshes;
    entry.parts.length = 0;
    entry.blocker = null;
    if (!entry.member) return;
    entry.blocker = meshBlocker(mesh);
    const manager = (renderer as unknown as RendererInternals)._renderingManager;
    for (const subMesh of subMeshes) {
      const material = subMesh.getMaterial();
      if (!material) continue;
      const group = manager.getRenderingGroup(mesh.renderingGroupId) as unknown as GroupInternals;
      const blends = material.needAlphaBlendingForMesh(mesh);
      const tests = !blends && material.needAlphaTestingForMesh(mesh);
      const depth = !blends && material.needDepthPrePass && !group.disableDepthPrePass;
      if (depth) entry.blocker ??= "depthPrePass";
      const kind = blends ? BLENDED : tests ? ALPHA_TEST : OPAQUE;
      entry.parts.push({ subMesh, material, key: mesh.renderingGroupId * 4 + kind, blends, tests, depth: material.needDepthPrePass, seq: -1, at: -1 });
    }
    if (entry.blocker) this.blocked += 1;
  }

  /** Keeps what `poll` compares. */
  private keepPolled(entry: Entry): void {
    const mesh = entry.mesh, metadata = mesh.metadata as SortMetadata;
    entry.alphaIndex = mesh.alphaIndex;
    entry.group = mesh.renderingGroupId;
    entry.layerMask = mesh.layerMask;
    entry.always = mesh.alwaysSelectAsActiveMesh;
    entry.name = mesh.name;
    entry.sortGroup = metadata?.sortingGroupId;
    entry.sortLayer = metadata?.sortingLayerKey;
    entry.ordinal = metadata?.tilemapLayer?.ordinal;
  }

  /** Compares what no write point notes with what `entry` last read; a difference reads it again. */
  private poll(renderer: ObjectRenderer, entry: Entry): void {
    const mesh = entry.mesh, metadata = mesh.metadata as SortMetadata;
    let changed = entry.layerMask !== mesh.layerMask || entry.always !== mesh.alwaysSelectAsActiveMesh || entry.group !== mesh.renderingGroupId;
    let order = entry.alphaIndex !== mesh.alphaIndex || entry.name !== mesh.name || entry.sortGroup !== metadata?.sortingGroupId ||
      entry.sortLayer !== metadata?.sortingLayerKey || entry.ordinal !== metadata?.tilemapLayer?.ordinal;
    if (entry.member) {
      const subMeshes = mesh.subMeshes, kept = entry.subMeshes;
      if (!subMeshes || subMeshes.length !== kept.length) changed = true;
      else for (let index = 0; !changed && index < kept.length; index += 1) if (subMeshes[index] !== kept[index]) changed = true;
      // Which list each Material puts its submesh in: a Material's own state (alpha, transparency mode, its graph's
      // hints) changes unheard.
      for (let index = 0; !changed && index < entry.parts.length; index += 1) {
        const part = entry.parts[index]!, material = part.material;
        if (material.needDepthPrePass !== part.depth) changed = true;
        else {
          const blends = material.needAlphaBlendingForMesh(mesh);
          if (blends !== part.blends || (!blends && material.needAlphaTestingForMesh(mesh) !== part.tests)) changed = true;
        }
      }
    }
    if (changed) {
      this.reread(renderer, entry, true);
      order = true;
    }
    if (!order) return;
    this.keepPolled(entry);
    for (const part of entry.parts) this.mark(part.key);
  }

  private mark(key: number): void {
    let list = this.lists.get(key);
    if (!list) this.lists.set(key, (list = { group: key >> 2, kind: key & 3, parts: [], subMeshes: [], dirty: true }));
    list.dirty = true;
  }

  private markAll(): void {
    for (const list of this.lists.values()) list.dirty = true;
    for (const entry of this.entries.values()) for (const part of entry.parts) this.mark(part.key);
  }

  /**
   * Rebuilds the lists that changed, from dispatch order, sorted as Babylon sorts them; a blended list whose members
   * only moved is kept when each moved member still sits between its neighbours.
   */
  private relist(renderer: ObjectRenderer, meshes: readonly AbstractMesh[]): void {
    const manager = (renderer as unknown as RendererInternals)._renderingManager;
    for (const part of this.moved) {
      const list = this.lists.get(part.key);
      if (!list || list.dirty) continue;
      const group = manager.getRenderingGroup(list.group) as unknown as GroupInternals;
      const compare = group._transparentSortCompareFn ?? RenderingGroup.defaultTransparentSortCompare;
      if (!inPlace(list, part, compare)) list.dirty = true;
    }
    const kept = this.moved.length > 0;
    this.moved.length = 0;
    let dirty = false;
    for (const list of this.lists.values()) {
      if (list.dirty) {
        dirty = true;
        list.parts.length = 0;
      }
    }
    if (!dirty) {
      if (kept) this.work.keptOrders += 1;
      return;
    }
    for (const mesh of meshes) {
      const entry = this.entries.get(mesh);
      if (!entry?.member) continue;
      for (const part of entry.parts) {
        const list = this.lists.get(part.key)!;
        if (!list.dirty) continue;
        part.seq = list.parts.length;
        list.parts.push(part);
      }
    }
    for (const [key, list] of this.lists) {
      if (!list.dirty) continue;
      list.dirty = false;
      this.work.relists += 1;
      const group = manager.getRenderingGroup(list.group) as unknown as GroupInternals;
      const compare = list.kind === OPAQUE ? group._opaqueSortCompareFn : list.kind === ALPHA_TEST ? group._alphaTestSortCompareFn
        : group._transparentSortCompareFn ?? RenderingGroup.defaultTransparentSortCompare;
      // As `TransparentDepthPrePass` keys a blended list before it sorts it.
      if (list.kind === BLENDED) for (const part of list.parts) setBlendKeys(part.subMesh, this.eye);
      // Babylon's sort, on its input (dispatch order): the same comparisons give the same order.
      if (compare && list.parts.length > 1) list.parts.sort((a, b) => compare(a.subMesh, b.subMesh));
      list.subMeshes.length = list.parts.length;
      for (let index = 0; index < list.parts.length; index += 1) {
        list.parts[index]!.at = index;
        list.subMeshes[index] = list.parts[index]!.subMesh;
      }
      if (list.parts.length === 0) this.lists.delete(key);
    }
  }

  /** Puts the retained lists in the objects pass's rendering groups, in draw order, in place of its preparation. */
  private install(renderer: ObjectRenderer): readonly AbstractMesh[] {
    const internals = renderer as unknown as RendererInternals;
    const manager = internals._renderingManager;
    manager.reset();
    internals._activeMeshes.reset();
    internals._activeBoundingBoxes.reset();
    for (const list of this.lists.values()) {
      if (list.subMeshes.length === 0) continue;
      const group = manager.getRenderingGroup(list.group) as unknown as GroupInternals;
      const array = list.kind === OPAQUE ? group._opaqueSubMeshes : list.kind === ALPHA_TEST ? group._alphaTestSubMeshes : group._transparentSubMeshes;
      for (const subMesh of list.subMeshes) array.push(subMesh);
      group._empty = false;
      setPresortedPass(array, true);
      this.installed.push(array);
    }
    return this.outputMeshes;
  }

  private unmarkInstalled(): void {
    for (const array of this.installed) setPresortedPass(array, false);
    this.installed.length = 0;
  }

  /** A check frame: the lists the retained path would hand the batcher, to compare with Babylon's. */
  private keepExpected(): void {
    this.expected.clear();
    this.captured.clear();
    for (const [key, list] of this.lists) if (list.subMeshes.length) this.expected.set(key, [...list.subMeshes]);
  }

  /** After Babylon's preparation on a check frame: which list each group array is. */
  private keyArrays(renderer: ObjectRenderer): void {
    this.arrayKeys.clear();
    const groups = (renderer as unknown as RendererInternals)._renderingManager._renderingGroups;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index] as unknown as GroupInternals | undefined;
      if (!group) continue;
      this.arrayKeys.set(group._opaqueSubMeshes, index * 4 + OPAQUE);
      this.arrayKeys.set(group._alphaTestSubMeshes, index * 4 + ALPHA_TEST);
      this.arrayKeys.set(group._transparentSubMeshes, index * 4 + BLENDED);
      // The depth-only list: a member drawing one makes the frame fall back, so any here is a difference.
      this.arrayKeys.set(group._depthOnlySubMeshes, index * 4 + 3);
    }
  }

  private readonly capture = (list: object, sorted: readonly SubMesh[], count: number): void => {
    if (!this.checking) return;
    const key = this.arrayKeys.get(list);
    if (key === undefined) return;
    this.captured.set(key, sorted.slice(0, count));
  };

  /** Compares Babylon's sorted lists of a check frame with the retained ones; a difference is healed and counted. */
  private compare(): void {
    this.checking = false;
    const keys = new Set([...this.expected.keys(), ...this.captured.keys()]);
    let differs = false;
    for (const key of keys) {
      const babylon = this.captured.get(key) ?? NO_SUBMESHES, kept = this.expected.get(key) ?? NO_SUBMESHES;
      let at = 0;
      while (at < babylon.length && at < kept.length && babylon[at] === kept[at]) at += 1;
      if (at === babylon.length && at === kept.length) continue;
      differs = true;
      const details = this.work.mismatchDetails;
      if (details.length < MAX_MISMATCH_DETAILS) {
        const kind = (key & 3) === 3 ? "depth-only" : KIND_NAMES[key & 3];
        details.push(`group ${key >> 2} ${kind}: Babylon ${babylon.length}, retained ${kept.length}, first difference at ${at} ` +
          `(${babylon[at]?.getMesh().name ?? "none"} / ${kept[at]?.getMesh().name ?? "none"})`);
      }
    }
    this.expected.clear();
    this.captured.clear();
    if (!differs) return;
    if (verifies) this.work.mismatches += 1;
    else this.work.heals += 1;
    this.valid = false;
  }
}

const NO_SUBMESHES: SubMesh[] = [];
const ignore = (): void => {};

/** What the list cannot represent about a drawing mesh: work Babylon's preparation does for it that the list skips. */
function meshBlocker(mesh: AbstractMesh): LayerDrawListFallback | null {
  if (mesh.isAnInstance || mesh.hasInstances || mesh.hasThinInstances) return "instances";
  if (mesh instanceof Mesh && mesh.hasLODLevels) return "lod";
  if (mesh.skeleton) return "skeleton";
  if (mesh._edgesRenderer) return "edges";
  return null;
}

/** The keys a blended list sorts by, as Babylon sets them before its sort. */
function setBlendKeys(subMesh: SubMesh, eye: Vector3): void {
  subMesh._alphaIndex = subMesh.getMesh().alphaIndex;
  subMesh._distanceToCamera = Vector3.Distance(subMesh.getBoundingInfo().boundingSphere.centerWorld, eye);
}

function sameParts(a: readonly Part[], b: readonly Part[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!, y = b[index]!;
    if (x.subMesh !== y.subMesh || x.key !== y.key || x.material !== y.material || x.tests !== y.tests || x.depth !== y.depth) return false;
  }
  return true;
}

/**
 * Whether `part`, whose sort keys moved, still sits in `list`'s order: before its next and after its previous by
 * `compare`, ties by dispatch order (what Babylon's stable sort keeps). Only Babylon's default blended compare, a
 * consistent order on finite distances, is trusted this way.
 */
function inPlace(list: List, part: Part, compare: SortCompare): boolean {
  if (compare !== RenderingGroup.defaultTransparentSortCompare || !Number.isFinite(part.subMesh._distanceToCamera)) return false;
  const parts = list.parts, at = part.at;
  if (parts[at] !== part) return false;
  const before = (a: Part, b: Part) => {
    const order = compare(a.subMesh, b.subMesh);
    return order < 0 || (order === 0 && a.seq < b.seq);
  };
  if (at > 0 && !before(parts[at - 1]!, part)) return false;
  if (at < parts.length - 1 && !before(part, parts[at + 1]!)) return false;
  return true;
}

const drawLists = new WeakMap<Scene, LayerDrawList>();

/**
 * Keeps `scene`'s retained draw list from now on, until the Scene is disposed. For Scene Layers, after their draw
 * batching and drawable mesh list (`setSceneDrawBatching`, `keepLayerDrawableMeshes`).
 */
export function keepLayerDrawList(scene: Scene): void {
  if (drawLists.has(scene)) return;
  const list = new LayerDrawList(scene);
  drawLists.set(scene, list);
  scene.onDisposeObservable.addOnce(() => {
    list.dispose();
    drawLists.delete(scene);
  });
}

/**
 * A forward graph's objects pass of `scene` draws from its retained draw list where it keeps one (null otherwise):
 * `objectsOnly` when nothing but that pass reads the graph's cull.
 */
export function attachLayerDrawList(
  scene: Scene, graph: FrameGraph, renderer: ObjectRenderer, camera: () => Camera | undefined, objectsOnly: boolean,
): LayerDrawList | null {
  const list = drawLists.get(scene);
  if (!list) return null;
  list.attach(graph, renderer, camera, objectsOnly);
  return list;
}

/** How `scene`'s draw list was kept (`LayerDrawListWork`), as a copy; null for a Scene that keeps none. */
export function layerDrawListWork(scene: Scene): LayerDrawListWork | null {
  return drawLists.get(scene)?.drawWork ?? null;
}
