import { Frustum, Vector3, type AbstractMesh, type Matrix, type Plane } from "@babylonjs/core";

type Bounds = { min: Vector3; max: Vector3 };
type Node = Bounds & { parent?: Node; left?: Node; right?: Node; mesh?: AbstractMesh };

/** Balanced caster hierarchy. Membership changes rebuild; moving bounds only refit ancestors. */
export class ShadowSpatialIndex {
  private readonly leaves = new Map<AbstractMesh, Node>();
  private readonly dirty = new Set<AbstractMesh>();
  private root?: Node;
  private rebuild = false;
  add(mesh: AbstractMesh): void {
    if (this.leaves.has(mesh)) return;
    mesh.computeWorldMatrix(true);
    const box = mesh.getBoundingInfo().boundingBox;
    this.leaves.set(mesh, { min: box.minimumWorld.clone(), max: box.maximumWorld.clone(), mesh });
    mesh.onAfterWorldMatrixUpdateObservable.add(() => this.dirty.add(mesh));
    this.rebuild = true;
  }
  remove(mesh: AbstractMesh): void { this.leaves.delete(mesh); this.dirty.delete(mesh); this.rebuild = true; }
  private union(node: Node): void {
    if (!node.left || !node.right) return;
    node.min.copyFrom(node.left.min).minimizeInPlace(node.right.min);
    node.max.copyFrom(node.left.max).maximizeInPlace(node.right.max);
  }
  private build(nodes: Node[], depth = 0): Node | undefined {
    if (!nodes.length) return undefined;
    if (nodes.length === 1) { nodes[0]!.parent = undefined; return nodes[0]; }
    const axis = (["x", "y", "z"] as const)[depth % 3]!;
    nodes.sort((a, b) => a.min[axis] + a.max[axis] - b.min[axis] - b.max[axis]);
    const middle = Math.floor(nodes.length / 2);
    const node: Node = { min: Vector3.Zero(), max: Vector3.Zero(), left: this.build(nodes.slice(0, middle), depth + 1), right: this.build(nodes.slice(middle), depth + 1) };
    node.left!.parent = node; node.right!.parent = node;
    this.union(node);
    return node;
  }
  private refit(): void {
    for (const mesh of this.dirty) {
      const node = this.leaves.get(mesh);
      if (!node) continue;
      const box = mesh.getBoundingInfo().boundingBox;
      node.min.copyFrom(box.minimumWorld); node.max.copyFrom(box.maximumWorld);
      for (let parent = node.parent; parent; parent = parent.parent) this.union(parent);
    }
    this.dirty.clear();
    if (this.rebuild) { this.root = this.build([...this.leaves.values()]); this.rebuild = false; }
  }
  query(transform: Matrix, preserveUpstream: boolean): AbstractMesh[] {
    this.refit();
    const planes = Frustum.GetPlanes(transform);
    // Directional depth clamping permits upstream casters outside the near plane.
    // Retain the side and far planes, so unrelated distant geometry is excluded.
    return this.queryPlanes(preserveUpstream ? planes.slice(1) : planes);
  }
  queryPlanes(planes: readonly Plane[]): AbstractMesh[] {
    this.refit();
    const result: AbstractMesh[] = [];
    const visit = (node?: Node) => {
      if (!node) return;
      for (const plane of planes) {
        const n = plane.normal;
        if (n.x * (n.x >= 0 ? node.max.x : node.min.x) + n.y * (n.y >= 0 ? node.max.y : node.min.y) + n.z * (n.z >= 0 ? node.max.z : node.min.z) + plane.d < 0) return;
      }
      if (node.mesh) {
        if (node.mesh.isEnabled() && node.mesh.isVisible && !node.mesh.isDisposed()) result.push(node.mesh);
      } else { visit(node.left); visit(node.right); }
    };
    visit(this.root);
    return result;
  }
}
