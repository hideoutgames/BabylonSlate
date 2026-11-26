import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import type { FrameGraphObjectList } from "@babylonjs/core/FrameGraph/frameGraphObjectList";
import type { Plane } from "@babylonjs/core/Maths/math.plane";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";
import { followBounds, journalFollows, openRenderChangeReader, readBounds, RenderChange, type RenderChangeReader } from "./render-change-journal";

/**
 * A view's frustum cull over retained state: Babylon 9.29's `FrameGraphCullObjectsTask` loop, with what its tests read of
 * each mesh copied into flat arrays by slot, so a steady frame reads numbers instead of the scattered objects behind
 * each mesh. One pass over the input in its order emits the kept meshes in that order: the list is Babylon's, member
 * for member.
 *
 * Retained per mesh, and the write that makes it read again (the Scene's render change journal):
 * - `!isBlocked && isReady() && isEnabled() && isVisible && visibility > 0`, as one bit, and `layerMask`: `Enabled`
 *   (`setEnabled`, a re-parent), `Visibility` (`isVisible`, `inheritVisibility`, `visibility`, a source's for its
 *   instances), `Dispatch` (`layerMask`; a level a LOD master gains or loses), `Ready` (`_setReady`, a source's; an
 *   instance taking another source);
 * - the `scaling` vector object (its components are read live, below): `Transform` (the `scaling` setter replaces it);
 * - the world bounding sphere's centre and radius and the bounding box's eight world corners, read through
 *   `getBoundingInfo()`, only where Babylon's loop would call it: `Transform` (a world matrix computed or replaced,
 *   which marks the bounds for Babylon's lazy update), `Bounds` (a bounding info replaced, or the world values of the
 *   one it holds written: `followBounds`).
 * Every mesh is read again after a journal the reader fell behind on.
 *
 * Read live, each only where it can change the answer: a zero component of the retained `scaling` vector (written in
 * place, with no write point) for a mesh the copies find in the frustum; `alwaysSelectAsActiveMesh` and
 * `cullingStrategy`, plain fields, for a mesh they find outside it and one whose strategies disagree. `delayLoadState`
 * decides at a mesh's first read (Babylon's delay loading only moves on from a state that is not 0 or 1, and Haptic
 * never starts it).
 *
 * A mesh whose class or own object redefines what a copy follows (`followed`), a `Mesh` still delay-loading, and an
 * instance of such a source are tested by Babylon's own reads, in their place in the pass (`FLAGS_LIVE`,
 * `BOUNDS_LIVE`).
 *
 * Membership and order: the input list is compared with the retained copy, entry by entry, every frame; a difference
 * matches the two in order, and a new or moved mesh takes a fresh slot (`sync`). A list holding a mesh twice is culled
 * by Babylon's loop.
 *
 * The view's occlusion filter tests the kept meshes' world boxes from the copies too (`outputBounds`).
 *
 * Healing: each pass reads one list place in `HEAL_INTERVAL` (rotating) again in full and compares it with its copies;
 * a difference is a missed notification, counted (`heals`, which must stay 0) and healed. A missed notification
 * therefore lasts at most `HEAL_INTERVAL` frames.
 */

/**
 * A view's input list shorter than this is culled by Babylon's own loop, which then costs about as much as keeping the
 * copies; the copies are released below half of it.
 */
export const RETAINED_CULL_MIN_MESHES = 512;

/**
 * A frame whose drain finds more than this share of the list's bounds changed (most meshes moving each frame) costs more
 * kept than Babylon's loop costs: after `BUSY_FRAMES` such frames in a row the copies are released (the journal stops
 * recording for them) and Babylon's loop culls for `FIRST_BACK_OFF` frames, then the copies are read again to look;
 * each look that finds the list still busy doubles the wait, up to `MAX_BACK_OFF`.
 */
export const BUSY_SHARE = 0.35;
const BUSY_FRAMES = 3;
const FIRST_BACK_OFF = 8;
const MAX_BACK_OFF = 256;

/** One list place in this many is read again in full each pass (power of two). */
const HEAL_INTERVAL = 32;

/** Per slot: the bounds copy is to be read again before its next test. */
const BOUNDS_STALE = 1;
/** Per slot: the mesh's frustum test is its own (`isInFrustum`), every frame. */
const BOUNDS_LIVE = 2;
/** Per slot: the gate copy is to be read again. */
const FLAGS_STALE = 4;
/** Per slot: Babylon's gate is read from the mesh every frame. */
const FLAGS_LIVE = 8;
/** Per slot: the gate copy fails (blocked, not ready, disabled, hidden or invisible). */
const OUT = 16;
/** Per slot: how the mesh is followed is to be decided (`classify`). */
const NEW = 32;
/**
 * Per slot: its bounding info is followed by another mesh too, so its world values are whichever owner's lazy update ran
 * last: the mesh is asked itself (`isInFrustum`) until a read finds it its own again.
 */
const SHARED = 64;

/** Babylon's own classes: members they define are the ones the copies follow. */
const STOCK_PROTOTYPES = new Set<object>([Node.prototype, TransformNode.prototype, AbstractMesh.prototype, Mesh.prototype, InstancedMesh.prototype]);
/** What decides a mesh's world bounds and its frustum test. */
const BOUNDS_NAMES = ["isInFrustum", "getBoundingInfo", "_updateBoundingInfo", "setBoundingInfo", "buildBoundingInfo",
  "_afterComputeWorldMatrix", "_refreshBoundingInfo", "_refreshBoundingInfoDirect", "refreshBoundingInfo", "_checkDelayState",
  "thinInstanceRefreshBoundingInfo"];
/** What Babylon's gate reads, and the writes the journal hears of it. */
const FLAG_NAMES = ["isBlocked", "isReady", "_setReady", "isEnabled", "setEnabled", "_syncParentEnabledState", "isVisible",
  "inheritVisibility", "visibility", "layerMask", "scaling", "addInstance", "addLODLevel", "removeLODLevel"];
const boundsClasses = new WeakMap<object, boolean>();
const flagClasses = new WeakMap<object, boolean>();

/** Whether neither `node`'s class (beyond Babylon's own) nor the object itself redefines one of `names`. */
function followed(node: Node, names: readonly string[], classes: WeakMap<object, boolean>): boolean {
  for (const name of names) if (Object.prototype.hasOwnProperty.call(node, name)) return false;
  const first = Object.getPrototypeOf(node) as object | null;
  if (!first) return false;
  const known = classes.get(first);
  if (known !== undefined) return known;
  let follows = true, prototype: object | null = first;
  for (; prototype && !STOCK_PROTOTYPES.has(prototype); prototype = Object.getPrototypeOf(prototype) as object | null)
    if (names.some((name) => Object.prototype.hasOwnProperty.call(prototype, name))) follows = false;
  if (!prototype) follows = false;
  classes.set(first, follows);
  return follows;
}

/** A `Mesh`'s delay-load state is final: Babylon moves it on only from 2 (loading) and 4 (not loaded). */
const settledLoad = (mesh: Mesh): boolean => mesh.delayLoadState === 0 || mesh.delayLoadState === 1;

/** Whether the copies follow every input of Babylon's gate for `mesh` (its source's, for an instance). */
function flagsFollowed(mesh: AbstractMesh): boolean {
  if (!journalFollows(mesh) || !followed(mesh, FLAG_NAMES, flagClasses)) return false;
  if (mesh instanceof Mesh && !settledLoad(mesh)) return false;
  if (mesh instanceof InstancedMesh) {
    const source = mesh.sourceMesh;
    if (!journalFollows(source) || !followed(source, FLAG_NAMES, flagClasses) || !settledLoad(source)) return false;
  }
  // `isVisible` reads the ancestors a mesh inherits visibility from.
  for (let node: Node = mesh; node.inheritVisibility && node.parent; node = node.parent)
    if (!journalFollows(node.parent) || !followed(node.parent, FLAG_NAMES, flagClasses)) return false;
  return true;
}

/** Whether the copies follow `mesh`'s bounds and its frustum test is Babylon's own, with no load it could start. */
function boundsFollowed(mesh: AbstractMesh): boolean {
  if (!followed(mesh, BOUNDS_NAMES, boundsClasses)) return false;
  return !(mesh instanceof Mesh) || (settledLoad(mesh) && mesh.geometry?.delayLoadState !== 4);
}

/** The cull task's lists, as Babylon's `FrameGraphCullObjectsTask` holds them. */
export interface RetainedCullTask {
  readonly objectList: FrameGraphObjectList;
  readonly outputObjectList: FrameGraphObjectList;
  readonly camera: Camera;
}

/** How a view's frustum cull ran (`ForwardSceneFrameGraph.diagnostics().frustumCull`). */
export interface RetainedFrustumCullWork {
  /** Frames culled over the copies, and by Babylon's loop (a short list, a list holding a mesh twice, frozen meshes). */
  retainedFrames: number;
  stockFrames: number;
  /**
   * The last retained frame: meshes in the list; frustum tests on copies; meshes whose own gate or test was read
   * (followed live); gate and bounds copies read; plain fields read live (`alwaysSelectAsActiveMesh`, `cullingStrategy`).
   */
  listed: number;
  tested: number;
  live: number;
  flagReads: number;
  boundsReads: number;
  fieldReads: number;
  /** Membership or order changes matched (`sync`), and full reads after a journal the reader fell behind on. */
  resyncs: number;
  /** Times the copies were released because the list's bounds changed for most of it (`BUSY_SHARE`). */
  busyReleases: number;
  fullReads: number;
  /** List places read again by the rotating check, and copies it found stale (missed notifications; must stay 0). */
  checks: number;
  heals: number;
}

let verifying = false;

/**
 * Debugging aid: while on, every view with a retained cull takes it whatever its list's length, then runs Babylon's loop
 * too and compares every copy the pass relied on with the mesh: a list (members or order) or a copy that differs throws.
 */
export function verifyRetainedFrustumCull(enabled: boolean): void {
  verifying = enabled;
}

export function verifiesRetainedFrustumCull(): boolean {
  return verifying;
}

type CullScene = Scene & { _activeMeshesFrozen: boolean };
type CullCamera = Camera & { _frustumPlanes: Plane[]; _updateFrustumPlanes(): void };

/** Per strategy (bit = `cullingStrategy`), Babylon's answer; all four agree in most tests. */
const ALL_IN = 15;
const ALL_OUT = 0;

/**
 * One view's retained frustum cull (`RetainedCullTask`), made once per view and kept across graph rebuilds. It reads the
 * journal from its first long list until it is released (a short list, `worlddebug world off`, the view's or the
 * Scene's disposal).
 */
export class RetainedFrustumCull {
  readonly work: RetainedFrustumCullWork = {
    retainedFrames: 0, stockFrames: 0, listed: 0, tested: 0, live: 0, flagReads: 0, boundsReads: 0, fieldReads: 0,
    resyncs: 0, busyReleases: 0, fullReads: 0, checks: 0, heals: 0,
  };
  private readonly scene: Scene;
  private reader: RenderChangeReader | null = null;
  /** The input list as last culled, by place; a disposed mesh's entry is cleared at once (`forget`). */
  private readonly meshes: (AbstractMesh | undefined)[] = [];
  /** Per list place, its mesh's slot; `matched` is the next list's while `sync` matches. */
  private slotAt = new Int32Array(0);
  private matched = new Int32Array(0);
  private readonly slotOf = new Map<AbstractMesh, number>();
  private readonly freeSlots: number[] = [];
  private slotCount = 0;
  /**
   * Per slot: the state bits; the layer mask; the sphere's world centre and radius; the box's eight world corners; the
   * box's world minimum and maximum (which the view's occlusion filter reads, `outputBounds`).
   */
  private states = new Uint8Array(0);
  private layerMasks = new Int32Array(0);
  private spheres = new Float64Array(0);
  private cornerRadii = new Float64Array(0);
  private corners = new Float64Array(0);
  private boxes = new Float64Array(0);
  /** Per entry of `output`, the slot whose box copy is the mesh's this frame, or -1 (`outputBounds`). */
  private outputSlots = new Int32Array(0);
  private readonly bounds: { slots: Int32Array; boxes: Float64Array } = { slots: this.outputSlots, boxes: this.boxes };
  /** Per slot: the scaling vector and the bounding info the copies came from. */
  private scalings: (Vector3 | null)[] = [];
  private infos: (BoundingInfo | null)[] = [];
  /** Per slot, the `sync` that gave it a place: a second place in one list finds it taken. */
  private claimed = new Uint32Array(0);
  private syncSerial = 0;
  /** The list holds a mesh twice: Babylon's loop culls it until it changes. */
  private duplicated = false;
  /** The kept meshes, written by place and length (never pushed): renderers observe it once they draw it. */
  readonly output: AbstractMesh[] = [];
  private readonly planes = new Float64Array(24);
  private readonly planeLengths = new Float64Array(6);
  private healPhase = 0;
  /** Bounds marked stale by this frame's drains; busy frames in a row; the current wait and the frames left of it. */
  private changed = 0;
  private busyFrames = 0;
  private backOff = 0;
  private waitLeft = 0;
  private readonly removed: Observer<AbstractMesh>;
  private readonly disposed: Observer<Scene>;

  constructor(scene: Scene) {
    this.scene = scene;
    // A disposed mesh leaves the Scene at once: its copies and place are dropped then, not at the next cull.
    this.removed = scene.onMeshRemovedObservable.add((mesh) => this.forget(mesh));
    this.disposed = scene.onDisposeObservable.add(() => this.release());
  }

  /**
   * Runs `task`'s cull: over the copies, or with `stock` (Babylon's own pass) for frozen active meshes, a list shorter
   * than `RETAINED_CULL_MIN_MESHES` (unless verifying) or one holding a mesh twice. While verifying, `stock` also runs
   * after the retained pass, and a list that differs, or a copy that differs from what Babylon's loop read, throws.
   */
  execute(task: RetainedCullTask, stock: () => void): void {
    if (!this.cull(task)) {
      this.work.stockFrames += 1;
      stock();
      return;
    }
    if (!verifying) return;
    const kept = task.outputObjectList.meshes!;
    stock();
    const expected = task.outputObjectList.meshes ?? [];
    task.outputObjectList.meshes = kept;
    // A mesh on a shared bounding info is left out of the comparison: the pass asked it itself, in Babylon's order, and
    // Babylon's second loop reads that info after every owner's lazy update of this frame, not as one loop alone would.
    let at = 0, from = 0;
    for (;;) {
      while (at < kept.length && this.sharedMesh(kept[at]!)) at++;
      while (from < expected.length && this.sharedMesh(expected[from]!)) from++;
      if (at >= kept.length || from >= expected.length || kept[at] !== expected[from]) break;
      at++;
      from++;
    }
    if (at < kept.length || from < expected.length)
      throw new Error(`Retained frustum cull differs from Babylon's at ${at}: kept ${kept.length} (${kept[at]?.name ?? "end"}), ` +
        `Babylon kept ${expected.length} (${expected[from]?.name ?? "end"}).`);
    this.verifyCopies(task);
  }

  private sharedMesh(mesh: AbstractMesh): boolean {
    const slot = this.slotOf.get(mesh);
    return slot !== undefined && (this.states[slot]! & SHARED) !== 0;
  }

  /**
   * Compares every copy the pass relied on with the mesh, after Babylon's loop read it: the gate copy always (its reads
   * are pure), the bounds where Babylon's loop asked for them (so this asks nothing it did not).
   */
  private verifyCopies(task: RetainedCullTask): void {
    const input = task.objectList.meshes || this.scene.meshes, layerMask = task.camera.layerMask;
    for (let index = 0; index < input.length; index++) {
      const mesh = input[index]!, slot = this.slotAt[index]!, state = this.states[slot]!;
      if (state & FLAGS_LIVE) continue;
      const out = mesh.isBlocked || !mesh.isReady() || !mesh.isEnabled() || !mesh.isVisible || !(mesh.visibility > 0);
      if (out !== ((state & OUT) !== 0) || this.layerMasks[slot] !== (mesh.layerMask | 0) || this.scalings[slot] !== mesh.scaling)
        this.heal(mesh, "gate");
      const asked = !out && (mesh.layerMask & layerMask) !== 0 && !mesh.scaling.hasAZeroComponent && !this.scene.skipFrustumClipping &&
        !mesh.alwaysSelectAsActiveMesh;
      if (!asked || state & (BOUNDS_LIVE | BOUNDS_STALE | SHARED)) continue;
      const info = mesh.getBoundingInfo();
      if (this.infos[slot] !== info || !this.holds(slot, info)) this.heal(mesh, "bounds");
    }
  }

  /** Culls `task`'s input into `output` as Babylon's loop would and makes it the task's output; false where it cannot. */
  private cull(task: RetainedCullTask): boolean {
    const scene = this.scene as CullScene;
    const input = task.objectList.meshes || scene.meshes;
    if (!verifying && input.length < RETAINED_CULL_MIN_MESHES) {
      if (input.length < RETAINED_CULL_MIN_MESHES / 2) this.release();
      else this.drain();
      return false;
    }
    if (!verifying && this.waitLeft > 0) {
      this.waitLeft -= 1;
      return false;
    }
    if (!this.reader) this.open();
    this.changed = 0;
    this.drain();
    if (!verifying && this.busy(input.length)) return false;
    if (!this.sync(input) || scene._activeMeshesFrozen) return false;
    task.outputObjectList.particleSystems = task.objectList.particleSystems;
    task.outputObjectList.spriteManagers = task.objectList.spriteManagers;
    const output = this.output;
    task.outputObjectList.meshes = output;
    const camera = task.camera as CullCamera;
    camera._updateFrustumPlanes();
    const frustum = camera._frustumPlanes;
    if (frustum.length !== 6) throw new Error("Babylon 9.29 camera frustum has six planes.");
    const planes = this.planes, planeLengths = this.planeLengths;
    for (let index = 0; index < 6; index++) {
      const plane = frustum[index]!, normal = plane.normal, at = index * 4;
      planes[at] = normal.x; planes[at + 1] = normal.y; planes[at + 2] = normal.z; planes[at + 3] = plane.d;
      planeLengths[index] = Math.hypot(normal.x, normal.y, normal.z);
    }
    const layerMask = camera.layerMask, skip = scene.skipFrustumClipping;
    const work = this.work;
    work.tested = work.live = work.flagReads = work.boundsReads = work.fieldReads = 0;
    const phase = this.healPhase = (this.healPhase + 1) & (HEAL_INTERVAL - 1);
    const slotAt = this.slotAt, layerMasks = this.layerMasks, scalings = this.scalings;
    if (this.outputSlots.length < input.length)
      this.bounds.slots = this.outputSlots = new Int32Array(Math.max(64, 2 ** Math.ceil(Math.log2(input.length))));
    const outputSlots = this.outputSlots;
    let count = 0;
    for (let index = 0; index < input.length; index++) {
      const mesh = input[index]!, slot = slotAt[index]!, checked = (index & (HEAL_INTERVAL - 1)) === phase;
      let state = this.states[slot]!;
      if (state & (NEW | FLAGS_STALE) || checked) state = this.settle(slot, mesh, state, checked);
      // Babylon 9.29's `FrameGraphCullObjectsTask` loop: its gate, then `skipFrustumClipping`, `alwaysSelectAsActiveMesh`
      // and the frustum test. Every read but the frustum test's bounds is pure, so their order does not matter.
      if (state & FLAGS_LIVE) {
        work.live += 1;
        if (mesh.isBlocked || !mesh.isReady() || !mesh.isEnabled() || mesh.scaling.hasAZeroComponent) continue;
        if (!mesh.isVisible || !(mesh.visibility > 0) || (mesh.layerMask & layerMask) === 0) continue;
      } else {
        if (state & OUT || (layerMasks[slot]! & layerMask) === 0) continue;
        if (!(skip || state & (BOUNDS_STALE | BOUNDS_LIVE | SHARED) || checked)) {
          // A copy wholly in or out of the frustum needs one of the two live reads: the scale where it is in, whatever
          // `alwaysSelectAsActiveMesh` says; `alwaysSelectAsActiveMesh` where it is out, whatever the scale.
          work.tested += 1;
          const verdict = this.verdict(slot);
          if (verdict !== ALL_IN) {
            work.fieldReads += 1;
            if (!mesh.alwaysSelectAsActiveMesh && (verdict === ALL_OUT || !this.answer(verdict, mesh.cullingStrategy))) continue;
          }
          // Read live, never kept as a bit: a component written to zero in place leaves no note (Babylon's frame skips
          // computing a zero-scaled mesh's world matrix, and a frozen one computes none), yet Babylon's gate reads it.
          if (!scalings[slot]!.hasAZeroComponent) {
            outputSlots[count] = slot;
            output[count++] = mesh;
          }
          continue;
        }
        if (scalings[slot]!.hasAZeroComponent) continue;
      }
      if (skip || this.shows(slot, mesh, state, checked, frustum)) {
        // A copy no change has marked since it was read is what `getBoundingInfo()` returns now, with no update pending.
        outputSlots[count] = this.states[slot]! & (BOUNDS_STALE | BOUNDS_LIVE | SHARED) ? -1 : slot;
        output[count++] = mesh;
      }
    }
    output.length = count;
    work.listed = input.length;
    work.retainedFrames += 1;
    return true;
  }

  /** `mesh.alwaysSelectAsActiveMesh || mesh.isInFrustum(planes)`, on `slot`'s copy where it has one. */
  private shows(slot: number, mesh: AbstractMesh, state: number, checked: boolean, frustum: Plane[]): boolean {
    const work = this.work;
    if (state & BOUNDS_LIVE) {
      work.live += 1;
      return mesh.alwaysSelectAsActiveMesh || mesh.isInFrustum(frustum);
    }
    if (state & SHARED && !(state & BOUNDS_STALE)) {
      work.live += 1;
      if (mesh.alwaysSelectAsActiveMesh) return true;
      const shows = mesh.isInFrustum(frustum);
      // Its lazy update rewrote a bounding info other meshes hold: what that noted is read in this same pass.
      if (this.reader?.pending()) this.drain();
      return shows;
    }
    if (state & BOUNDS_STALE || checked) {
      // `getBoundingInfo()` can update the bounds (Babylon's lazy update): only where Babylon's test would call it.
      work.fieldReads += 1;
      if (mesh.alwaysSelectAsActiveMesh) return true;
      const info = readBounds(mesh);
      if (state & BOUNDS_STALE) {
        const shared = this.copy(slot, mesh, info);
        this.states[slot] = (state & ~(BOUNDS_STALE | SHARED)) | (shared ? SHARED : 0);
        work.boundsReads += 1;
      } else this.checkBounds(slot, mesh, info);
      // The read may have rewritten, or newly shared, a bounding info other meshes hold: Babylon's loop reads their new
      // values later in this same pass, so what that noted is read now, not at the next frame.
      if (this.reader?.pending()) this.drain();
      work.tested += 1;
      // The copy is the mesh's values at this instant, shared or not.
      return this.answer(this.verdict(slot), mesh.cullingStrategy);
    }
    // A FLAGS_LIVE mesh's copy (the pass tests the others itself).
    work.tested += 1;
    const verdict = this.verdict(slot);
    if (verdict === ALL_IN) return true;
    work.fieldReads += 1;
    if (mesh.alwaysSelectAsActiveMesh) return true;
    return verdict !== ALL_OUT && this.answer(verdict, mesh.cullingStrategy);
  }

  /** Babylon's answer for `strategy` among the four `verdict` holds (another value tests as the default, 0). */
  private answer(verdict: number, strategy: number): boolean {
    this.work.fieldReads += 1;
    const bit = strategy === 1 || strategy === 2 || strategy === 3 ? strategy : 0;
    return ((verdict >> bit) & 1) === 1;
  }

  /**
   * Babylon 9.29's `BoundingInfo.isInFrustum(planes, strategy)` on `slot`'s copy for each strategy, as bit `strategy`:
   * the same sums on the same doubles, in the same order, with the same comparisons (so a NaN answers as it does
   * there). 0 tests the sphere then the box, 1 the sphere, 2 (Haptic's, `cull-accuracy.ts`) the centre, then as 0,
   * and 3 the centre, then as 1.
   */
  private verdict(slot: number): number {
    const planes = this.planes, planeLengths = this.planeLengths, spheres = this.spheres, at = slot * 4;
    const x = spheres[at]!, y = spheres[at + 1]!, z = spheres[at + 2]!, radius = spheres[at + 3]!;
    const cornerRadius = this.cornerRadii[slot]!;
    let centreIn = true, sphereOut = false, straddleMask = 0;
    for (let plane = 0, p = 0; plane < 24; plane += 4, p++) {
      const distance = planes[plane]! * x + planes[plane + 1]! * y + planes[plane + 2]! * z + planes[plane + 3]!;
      if (distance < 0) centreIn = false;
      if (distance <= -radius) {
        sphereOut = true;
        // Once the sphere is outside a plane and the centre is outside at least one plane, all 4 strategies reject.
        if (!centreIn) return ALL_OUT;
      }
      if (!(distance > cornerRadius * planeLengths[p]!)) straddleMask |= 1 << p;
    }
    if (sphereOut) return centreIn ? 12 : ALL_OUT;
    // Every plane strictly contains all 8 world corners (and therefore the centre too): skip the 48-dot corner test.
    if (straddleMask === 0) return ALL_IN;
    let boxIn = true;
    const corners = this.corners, base = slot * 24, end = base + 24;
    for (let plane = 0, p = 0; boxIn && plane < 24; plane += 4, p++) {
      if ((straddleMask & (1 << p)) === 0) continue;
      const nx = planes[plane]!, ny = planes[plane + 1]!, nz = planes[plane + 2]!, d = planes[plane + 3]!;
      let reached = false;
      for (let corner = base; corner < end; corner += 3) {
        if (nx * corners[corner]! + ny * corners[corner + 1]! + nz * corners[corner + 2]! + d >= 0) {
          reached = true;
          break;
        }
      }
      boxIn = reached;
    }
    return (boxIn ? 1 : 0) | 2 | (centreIn || boxIn ? 4 : 0) | 8;
  }

  /**
   * Brings `slot`'s gate copy up to date: decides how the mesh is followed when new (`classify`), and reads the gate when
   * stale. `checked` (the rotating check, every place while verifying) reads both again and compares them.
   */
  private settle(slot: number, mesh: AbstractMesh, state: number, checked: boolean): number {
    if (checked && !(state & (NEW | FLAGS_STALE | FLAGS_LIVE))) {
      const before = state, layerMask = this.layerMasks[slot], scaling = this.scalings[slot];
      state = this.readFlags(slot, mesh, state);
      this.work.checks += 1;
      if ((state & OUT) !== (before & OUT) ||
        (!(state & FLAGS_LIVE) && (this.layerMasks[slot] !== layerMask || this.scalings[slot] !== scaling))) this.heal(mesh, "gate");
    } else {
      if (state & NEW) state = this.classify(state, mesh);
      state = this.readFlags(slot, mesh, state);
    }
    this.states[slot] = state;
    return state;
  }

  /** How the mesh is followed: live where its class redefines what a copy follows (`FLAGS_LIVE`, `BOUNDS_LIVE`). */
  private classify(state: number, mesh: AbstractMesh): number {
    let next = state & ~(NEW | FLAGS_LIVE | BOUNDS_LIVE);
    if (!flagsFollowed(mesh)) next |= FLAGS_LIVE;
    else if (state & FLAGS_LIVE) next |= FLAGS_STALE;
    if (!boundsFollowed(mesh)) next |= BOUNDS_LIVE;
    else if (state & BOUNDS_LIVE) next |= BOUNDS_STALE;
    return next;
  }

  /** Reads Babylon's gate of `mesh` into `slot` (pure for every class it follows). */
  private readFlags(slot: number, mesh: AbstractMesh, state: number): number {
    if (state & FLAGS_LIVE) return state & ~(FLAGS_STALE | OUT);
    this.work.flagReads += 1;
    const out = mesh.isBlocked || !mesh.isReady() || !mesh.isEnabled() || !mesh.isVisible || !(mesh.visibility > 0);
    this.layerMasks[slot] = mesh.layerMask;
    this.scalings[slot] = mesh.scaling;
    return (state & ~(FLAGS_STALE | OUT)) | (out ? OUT : 0);
  }

  /** Copies `info`'s world values into `slot`; true when another mesh follows the same bounding info. */
  private copy(slot: number, mesh: AbstractMesh, info: BoundingInfo): boolean {
    const shared = followBounds(mesh, info);
    this.infos[slot] = info;
    const sphere = info.boundingSphere, centre = sphere.centerWorld, spheres = this.spheres, at = slot * 4;
    spheres[at] = centre.x; spheres[at + 1] = centre.y; spheres[at + 2] = centre.z; spheres[at + 3] = sphere.radiusWorld;
    const box = info.boundingBox, vectors = box.vectorsWorld, corners = this.corners, base = slot * 24;
    let maxDistSq = 0;
    for (let corner = 0; corner < 8; corner++) {
      const vector = vectors[corner]!, at = base + corner * 3;
      const vx = vector.x, vy = vector.y, vz = vector.z;
      corners[at] = vx; corners[at + 1] = vy; corners[at + 2] = vz;
      const dx = vx - centre.x, dy = vy - centre.y, dz = vz - centre.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (!(distSq <= maxDistSq)) maxDistSq = distSq;
    }
    const maxDist = Math.sqrt(maxDistSq);
    const scale = Math.abs(centre.x) + Math.abs(centre.y) + Math.abs(centre.z) + maxDist;
    this.cornerRadii[slot] = Number.isFinite(maxDist) && Number.isFinite(scale)
      ? maxDist * (1 + 1e-9) + 1e-9 * (1 + scale)
      : Infinity;
    const min = box.minimumWorld, max = box.maximumWorld, boxes = this.boxes, edge = slot * 6;
    boxes[edge] = min.x; boxes[edge + 1] = min.y; boxes[edge + 2] = min.z;
    boxes[edge + 3] = max.x; boxes[edge + 4] = max.y; boxes[edge + 5] = max.z;
    return shared;
  }

  /** Compares a bounds copy no change named with `info`, the bounding info the test just asked for. */
  private checkBounds(slot: number, mesh: AbstractMesh, info: BoundingInfo): void {
    if (this.infos[slot] === info && this.holds(slot, info)) return;
    this.heal(mesh, "bounds");
    if (this.copy(slot, mesh, info)) this.states[slot] = this.states[slot]! | SHARED;
  }

  /** A copy no notification marked differed from the mesh: counted, and fatal while verifying. */
  private heal(mesh: AbstractMesh, what: string): void {
    this.work.heals += 1;
    if (verifying) throw new Error(`Retained frustum cull: the ${what} of "${mesh.name}" changed without a notification.`);
  }

  /** Whether `slot`'s bounds copy is `info`'s world values, bit for bit. */
  private holds(slot: number, info: BoundingInfo): boolean {
    const sphere = info.boundingSphere, centre = sphere.centerWorld, spheres = this.spheres, at = slot * 4;
    if (!Object.is(spheres[at], centre.x) || !Object.is(spheres[at + 1], centre.y) || !Object.is(spheres[at + 2], centre.z) ||
      !Object.is(spheres[at + 3], sphere.radiusWorld)) return false;
    const box = info.boundingBox, vectors = box.vectorsWorld, corners = this.corners, base = slot * 24;
    for (let corner = 0; corner < 8; corner++) {
      const vector = vectors[corner]!, at = base + corner * 3;
      if (!Object.is(corners[at], vector.x) || !Object.is(corners[at + 1], vector.y) || !Object.is(corners[at + 2], vector.z)) return false;
    }
    const min = box.minimumWorld, max = box.maximumWorld, boxes = this.boxes, edge = slot * 6;
    if (!Object.is(boxes[edge], min.x) || !Object.is(boxes[edge + 1], min.y) || !Object.is(boxes[edge + 2], min.z) ||
      !Object.is(boxes[edge + 3], max.x) || !Object.is(boxes[edge + 4], max.y) || !Object.is(boxes[edge + 5], max.z)) return false;
    return true;
  }

  /** Marks the meshes the journal names since the last drain for reading again; every mesh after a lost journal. */
  private drain(): void {
    const reader = this.reader;
    if (reader && !reader.drain(this.visit)) {
      const states = this.states;
      for (let slot = 0; slot < this.slotCount; slot++) states[slot] = states[slot]! | NEW | FLAGS_STALE | BOUNDS_STALE;
      this.work.fullReads += 1;
    }
  }

  /**
   * Counts a frame whose drain found more than `BUSY_SHARE` of the list's bounds changed; after `BUSY_FRAMES` in a row,
   * releases the copies and waits (doubling while each look finds the list still busy). True when released.
   */
  private busy(length: number): boolean {
    if (this.changed <= length * BUSY_SHARE) {
      this.busyFrames = 0;
      // A look that found the list calm ends the waiting.
      if (this.backOff > 0 && this.work.retainedFrames > this.lookedAt + BUSY_FRAMES) this.backOff = 0;
      return false;
    }
    if (++this.busyFrames < BUSY_FRAMES) return false;
    this.busyFrames = 0;
    this.backOff = this.backOff === 0 ? FIRST_BACK_OFF : Math.min(this.backOff * 2, MAX_BACK_OFF);
    this.waitLeft = this.backOff;
    this.lookedAt = this.work.retainedFrames;
    this.work.busyReleases += 1;
    this.release();
    return true;
  }
  private lookedAt = 0;

  private readonly visit = (node: Node, kinds: number): void => {
    const slot = this.slotOf.get(node as AbstractMesh);
    if (slot === undefined) return;
    let marks = 0;
    if (kinds & (RenderChange.Transform | RenderChange.Bounds)) {
      marks |= BOUNDS_STALE;
      if (!(this.states[slot]! & BOUNDS_STALE)) this.changed += 1;
    }
    if (kinds & (RenderChange.Transform | RenderChange.Visibility | RenderChange.Dispatch | RenderChange.Ready)) marks |= FLAGS_STALE;
    // A re-parent can change what `isVisible` inherits from, and a new geometry what the test would load.
    if (kinds & (RenderChange.Enabled | RenderChange.Geometry)) marks |= NEW | FLAGS_STALE;
    this.states[slot] = this.states[slot]! | marks;
  };

  /**
   * Brings the places up to `input`: unchanged when it holds the same meshes in the same order; otherwise each mesh
   * keeps its slot where the two lists agree in order, a new mesh, or one met out of order, takes a fresh slot to be
   * read, and the meshes left behind free theirs. False while the list holds a mesh twice.
   */
  private sync(input: readonly AbstractMesh[]): boolean {
    const meshes = this.meshes, length = input.length;
    let same = meshes.length === length;
    for (let index = 0; same && index < length; index++) same = input[index] === meshes[index];
    if (same) return !this.duplicated;
    this.work.resyncs += 1;
    if (this.matched.length < length) this.matched = new Int32Array(Math.max(64, 2 ** Math.ceil(Math.log2(length))));
    const matched = this.matched, slotAt = this.slotAt, slotOf = this.slotOf, serial = ++this.syncSerial;
    this.duplicated = false;
    let old = 0;
    for (let index = 0; index < length; index++) {
      const mesh = input[index]!;
      let slot: number;
      if (old < meshes.length && meshes[old] === mesh) {
        slot = slotAt[old++]!;
      } else {
        const known = slotOf.get(mesh);
        if (known === undefined) {
          slot = this.takeSlot();
          slotOf.set(mesh, slot);
        } else if (this.claimed[known] === serial) {
          // A second place for a mesh already placed: its own slot, never looked up, freed when the list changes.
          this.duplicated = true;
          slot = this.takeSlot();
        } else {
          // Met later than its old place: the meshes before that place left the list (or come back later, as new).
          let place = old;
          while (place < meshes.length && meshes[place] !== mesh) place++;
          if (place < meshes.length) {
            while (old < place) this.dropPlace(old++);
            slot = slotAt[old++]!;
          } else {
            this.freeSlot(known);
            slot = this.takeSlot();
            slotOf.set(mesh, slot);
          }
        }
      }
      this.claimed[slot] = serial;
      matched[index] = slot;
    }
    while (old < meshes.length) this.dropPlace(old++);
    // The matched places become the list's; the old array is the next sync's scratch.
    this.matched = this.slotAt;
    this.slotAt = matched;
    for (let index = 0; index < length; index++) meshes[index] = input[index];
    meshes.length = length;
    return !this.duplicated;
  }

  /** Frees the slot of the mesh at `place` of the old list, which left it. */
  private dropPlace(place: number): void {
    const mesh = this.meshes[place];
    // A disposed mesh already gave its slot up (`forget`).
    if (mesh === undefined) return;
    const slot = this.slotAt[place]!;
    if (this.slotOf.get(mesh) === slot) this.slotOf.delete(mesh);
    this.freeSlot(slot);
  }

  private takeSlot(): number {
    let slot = this.freeSlots.pop();
    if (slot === undefined) {
      slot = this.slotCount++;
      if (slot >= this.states.length) this.grow(Math.max(64, this.states.length * 2));
    }
    this.states[slot] = NEW | FLAGS_STALE | BOUNDS_STALE;
    return slot;
  }

  private freeSlot(slot: number): void {
    this.infos[slot] = null;
    this.scalings[slot] = null;
    this.freeSlots.push(slot);
  }

  private grow(room: number): void {
    const states = new Uint8Array(room), layerMasks = new Int32Array(room), claimed = new Uint32Array(room);
    const spheres = new Float64Array(room * 4), cornerRadii = new Float64Array(room), corners = new Float64Array(room * 24), boxes = new Float64Array(room * 6);
    states.set(this.states);
    layerMasks.set(this.layerMasks);
    claimed.set(this.claimed);
    spheres.set(this.spheres);
    cornerRadii.set(this.cornerRadii);
    corners.set(this.corners);
    boxes.set(this.boxes);
    this.states = states;
    this.layerMasks = layerMasks;
    this.claimed = claimed;
    this.spheres = spheres;
    this.cornerRadii = cornerRadii;
    this.corners = corners;
    this.bounds.boxes = this.boxes = boxes;
  }

  /**
   * The world box of each entry of `output` as the cull last wrote it, for a reader that would otherwise ask the mesh
   * (`ViewOcclusion.filter`): per entry, the slot whose six numbers (minimum x, y, z, maximum x, y, z) at `slot * 6` of
   * `boxes` are what its `getBoundingInfo().boundingBox` holds now, or -1 for one to ask itself. Valid until the next
   * cull, as long as `output` changes only through `keepOutput`.
   */
  outputBounds(): { readonly slots: Int32Array; readonly boxes: Float64Array } {
    return this.bounds;
  }

  /** Leaves out of `output`, in place, the meshes `keep` refuses, with their `outputBounds` entries. */
  keepOutput(keep: (mesh: AbstractMesh) => boolean): void {
    const output = this.output, slots = this.outputSlots;
    let kept = 0;
    for (let index = 0; index < output.length; index++) {
      const mesh = output[index]!;
      if (!keep(mesh)) continue;
      slots[kept] = slots[index]!;
      output[kept++] = mesh;
    }
    output.length = kept;
  }

  /** A mesh left the Scene: its place keeps no reference to it, and its slot is free. */
  private forget(mesh: AbstractMesh): void {
    const slot = this.slotOf.get(mesh);
    if (slot === undefined) return;
    this.slotOf.delete(mesh);
    this.freeSlot(slot);
    const meshes = this.meshes, slotAt = this.slotAt;
    for (let place = 0; place < meshes.length; place++) {
      if (meshes[place] === mesh && slotAt[place] === slot) {
        meshes[place] = undefined;
        break;
      }
    }
  }

  private open(): void {
    this.reader = openRenderChangeReader(this.scene, RenderChange.Transform | RenderChange.Bounds | RenderChange.Geometry |
      RenderChange.Enabled | RenderChange.Visibility | RenderChange.Dispatch | RenderChange.Ready);
  }

  /** Drops every copy and stops reading the journal; the next long list reads every mesh again. */
  release(): void {
    if (!this.reader && !this.slotCount && !this.meshes.length) return;
    this.reader?.dispose();
    this.reader = null;
    this.meshes.length = 0;
    this.slotOf.clear();
    this.freeSlots.length = 0;
    this.slotCount = 0;
    this.scalings = [];
    this.infos = [];
    this.output.length = 0;
    this.duplicated = false;
    this.states = new Uint8Array(0);
    this.layerMasks = new Int32Array(0);
    this.spheres = new Float64Array(0);
    this.cornerRadii = new Float64Array(0);
    this.corners = new Float64Array(0);
    this.bounds.boxes = this.boxes = new Float64Array(0);
    this.bounds.slots = this.outputSlots = new Int32Array(0);
    this.claimed = new Uint32Array(0);
    this.slotAt = new Int32Array(0);
    this.matched = new Int32Array(0);
  }

  dispose(): void {
    this.release();
    this.scene.onMeshRemovedObservable.remove(this.removed);
    this.scene.onDisposeObservable.remove(this.disposed);
  }
}
