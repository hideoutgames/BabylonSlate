import type { Plane } from "@babylonjs/core/Maths/math.plane";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { hasDeformingShadowBounds } from "./shadow-mesh-policy";

type Bounds = { min: Vector3; max: Vector3 };

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
  private prepared = false;

  add(mesh: AbstractMesh): void {
    if (this.places.has(mesh)) return;
    // A mesh added before its first frame has no world box yet.
    mesh.computeWorldMatrix(true);
    this.places.set(mesh, this.meshes.length);
    this.meshes.push(mesh);
    this.prepared = false;
  }

  /**
   * Reads every caster for the queries that follow, until `release`: call it once nothing moves, shows or hides a
   * caster any more (after the frame's caster walk, whose findings `walked` gives), and `release` when that ends (the
   * Scene's render ends).
   */
  prepare(walked?: (mesh: AbstractMesh) => { readonly shown: boolean } | undefined): void {
    const meshes = this.meshes, count = meshes.length;
    if (this.states.length < count) {
      const room = Math.max(64, 2 ** Math.ceil(Math.log2(count)));
      this.boxes = new Float64Array(room * 6);
      this.states = new Uint8Array(room);
    }
    const boxes = this.boxes, states = this.states;
    for (let index = 0; index < count; index += 1) {
      const mesh = meshes[index]!;
      // The walk already asked whether the caster is enabled and visible; one it has not seen is asked here.
      const seen = walked?.(mesh);
      if (seen ? !seen.shown || mesh.isDisposed() : !mesh.isVisible || mesh.isDisposed() || !mesh.isEnabled()) {
        states[index] = 0;
        continue;
      }
      states[index] = hasDeformingShadowBounds(mesh) ? 2 : 1;
      const box = mesh.getBoundingInfo().boundingBox, min = box.minimumWorld, max = box.maximumWorld, at = index * 6;
      boxes[at] = min.x; boxes[at + 1] = min.y; boxes[at + 2] = min.z;
      boxes[at + 3] = max.x; boxes[at + 4] = max.y; boxes[at + 5] = max.z;
    }
    this.prepared = true;
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
    this.prepared = false;
    if (last === mesh) return;
    this.meshes[place] = last;
    this.places.set(last, place);
  }

  dispose(): void {
    this.meshes.length = 0;
    this.places.clear();
    this.prepared = false;
  }

  /** The box around every caster's world box, shown or hidden; undefined without casters. Reused between calls. */
  bounds(): Bounds | undefined {
    const meshes = this.meshes;
    if (!meshes.length) return undefined;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let index = 0; index < meshes.length; index += 1) {
      const box = meshes[index]!.getBoundingInfo().boundingBox, min = box.minimumWorld, max = box.maximumWorld;
      if (min.x < minX) minX = min.x;
      if (min.y < minY) minY = min.y;
      if (min.z < minZ) minZ = min.z;
      if (max.x > maxX) maxX = max.x;
      if (max.y > maxY) maxY = max.y;
      if (max.z > maxZ) maxZ = max.z;
    }
    this.union.min.set(minX, minY, minZ);
    this.union.max.set(maxX, maxY, maxZ);
    return this.union;
  }

  /** The shown casters inside `planes`, into `result` (cleared first, so per-frame callers reuse one list). */
  queryPlanes(planes: readonly Plane[], result: AbstractMesh[] = []): AbstractMesh[] {
    result.length = 0;
    const meshes = this.meshes;
    if (!this.prepared) {
      for (let index = 0; index < meshes.length; index += 1) {
        const mesh = meshes[index]!;
        if (this.holds(mesh, planes)) result.push(mesh);
      }
      return result;
    }
    // The planes as numbers: a caster's box is tested against each without touching an object.
    const count = planes.length, numbers = this.planeNumbers(planes);
    const boxes = this.boxes, states = this.states;
    casters: for (let index = 0; index < meshes.length; index += 1) {
      const state = states[index]!;
      if (state === 0) continue;
      if (state === 1) {
        const at = index * 6;
        for (let plane = 0; plane < count; plane += 1) {
          const p = plane * 4, nx = numbers[p]!, ny = numbers[p + 1]!, nz = numbers[p + 2]!;
          // The same sum on the same doubles as `holds`.
          if (nx * (nx >= 0 ? boxes[at + 3]! : boxes[at]!) + ny * (ny >= 0 ? boxes[at + 4]! : boxes[at + 1]!) +
            nz * (nz >= 0 ? boxes[at + 5]! : boxes[at + 2]!) + numbers[p + 3]! < 0) continue casters;
        }
      }
      result.push(meshes[index]!);
    }
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
      if (this.places.has(mesh) && !result.includes(mesh) && this.holds(mesh, planes)) result.push(mesh);
      const instances = (mesh as AbstractMesh & { instances?: readonly AbstractMesh[] }).instances;
      if (instances)
        for (const instance of instances)
          if (this.places.has(instance) && !result.includes(instance) && this.holds(instance, planes)) result.push(instance);
    }
    return result;
  }

  /** Whether `mesh` is shown and its world box is not wholly behind one of `planes`. */
  private holds(mesh: AbstractMesh, planes: readonly Plane[]): boolean {
    if (!mesh.isVisible || mesh.isDisposed() || !mesh.isEnabled()) return false;
    if (hasDeformingShadowBounds(mesh)) return true;
    const box = mesh.getBoundingInfo().boundingBox, min = box.minimumWorld, max = box.maximumWorld;
    for (let index = 0; index < planes.length; index += 1) {
      const plane = planes[index]!, n = plane.normal;
      if (n.x * (n.x >= 0 ? max.x : min.x) + n.y * (n.y >= 0 ? max.y : min.y) + n.z * (n.z >= 0 ? max.z : min.z) + plane.d < 0) return false;
    }
    return true;
  }
}
