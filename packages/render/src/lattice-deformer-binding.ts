import type { AbstractMesh, Effect, Material, Node, UniformBuffer } from "@babylonjs/core";

/** Leaf shared by the compiler, native adapters, and scene cage owners. */
export interface LatticeBinding {
  readonly active: boolean;
  bindEffect(effect: Effect): void;
  bindBuffer(buffer: UniformBuffer): void;
}
const roots = new WeakSet<Node>();
const bindings = new WeakMap<Node, LatticeBinding>();
export function markLatticeComponentRoot(root: AbstractMesh): void { roots.add(root); }
export function isLatticeComponentRoot(node: Node): boolean { return roots.has(node); }
export function setLatticeBinding(root: AbstractMesh, binding?: LatticeBinding): void {
  if (binding) bindings.set(root, binding); else bindings.delete(root);
}
export function meshLatticeBinding(mesh?: AbstractMesh): LatticeBinding | undefined {
  // Babylon LOD meshes borrow their master's world matrix even when parentless.
  const master = mesh?._masterMesh;
  for (let node: Node | null | undefined = master ?? mesh; node; node = node.parent) {
    const binding = bindings.get(node);
    if (binding) return binding;
    if (roots.has(node)) return undefined;
  }
  return undefined;
}
export function hasMeshLatticeDeformer(mesh?: AbstractMesh): boolean { return meshLatticeBinding(mesh)?.active === true; }
export function bindMeshLatticeDeformer(effect: Effect, mesh?: AbstractMesh): void {
  const binding = meshLatticeBinding(mesh);
  effect.setFloat("slateLatticeEnabled", binding?.active ? 1 : 0);
  if (binding?.active) binding.bindEffect(effect);
}
export function bindMeshLatticeDeformerBuffer(buffer: UniformBuffer, mesh?: AbstractMesh): void {
  const binding = meshLatticeBinding(mesh);
  buffer.updateFloat("slateLatticeEnabled", binding?.active ? 1 : 0);
  if (binding?.active) binding.bindBuffer(buffer);
}
let authoredShadowAdapter: ((material: Material) => boolean) | undefined;
let authoredShadowRelease: ((material: Material) => void) | undefined;
export function registerLatticeShadowAdapter(adapter: (material: Material) => boolean, release?: (material: Material) => void): void { authoredShadowAdapter = adapter; authoredShadowRelease = release; }
export function ensureLatticeShadowAdapter(material: Material): boolean { return authoredShadowAdapter?.(material) ?? false; }
export function releaseLatticeShadowAdapter(material: Material): void { authoredShadowRelease?.(material); }
