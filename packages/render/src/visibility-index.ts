import { BoundingBox } from "@babylonjs/core/Culling/boundingBox";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { BoundingSphere } from "@babylonjs/core/Culling/boundingSphere";
import type { Plane } from "@babylonjs/core/Maths/math.plane";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";

/**
 * The visibility index: each mesh's world bounds as one row of doubles, and Babylon's frustum test run on the rows.
 *
 * A view's cull asks `mesh.isInFrustum(planes)` of every mesh it may draw, which walks the mesh, its bounding info, the
 * sphere and the box and calls a method per plane and corner. A row holds the same numbers that walk reads (the
 * sphere's world centre and radius and the box's eight world corners), so `PlaneQuery.holds` answers with the same
 * arithmetic on the same doubles in the same order, and so with the same result, for any culling strategy.
 *
 * A row is current by construction, not by notice: every write of those numbers in Babylon 9.29 goes through
 * `BoundingSphere._update` or `BoundingBox._update` (their constructors, `reConstruct` and `scale` end in it, and
 * `BoundingInfo.update`, `reConstruct`, `centerOn`, `encapsulate` and `scale` only call those). Both are wrapped to
 * count their calls on the object, and a row is read again when either count, or the mesh's bounding info itself,
 * is not the one it was read at. Nothing in Haptic writes `centerWorld`, `radiusWorld` or `vectorsWorld` directly;
 * code that ever does must end with `_update` or the row will not follow.
 *
 * What stays with the mesh, read on every query as before: every flag a cull reads (enabled, visible, layer mask,
 * always-drawn, blocked, ready, zero scale), `getBoundingInfo()` itself (it rebuilds bounds marked dirty, and a
 * regular instance's master mesh answers for it), `cullingStrategy` and a `Mesh`'s delay-load state, refused or
 * checked exactly as `Mesh.isInFrustum` does. A mesh whose `isInFrustum` or whose bounding info's is not Babylon's
 * own is asked the old way.
 */

type Counted = { _hapticUpdates?: number };
type Row = {
  /** The sphere's and the box's update counts the row was read at. */
  sphere: number;
  box: number;
  /** Centre x, y, z, radius, then the eight corners' x, y, z. */
  values: Float64Array;
};
type Indexed = BoundingInfo & { _hapticRow?: Row };
type Method = (this: Counted, ...args: unknown[]) => unknown;

const ROW = 4 + 8 * 3;
let installed = false;

/** Pinned 9.29 adapter, installed once: counts each bounds object's world updates on the object. */
function install(): void {
  if (installed) return;
  installed = true;
  for (const prototype of [BoundingSphere.prototype, BoundingBox.prototype] as unknown as Array<{ _update: Method }>) {
    const update = prototype._update;
    prototype._update = function (this: Counted, ...args: unknown[]) {
      const result = update.apply(this, args);
      this._hapticUpdates = (this._hapticUpdates ?? 0) + 1;
      return result;
    };
  }
}

const abstractIsInFrustum = AbstractMesh.prototype.isInFrustum;
const meshIsInFrustum = Mesh.prototype.isInFrustum;
const infoIsInFrustum = BoundingInfo.prototype.isInFrustum;

/** Rows read or read again, and tests answered the old way, since the module loaded (`visibilityIndexCounts`). */
let rowReads = 0;
let deferred = 0;

function readRow(info: Indexed, sphereUpdates: number, boxUpdates: number): Row {
  const row = info._hapticRow ??= { sphere: 0, box: 0, values: new Float64Array(ROW) };
  const values = row.values;
  const sphere = info.boundingSphere;
  const centre = sphere.centerWorld;
  values[0] = centre.x; values[1] = centre.y; values[2] = centre.z; values[3] = sphere.radiusWorld;
  const corners = info.boundingBox.vectorsWorld;
  for (let corner = 0, at = 4; corner < 8; corner++, at += 3) {
    const point = corners[corner]!;
    values[at] = point.x; values[at + 1] = point.y; values[at + 2] = point.z;
  }
  row.sphere = sphereUpdates;
  row.box = boxUpdates;
  rowReads++;
  return row;
}

/** What `Mesh.isInFrustum` does once its bounds passed. */
function passed(mesh: Mesh): true {
  mesh._checkDelayState();
  return true;
}

/** One view's six frustum planes, as Babylon holds them and as doubles (normal x, y, z and d per plane). */
export class PlaneQuery {
  private planes: Plane[] = [];
  private readonly values = new Float64Array(24);

  constructor() {
    install();
  }

  /** Takes the planes a cull would hand `isInFrustum`; they are read now, so call it again after they change. */
  set(planes: Plane[]): this {
    this.planes = planes;
    const values = this.values;
    for (let plane = 0, at = 0; plane < 6; plane++, at += 4) {
      const source = planes[plane]!;
      values[at] = source.normal.x; values[at + 1] = source.normal.y; values[at + 2] = source.normal.z; values[at + 3] = source.d;
    }
    return this;
  }

  /** `mesh.isInFrustum(planes)`, for the planes last set. */
  holds(mesh: AbstractMesh): boolean {
    const own = mesh.isInFrustum;
    // `Mesh.isInFrustum` refuses a mesh that is loading and, on a pass, checks its delay state (which may start a
    // geometry's load): `passed` does that part for it.
    const loads = own === meshIsInFrustum;
    if (loads) {
      if ((mesh as Mesh).delayLoadState === 2) return false;
    } else if (own !== abstractIsInFrustum) return this.defer(mesh);
    const info = mesh.getBoundingInfo() as Indexed;
    if (info.isInFrustum !== infoIsInFrustum) return this.defer(mesh);
    const sphereUpdates = (info.boundingSphere as Counted)._hapticUpdates ?? 0;
    const boxUpdates = (info.boundingBox as Counted)._hapticUpdates ?? 0;
    let row = info._hapticRow;
    if (!row || row.sphere !== sphereUpdates || row.box !== boxUpdates) row = readRow(info, sphereUpdates, boxUpdates);
    const v = row.values, p = this.values;
    const cx = v[0]!, cy = v[1]!, cz = v[2]!;
    // As `BoundingInfo.isInFrustum`: the optimistic strategies (2 and 3) pass a centre inside every plane at once.
    const strategy = mesh.cullingStrategy;
    if (strategy === 2 || strategy === 3) {
      let inside = true;
      for (let at = 0; at < 24; at += 4) {
        if (p[at]! * cx + p[at + 1]! * cy + p[at + 2]! * cz + p[at + 3]! < 0) { inside = false; break; }
      }
      if (inside) return loads ? passed(mesh as Mesh) : true;
    }
    const reach = -v[3]!;
    for (let at = 0; at < 24; at += 4) {
      if (p[at]! * cx + p[at + 1]! * cy + p[at + 2]! * cz + p[at + 3]! <= reach) return false;
    }
    if (strategy === 1 || strategy === 3) return loads ? passed(mesh as Mesh) : true;
    for (let at = 0; at < 24; at += 4) {
      const nx = p[at]!, ny = p[at + 1]!, nz = p[at + 2]!, d = p[at + 3]!;
      let outside = true;
      for (let corner = 4; corner < ROW; corner += 3) {
        if (nx * v[corner]! + ny * v[corner + 1]! + nz * v[corner + 2]! + d >= 0) { outside = false; break; }
      }
      if (outside) return false;
    }
    return loads ? passed(mesh as Mesh) : true;
  }

  private defer(mesh: AbstractMesh): boolean {
    deferred++;
    return mesh.isInFrustum(this.planes);
  }
}

/** Rows read or read again and tests answered by the mesh's own `isInFrustum`, since the module loaded. */
export function visibilityIndexCounts(): { rowReads: number; deferred: number } {
  return { rowReads, deferred };
}
