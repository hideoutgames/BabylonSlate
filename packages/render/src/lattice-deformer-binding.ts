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
/** Bound owners, active or not: a zero-strength or identity cage stays bound. While zero no mesh can resolve a binding, so the per-draw parent walk is skipped. */
let liveBindings = 0;
/** Bumps whenever a mark is added or changed, so a cached ownership proof can tell the walk's stopping points moved. */
let marksRevision = 0;
export function latticeMarksRevision(): number { return marksRevision; }
export function markLatticeComponentRoot(root: AbstractMesh): void {
  const mark = marks.get(root);
  if (mark) { if (!mark.root) { mark.root = true; marksRevision++; } }
  else { marks.set(root, { root: true }); marksRevision++; }
}
export function isLatticeComponentRoot(node: Node): boolean { return marks.get(node)?.root === true; }
export function setLatticeBinding(root: AbstractMesh, binding?: LatticeBinding): void {
  const mark = marks.get(root);
  const bound = mark?.binding !== undefined;
  if (binding) {
    if (mark) { if (mark.binding !== binding) { mark.binding = binding; marksRevision++; } }
    else { marks.set(root, { root: false, binding }); marksRevision++; }
    if (!bound) liveBindings++;
  } else if (bound) {
    mark!.binding = undefined;
    liveBindings--;
    marksRevision++;
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
