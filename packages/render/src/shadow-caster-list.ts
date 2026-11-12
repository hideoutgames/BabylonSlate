import type { Plane } from "@babylonjs/core/Maths/math.plane";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { hasDeformingShadowBounds } from "./shadow-mesh-policy";

type Bounds = { min: Vector3; max: Vector3 };

/**
 * A Scene's shadow casters, asked which of them a map layer's planes hold. Each query reads every caster's world box
 * as its mesh holds it now: a few numbers per caster, where a hierarchy over the casters had to be refitted for every
 * one that moved (in a Scene of moving casters, more work than the queries it saved). A caster whose bounds cannot be
 * trusted (`hasDeformingShadowBounds`) is in every query.
 */
export class ShadowCasterList {
  private readonly meshes: AbstractMesh[] = [];
  private readonly places = new Map<AbstractMesh, number>();
  private readonly union: Bounds = { min: Vector3.Zero(), max: Vector3.Zero() };

  add(mesh: AbstractMesh): void {
    if (this.places.has(mesh)) return;
    // A mesh added before its first frame has no world box yet.
    mesh.computeWorldMatrix(true);
    this.places.set(mesh, this.meshes.length);
    this.meshes.push(mesh);
  }

  remove(mesh: AbstractMesh): void {
    const place = this.places.get(mesh);
    if (place === undefined) return;
    const last = this.meshes.pop()!;
    this.places.delete(mesh);
    if (last === mesh) return;
    this.meshes[place] = last;
    this.places.set(last, place);
  }

  dispose(): void {
    this.meshes.length = 0;
    this.places.clear();
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
    for (let index = 0; index < meshes.length; index += 1) {
      const mesh = meshes[index]!;
      if (this.holds(mesh, planes)) result.push(mesh);
    }
    return result;
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
