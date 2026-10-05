import { BoundingInfo, Vector3, type AbstractMesh } from "@babylonjs/core";

const originals = new WeakMap<AbstractMesh, BoundingInfo>();
type DynamicBounds = {
  bounds: BoundingInfo;
  minimum: Vector3;
  maximum: Vector3;
  paddedMinimum: Vector3;
  paddedMaximum: Vector3;
};
const dynamicBounds = new WeakMap<AbstractMesh, DynamicBounds>();
const expansions = new WeakMap<AbstractMesh, { cage: BoundingInfo; result: BoundingInfo; minimum: Vector3; maximum: Vector3 }>();

/** A visual modifier contributes conservative local bounds without changing
 * the geometry/material padding source, including dynamic runtime meshes. */
export function setMaterialBoundsExpansion(mesh: AbstractMesh, bounds: BoundingInfo | null): void {
  if (bounds) {
    let state = expansions.get(mesh);
    if (!state) {
      if (!originals.has(mesh)) originals.set(mesh, mesh.getBoundingInfo());
      state = { cage: bounds, result: new BoundingInfo(bounds.boundingBox.minimum, bounds.boundingBox.maximum), minimum: new Vector3(), maximum: new Vector3() };
      expansions.set(mesh, state);
    }
    state.cage = bounds;
  } else expansions.delete(mesh);
  applyMaterialBounds(mesh);
}

/** Stable unexpanded bounds for fitting cages; never fit last frame's result. */
export function materialBaseBounds(mesh: AbstractMesh): { minimum: Vector3; maximum: Vector3 } {
  const dynamic = dynamicBounds.get(mesh);
  if (dynamic) return dynamic;
  return (originals.get(mesh) ?? mesh.getBoundingInfo()).boundingBox;
}

function applyExpansion(mesh: AbstractMesh, base: BoundingInfo): void {
  const expansion = expansions.get(mesh);
  if (!expansion) return;
  expansion.minimum.copyFrom(base.boundingBox.minimum).minimizeInPlace(expansion.cage.boundingBox.minimum);
  expansion.maximum.copyFrom(base.boundingBox.maximum).maximizeInPlace(expansion.cage.boundingBox.maximum);
  expansion.result.reConstruct(expansion.minimum, expansion.maximum, mesh.getWorldMatrix());
  mesh.setBoundingInfo(expansion.result);
}

/** Owned deforming geometry retains bounds and padding scratch across updates. */
export function updateDynamicMaterialBounds(mesh: AbstractMesh, minimum: Vector3, maximum: Vector3): void {
  let state = dynamicBounds.get(mesh);
  if (!state) {
    state = { bounds: mesh.getBoundingInfo(), minimum: new Vector3(), maximum: new Vector3(), paddedMinimum: new Vector3(), paddedMaximum: new Vector3() };
    dynamicBounds.set(mesh, state);
  }
  state.minimum.copyFrom(minimum);
  state.maximum.copyFrom(maximum);
  applyDynamicBounds(mesh, state);
}

function applyDynamicBounds(mesh: AbstractMesh, state: DynamicBounds): void {
  const authoredPadding = Number(mesh.material?.metadata?.boundsPadding ?? 0);
  const padding = Number.isFinite(authoredPadding) ? Math.max(0, authoredPadding) : 0;
  state.paddedMinimum.copyFromFloats(state.minimum.x - padding, state.minimum.y - padding, state.minimum.z - padding);
  state.paddedMaximum.copyFromFloats(state.maximum.x + padding, state.maximum.y + padding, state.maximum.z + padding);
  state.bounds.reConstruct(state.paddedMinimum, state.paddedMaximum, mesh.getWorldMatrix());
  if (mesh.getBoundingInfo() !== state.bounds) mesh.setBoundingInfo(state.bounds);
  applyExpansion(mesh, state.bounds);
}

/** Expand culling bounds for vertex displacement, and restore on reassignment. */
export function applyMaterialBounds(mesh: AbstractMesh, geometryChanged = false): void {
  const dynamic = dynamicBounds.get(mesh);
  if (dynamic) { applyDynamicBounds(mesh, dynamic); return; }
  if (geometryChanged) originals.delete(mesh);
  const padding = Number(mesh.material?.metadata?.boundsPadding ?? 0);
  const original = originals.get(mesh);
  if (!(padding > 0) && !original) { applyExpansion(mesh, mesh.getBoundingInfo()); return; }
  const base = original ?? mesh.getBoundingInfo();
  if (padding > 0) {
    originals.set(mesh, base);
    const extent = new Vector3(padding, padding, padding);
    mesh.setBoundingInfo(new BoundingInfo(base.boundingBox.minimum.subtract(extent), base.boundingBox.maximum.add(extent), mesh.getWorldMatrix()));
  } else {
    mesh.setBoundingInfo(base);
    // World updates went to the padded info; refresh even when the world matrix is frozen.
    base.update(mesh.getWorldMatrix());
    if (!expansions.has(mesh)) originals.delete(mesh);
  }
  applyExpansion(mesh, mesh.getBoundingInfo());
}
