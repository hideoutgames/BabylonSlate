import type { Plane } from "@babylonjs/core/Maths/math.plane";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { noteRenderChange } from "./render-change-journal";
import { hasDeformingShadowBounds } from "./shadow-mesh-policy";

const distanceCulled = new WeakSet<AbstractMesh>();

/**
 * Takes a caster out of every shadow map while it stays drawn in the view (a foliage cell beyond its Shadow Distance),
 * or puts it back. The caster walk reads it as a change of the caster (`ShadowMapRefresh`), heard through the render
 * change journal (`RenderChange.Other`), so the tiles it reaches redraw in the frame it changes; nothing marks the
 * Scene's readiness.
 */
export function setShadowDistanceCulled(mesh: AbstractMesh, culled: boolean): void {
  if (distanceCulled.has(mesh) === culled) return;
  if (culled) distanceCulled.add(mesh);
  else distanceCulled.delete(mesh);
  noteRenderChange(mesh);
}

/** Whether `setShadowDistanceCulled` took the caster out of the shadow maps. */
export function isShadowDistanceCulled(mesh: AbstractMesh): boolean {
  return distanceCulled.has(mesh);
}

type Bounds = { min: Vector3; max: Vector3 };

/** The caster walk's changes (`ShadowMapRefresh`), from which `prepare` reads only the casters that changed. */
export interface CasterChanges {
  changeCursor(): number;
  forEachChangeSince(cursor: number, visit: (mesh: AbstractMesh, removed: boolean) => void): boolean;
  stageCheck(): "verify" | "heal" | null;
  noteStageMiss(kind: string, count?: number): void;
  noteStage(counter: "prepared" | "prepareScans", count?: number): void;
}

/**
 * A Scene's shadow casters, asked which of them a map layer's planes hold. A hierarchy over the casters had to be
 * refitted for every one that moved: in a Scene of moving casters, more work than the queries it saved. Here a frame
 * reads every caster once (`prepare`: whether it is shown, whether its bounds can be trusted, its world box) into
 * plain arrays, and the frame's queries, one per map layer, test those numbers. A query outside a prepared frame (a
 * readiness probe, an editor pass) reads the casters itself. A caster whose bounds cannot be trusted
 * (`hasDeformingShadowBounds`) is in every query.
 */
export class ShadowCasterList {
  private readonly meshes: AbstractMesh[] = [];
  private readonly places = new Map<AbstractMesh, number>();
  private readonly union: Bounds = { min: Vector3.Zero(), max: Vector3.Zero() };
  /** While `prepared`: per caster, the six numbers of its world box, and 0 (hidden), 1 (shown) or 2 (shown, always held). */
  private boxes = new Float64Array(0);
  private states = new Uint8Array(0);
  /** Per caster, 1 while it may draw into a map (`setDraws`): the queries list only those. Every caster counts in `bounds`. */
  private draws = new Uint8Array(64);
  private prepared = false;
  /**
   * Whether `boxes` and `states` hold what the last `prepare` read of every caster, those added since aside (`added`):
   * the next `prepare` then reads only the casters the walk changed since `cursor` (`CasterChanges`).
   */
  private kept = false;
  private cursor = 0;
  /**
   * The casters to read at the next `prepare` beyond those the walk changed. Only `prepare` empties it, which a Scene
   * without a shadow map never runs (a Scene Layer's), so a removed caster leaves it too: it would hold every caster the
   * Scene ever had.
   */
  private readonly added = new Set<AbstractMesh>();
  private readonly scratch = new Float64Array(6);
  /** While `prepare` reads the changed casters: its `walked`, and how many it read. */
  private changedWalked: ((mesh: AbstractMesh) => { readonly shown: boolean } | undefined) | undefined;
  private changedReads = 0;
  /** Reads a caster the walk changed or `add` added (`prepare`), made once: a frame's `prepare` makes no function. */
  private readonly readChanged = (mesh: AbstractMesh): void => {
    const place = this.places.get(mesh);
    if (place === undefined) return;
    this.read(place, this.changedWalked);
    this.changedReads++;
  };

  add(mesh: AbstractMesh): void {
    if (this.places.has(mesh)) return;
    // A mesh added before its first frame has no world box yet.
    mesh.computeWorldMatrix(true);
    const place = this.meshes.length;
    if (place >= this.draws.length) {
      const draws = new Uint8Array(this.draws.length * 2);
      draws.set(this.draws);
      this.draws = draws;
    }
    this.draws[place] = 1;
    this.places.set(mesh, place);
    this.meshes.push(mesh);
    this.prepared = false;
    this.added.add(mesh);
  }

  /**
   * Whether `mesh` may draw into a map (on when added): one that cannot (`drawsNoShadow`) is in no query, yet still in
   * `bounds`, as the cascades fit to every caster. A caster that comes to draw is read by the next `prepare`.
   */
  setDraws(mesh: AbstractMesh, draws: boolean): void {
    const place = this.places.get(mesh);
    if (place === undefined || (this.draws[place] === 1) === draws) return;
    this.draws[place] = draws ? 1 : 0;
    // Its box and state were not kept while it drew nothing (the walk leaves it out).
    if (draws) this.added.add(mesh);
  }

  /**
   * Reads the casters for the queries that follow, until `release`: call it once nothing moves, shows or hides a
   * caster any more (after the frame's caster walk, whose findings `walked` gives), and `release` when that ends (the
   * Scene's render ends). With the walk's `changes`, it reads only the casters added since the last call and those the
   * walk changed (moved, shown, hidden, changed) since then: a caster's box and whether it is shown change only so, and
   * whether its bounds can be trusted only with a state change the walk reads. Every caster is read again when there
   * is no kept read or the walk's log no longer holds what it needs, and in a frame whose walk also ran the full path
   * (`stageCheck`), which counts each kept entry that read disagrees with and heals it.
   */
  prepare(walked?: (mesh: AbstractMesh) => { readonly shown: boolean } | undefined, changes?: CasterChanges): void {
    const meshes = this.meshes, count = meshes.length;
    let kept = this.kept && !!changes;
    if (this.states.length < count) {
      const room = Math.max(64, 2 ** Math.ceil(Math.log2(count)));
      const boxes = new Float64Array(room * 6), states = new Uint8Array(room);
      boxes.set(this.boxes.subarray(0, Math.min(this.boxes.length, boxes.length)));
      states.set(this.states.subarray(0, Math.min(this.states.length, states.length)));
      this.boxes = boxes;
      this.states = states;
    }
    if (kept) {
      this.changedWalked = walked;
      this.changedReads = 0;
      kept = changes!.forEachChangeSince(this.cursor, this.readChanged);
      if (kept) {
        this.added.forEach(this.readChanged);
        changes!.noteStage("prepared", this.changedReads);
      }
      this.changedWalked = undefined;
    }
    if (!kept) {
      for (let index = 0; index < count; index += 1) this.read(index, walked);
      changes?.noteStage("prepareScans");
    } else if (changes!.stageCheck()) {
      let misses = 0;
      const states = this.states, boxes = this.boxes, box = this.scratch;
      for (let index = 0; index < count; index += 1) {
        // What a caster that draws nothing holds is not kept: no query reads it.
        if (!this.draws[index]) continue;
        const state = states[index]!, at = index * 6;
        for (let value = 0; value < 6; value += 1) box[value] = boxes[at + value]!;
        this.read(index, walked);
        if (states[index] !== state) misses++;
        else if (state === 1)
          for (let value = 0; value < 6; value += 1)
            if (box[value] !== boxes[at + value]) {
              misses++;
              break;
            }
      }
      changes!.noteStageMiss("preparedCasters", misses);
    }
    // Clearing a Set makes it a new table: an empty one is left as it is.
    if (this.added.size) this.added.clear();
    if (changes) this.cursor = changes.changeCursor();
    this.kept = !!changes;
    this.prepared = true;
  }

  /** Reads the caster at `index` into `boxes` and `states`. */
  private read(index: number, walked?: (mesh: AbstractMesh) => { readonly shown: boolean } | undefined): void {
    const mesh = this.meshes[index]!, states = this.states, boxes = this.boxes;
    // The walk already asked whether the caster is enabled and visible; one it has not seen is asked here.
    const seen = walked?.(mesh);
    if (seen ? !seen.shown || mesh.isDisposed() : !mesh.isVisible || mesh.isDisposed() || !mesh.isEnabled() || isShadowDistanceCulled(mesh)) {
      states[index] = 0;
      return;
    }
    states[index] = hasDeformingShadowBounds(mesh) ? 2 : 1;
    const box = mesh.getBoundingInfo().boundingBox, min = box.minimumWorld, max = box.maximumWorld, at = index * 6;
    boxes[at] = min.x; boxes[at + 1] = min.y; boxes[at + 2] = min.z;
    boxes[at + 3] = max.x; boxes[at + 4] = max.y; boxes[at + 5] = max.z;
  }

  /** Ends what `prepare` read: the queries read the casters themselves again. */
  release(): void {
    this.prepared = false;
  }

  remove(mesh: AbstractMesh): void {
    const place = this.places.get(mesh);
    if (place === undefined) return;
    const last = this.meshes.pop()!;
    this.places.delete(mesh);
    this.added.delete(mesh);
    this.prepared = false;
    if (last === mesh) return;
    // The last caster takes the place, with what was read of it.
    const from = this.meshes.length;
    this.draws[place] = this.draws[from]!;
    if (from < this.states.length) {
      this.states[place] = this.states[from]!;
      this.boxes.copyWithin(place * 6, from * 6, from * 6 + 6);
    }
    this.meshes[place] = last;
    this.places.set(last, place);
  }

  dispose(): void {
    this.meshes.length = 0;
    this.places.clear();
    this.prepared = false;
    this.kept = false;
    this.added.clear();
  }

  /** The box around every caster's world box, shown or hidden; undefined without casters. Reused between calls. */
  bounds(): Bounds | undefined {
    const meshes = this.meshes;
    const count = meshes.length;
    if (!count) return undefined;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    if (this.prepared) {
      const boxes = this.boxes, states = this.states;
      for (let index = 0; index < count; index += 1) {
        if (states[index] !== 0) {
          const at = index * 6;
          const x0 = boxes[at]!, y0 = boxes[at + 1]!, z0 = boxes[at + 2]!;
          const x1 = boxes[at + 3]!, y1 = boxes[at + 4]!, z1 = boxes[at + 5]!;
          if (x0 < minX) minX = x0;
          if (y0 < minY) minY = y0;
          if (z0 < minZ) minZ = z0;
          if (x1 > maxX) maxX = x1;
          if (y1 > maxY) maxY = y1;
          if (z1 > maxZ) maxZ = z1;
        } else {
          const box = meshes[index]!.getBoundingInfo().boundingBox, min = box.minimumWorld, max = box.maximumWorld;
          if (min.x < minX) minX = min.x;
          if (min.y < minY) minY = min.y;
          if (min.z < minZ) minZ = min.z;
          if (max.x > maxX) maxX = max.x;
          if (max.y > maxY) maxY = max.y;
          if (max.z > maxZ) maxZ = max.z;
        }
      }
    } else {
      for (let index = 0; index < count; index += 1) {
        const box = meshes[index]!.getBoundingInfo().boundingBox, min = box.minimumWorld, max = box.maximumWorld;
        if (min.x < minX) minX = min.x;
        if (min.y < minY) minY = min.y;
        if (min.z < minZ) minZ = min.z;
        if (max.x > maxX) maxX = max.x;
        if (max.y > maxY) maxY = max.y;
        if (max.z > maxZ) maxZ = max.z;
      }
    }
    this.union.min.set(minX, minY, minZ);
    this.union.max.set(maxX, maxY, maxZ);
    return this.union;
  }

  /**
   * The shown casters inside `planes` that may draw (`setDraws`), into `result` (cleared first, so per-frame callers
   * reuse one list). `everyCaster`: those that draw nothing too, each read from the mesh itself (the full read a check
   * compares with).
   */
  queryPlanes(planes: readonly Plane[], result: AbstractMesh[] = [], everyCaster = false): AbstractMesh[] {
    // Written over in place and shortened after: emptied first, the list would give up its storage and make it again
    // as it grew, every layer of every frame.
    let listed = 0;
    const meshes = this.meshes, draws = this.draws;
    if (!this.prepared || everyCaster) {
      for (let index = 0; index < meshes.length; index += 1) {
        const mesh = meshes[index]!;
        if ((everyCaster || draws[index]) && this.holds(mesh, planes)) result[listed++] = mesh;
      }
      result.length = listed;
      return result;
    }
    // The planes as numbers: a caster's box is tested against each without touching an object.
    const count = planes.length, numbers = this.planeNumbers(planes);
    const boxes = this.boxes, states = this.states;
    casters: for (let index = 0; index < meshes.length; index += 1) {
      const state = states[index]!;
      if (state === 0 || !draws[index]) continue;
      if (state === 1) {
        const at = index * 6;
        for (let plane = 0; plane < count; plane += 1) {
          const p = plane * 4, nx = numbers[p]!, ny = numbers[p + 1]!, nz = numbers[p + 2]!;
          // The same sum on the same doubles as `holds`.
          if (nx * (nx >= 0 ? boxes[at + 3]! : boxes[at]!) + ny * (ny >= 0 ? boxes[at + 4]! : boxes[at + 1]!) +
            nz * (nz >= 0 ? boxes[at + 5]! : boxes[at + 2]!) + numbers[p + 3]! < 0) continue casters;
        }
      }
      result[listed++] = meshes[index]!;
    }
    result.length = listed;
    return result;
  }

  private numbers = new Float64Array(24);
  private planeNumbers(planes: readonly Plane[]): Float64Array {
    if (this.numbers.length < planes.length * 4) this.numbers = new Float64Array(planes.length * 4);
    const numbers = this.numbers;
    for (let index = 0; index < planes.length; index += 1) {
      const plane = planes[index]!, n = plane.normal, at = index * 4;
      numbers[at] = n.x; numbers[at + 1] = n.y; numbers[at + 2] = n.z; numbers[at + 3] = plane.d;
    }
    return numbers;
  }

  /**
   * `queryPlanes` kept to `meshes` and the instances they draw (a readiness probe's scope, which asks an instance when
   * it names its source): the same casters `queryPlanes` would give among them, without asking the others.
   */
  queryPlanesOf(meshes: Iterable<AbstractMesh>, planes: readonly Plane[], result: AbstractMesh[] = []): AbstractMesh[] {
    result.length = 0;
    for (const mesh of meshes) {
      if (this.listsDrawing(mesh) && !result.includes(mesh) && this.holds(mesh, planes)) result.push(mesh);
      const instances = (mesh as AbstractMesh & { instances?: readonly AbstractMesh[] }).instances;
      if (instances)
        for (const instance of instances)
          if (this.listsDrawing(instance) && !result.includes(instance) && this.holds(instance, planes)) result.push(instance);
    }
    return result;
  }

  /** Whether `mesh` is a caster that may draw (`setDraws`). */
  private listsDrawing(mesh: AbstractMesh): boolean {
    const place = this.places.get(mesh);
    return place !== undefined && this.draws[place] === 1;
  }

  /** Whether `mesh` is shown and its world box is not wholly behind one of `planes`. */
  private holds(mesh: AbstractMesh, planes: readonly Plane[]): boolean {
    if (!mesh.isVisible || mesh.isDisposed() || !mesh.isEnabled() || isShadowDistanceCulled(mesh)) return false;
    if (hasDeformingShadowBounds(mesh)) return true;
    const box = mesh.getBoundingInfo().boundingBox, min = box.minimumWorld, max = box.maximumWorld;
    for (let index = 0; index < planes.length; index += 1) {
      const plane = planes[index]!, n = plane.normal;
      if (n.x * (n.x >= 0 ? max.x : min.x) + n.y * (n.y >= 0 ? max.y : min.y) + n.z * (n.z >= 0 ? max.z : min.z) + plane.d < 0) return false;
    }
    return true;
  }
}
