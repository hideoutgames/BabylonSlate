import { BoundingInfo, Vector3, type AbstractMesh } from "@babylonjs/core";

const originals = new WeakMap<AbstractMesh, BoundingInfo>();

/** Expand culling bounds for vertex displacement, and restore on reassignment. */
export function applyMaterialBounds(mesh: AbstractMesh): void {
  const padding = Number(mesh.material?.metadata?.boundsPadding ?? 0);
  const original = originals.get(mesh);
  if (!(padding > 0) && !original) return;
  const base = original ?? mesh.getBoundingInfo();
  if (padding > 0) {
    originals.set(mesh, base);
    const extent = new Vector3(padding, padding, padding);
    mesh.setBoundingInfo(new BoundingInfo(base.boundingBox.minimum.subtract(extent), base.boundingBox.maximum.add(extent), mesh.getWorldMatrix()));
  } else {
    mesh.setBoundingInfo(base);
    originals.delete(mesh);
  }
}
