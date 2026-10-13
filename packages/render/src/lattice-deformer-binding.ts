import type { AbstractMesh, Effect, Material, Node, UniformBuffer } from "@babylonjs/core";

/** Leaf shared by the compiler, native adapters, and scene cage owners. */
export interface LatticeBinding {
  readonly active: boolean;
  bindEffect(effect: Effect): void;
  bindBuffer(buffer: UniformBuffer): void;
}
/** One entry per marked node keeps the parent walk to a single lookup per level. */
interface LatticeMark { root: boolean; binding?: LatticeBinding }
const marks = new WeakMap<Node, LatticeMark>();
/** Nodes holding a binding. While zero no mesh can resolve one, so the per-draw parent walk is skipped. */
let liveBindings = 0;
export function markLatticeComponentRoot(root: AbstractMesh): void {
  const mark = marks.get(root);
  if (mark) mark.root = true; else marks.set(root, { root: true });
}
export function isLatticeComponentRoot(node: Node): boolean { return marks.get(node)?.root === true; }
export function setLatticeBinding(root: AbstractMesh, binding?: LatticeBinding): void {
  const mark = marks.get(root);
  const bound = mark?.binding !== undefined;
  if (binding) {
    if (mark) mark.binding = binding; else marks.set(root, { root: false, binding });
    if (!bound) liveBindings++;
  } else if (bound) {
    mark!.binding = undefined;
    liveBindings--;
  }
}
export function meshLatticeBinding(mesh?: AbstractMesh): LatticeBinding | undefined {
  if (liveBindings === 0) return undefined;
  // Babylon LOD meshes borrow their master's world matrix even when parentless.
  const master = mesh?._masterMesh;
  for (let node: Node | null | undefined = master ?? mesh; node; node = node.parent) {
    const mark = marks.get(node);
    if (!mark) continue;
    if (mark.binding) return mark.binding;
    if (mark.root) return undefined;
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
